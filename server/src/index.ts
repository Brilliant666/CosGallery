/*
    Foldergram - Local-only photo and video gallery
    Copyright (C) 2026 Sajjad Ali

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published
    by the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { createServer } from "node:http";

import { appConfig } from "./config/env.js";
import { createApp } from "./app.js";
import { collectionRepository } from "./db/repositories.js";
import { log } from "./services/log-service.js";
import { localIngestService } from "./services/local-ingest-service.js";
import { localIngestSettingsService } from "./services/local-ingest-settings-service.js";
import { runLocalIngestStartup } from "./services/local-ingest-startup.js";
import { permanentDeletionService } from "./services/permanent-deletion-service.js";
import { scannerService } from "./services/scanner-service.js";
import { watcherService } from "./services/watcher-service.js";
import { startResourceCatalogUpdater, stopResourceCatalogUpdater } from "./services/resource-catalog-updater.js";
import { startAutomaticRecoveryPoints, stopAutomaticRecoveryPoints } from "./services/application-recovery-service.js";

function logServerReady(): void {
  if (!appConfig.isDevelopment) {
    log.info(`HTTP server listening on http://${appConfig.host}:${appConfig.port}`);
    return;
  }

  const firstClientPort = appConfig.devClientPorts[0] ?? appConfig.devClientPort;
  const lastClientPort = appConfig.devClientPorts.at(-1) ?? appConfig.devClientPort;
  const clientPortRange =
    firstClientPort === lastClientPort ? String(firstClientPort) : `${firstClientPort}-${lastClientPort}`;

  log.table(
    "Development server ready",
    [
      ["API", `http://localhost:${appConfig.port}`],
      ["Health", `http://localhost:${appConfig.port}/api/health`],
      ["Client ports", clientPortRange]
    ],
    "success"
  );
}

function startCatalogUpdates(): void {
  try {
    startResourceCatalogUpdater();
  } catch (error: unknown) {
    // A derived-data worker must not crash the HTTP listening callback or turn
    // local startup's handled rejection into an unhandled promise rejection.
    log.error("Resource catalog updater could not start; pending generations retained", error);
  }
}

async function bootstrap(): Promise<void> {
  await permanentDeletionService.recoverPendingDeletions();
  const app = createApp();
  const server = createServer(app);
  const portVariableName = appConfig.nodeEnv === "production" ? "SERVER_PORT" : "DEV_SERVER_PORT";
  collectionRepository.ensureDefaultCollection();
  const repairedCollectionMemberships = collectionRepository.repairDefaultMemberships();
  if (repairedCollectionMemberships > 0) {
    log.info(`Repaired ${repairedCollectionMemberships} saved collection memberships`);
  }

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      log.error(
        `Port ${appConfig.port} is already in use`,
        `Another server is already listening on that port. Stop it first or change ${portVariableName} for this runtime.`,
      );
    } else {
      log.error("HTTP server failed to start", error.message);
    }

    process.exitCode = 1;
  });

  // This includes synchronous settings writes even when scanning is disabled.
  // Finish before starting the independent catalog writer or announcing ready;
  // failures must reach bootstrap's error handler, not escape an event callback.
  const startupAction = scannerService.handleStartup("startup");

  server.listen(appConfig.port, appConfig.host, () => {
    logServerReady();
    startAutomaticRecoveryPoints();
    if (startupAction === "blocked") {
      log.info("Gallery watcher deferred until the library rebuild completes");
      startCatalogUpdates();
      return;
    }

    if (startupAction === "idle" && appConfig.isDevelopment) {
      log.info(
        "Gallery watcher idle until a user-triggered scan or rebuild starts it",
      );
    }

    void runLocalIngestStartup({
      scanEnabled: appConfig.localIngestStartupScan,
      recoverInterruptedJobs: () => localIngestService.recoverInterruptedJobs(),
      getAllowlist: () => localIngestSettingsService.get().allowlist,
      scanInbox: () => localIngestService.scanInbox(),
      logInfo: (message) => log.info(message)
    }).catch((error: unknown) => {
      log.info("Local ingest startup recovery or compensation scan could not complete", error instanceof Error ? error.message : String(error));
    }).finally(() => {
      // Preserve local recovery's existing failure behavior while keeping its
      // startup writes ahead of catalog publication. HTTP need not await scans.
      startCatalogUpdates();
    });
  });

  async function shutdown(signal: string): Promise<void> {
    log.info(`Received ${signal}, shutting down`);
    const httpClosed = new Promise<void>(resolve => server.close(() => resolve()));
    await stopAutomaticRecoveryPoints();
    await stopResourceCatalogUpdater();
    await watcherService.stop();
    await httpClosed;
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void bootstrap().catch((error: unknown) => {
  log.error("Server startup failed", error);
  process.exitCode = 1;
});
