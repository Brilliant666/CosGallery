import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import { ArchiveMetadataTaskError } from './services/archive-metadata-task-service.js';

import { appConfig, repositoryRoot } from './config/env.js';
import { requireApiAuthentication, requireMediaAuthentication } from './middleware/auth-protection.js';
import { requireTrustedMutationRequest } from './middleware/csrf-protection.js';
import { blockPublicDemoMutations } from './middleware/public-demo-mode.js';
import { createTextCompression, mountClientDelivery } from './middleware/text-delivery.js';
import { denyRecoveryFileRequests } from './middleware/protected-recovery-files.js';
import { apiRouter } from './routes/api.js';
import { archiveBridgeRouter } from './routes/archive-bridge.js';
import { authService } from './services/auth-service.js';
import { lazyThumbnailsRouter, lazyPreviewsRouter } from './routes/lazy-derivatives.js';
import { securityHeaders } from './middleware/security-headers.js';
import { createHttpErrorHandler, requestIdentity } from './middleware/http-errors.js';

export function applyApiNoStoreHeaders(response: Pick<express.Response, 'setHeader'>) {
  authService.setNoStoreHeaders(response as express.Response);
  if (authService.isEnabled()) {
    response.setHeader('Vary', 'Cookie');
  }
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  const clientDist = path.join(repositoryRoot, 'client', 'dist');
  const clientHtml = path.join(clientDist, 'index.html');
  app.use(requestIdentity);
  app.use(securityHeaders(fs.existsSync(clientHtml) ? fs.readFileSync(clientHtml, 'utf8') : '', appConfig.nodeEnv === 'development'));
  app.use(denyRecoveryFileRequests());
  app.use(createTextCompression());

  // Only bounded source-evidence text needs more than the default JSON limit.
  // The service separately caps raw text, lines, URLs and diagnostics; no uploads.
  app.use('/api/admin/archive-catalog/source-evidence', express.json({ limit: '1mb' }));
  // Bounded selection/confirmation payloads only; files and manifests are never uploaded.
  app.use('/api/admin/local-admission', express.json({ limit: '1mb' }));
  app.use('/api/admin/local-review', express.json({ limit: '1mb' }));
  app.use('/api/archive-bridge/metadata-tasks/:id/source-evidence', express.json({ limit: '1mb' }));
  app.use(express.json());

  // Disk provenance is checked in every mode, including eager/background output.
  app.use('/thumbnails', requireMediaAuthentication, lazyThumbnailsRouter);
  app.use('/previews', requireMediaAuthentication, lazyPreviewsRouter);

  app.use('/api', (_request, response, next) => {
    applyApiNoStoreHeaders(response);
    next();
  });
  app.use('/api/archive-bridge', archiveBridgeRouter);
  app.use('/api', blockPublicDemoMutations, requireTrustedMutationRequest, requireApiAuthentication, apiRouter);

  if (appConfig.nodeEnv === 'production') {
    if (fs.existsSync(clientDist)) {
      mountClientDelivery(app, clientDist);
    }
  }

  app.use(createHttpErrorHandler(error => error instanceof ArchiveMetadataTaskError
    ? { status: error.status, code: 'ARCHIVE_METADATA_TASK_REJECTED', message: error.message } : null));

  return app;
}
