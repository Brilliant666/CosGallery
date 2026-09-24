import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import { ArchiveMetadataTaskError } from './services/archive-metadata-task-service.js';

import { appConfig, repositoryRoot } from './config/env.js';
import { requireApiAuthentication, requireMediaAuthentication } from './middleware/auth-protection.js';
import { requireTrustedMutationRequest } from './middleware/csrf-protection.js';
import { blockPublicDemoMutations } from './middleware/public-demo-mode.js';
import { createTextCompression, mountClientDelivery } from './middleware/text-delivery.js';
import { apiRouter } from './routes/api.js';
import { archiveBridgeRouter } from './routes/archive-bridge.js';
import { authService } from './services/auth-service.js';
import { lazyThumbnailsRouter, lazyPreviewsRouter } from './routes/lazy-derivatives.js';
import { createProtectedStaticOptions } from './utils/media-response.js';

export function applyApiNoStoreHeaders(response: Pick<express.Response, 'setHeader'>) {
  authService.setNoStoreHeaders(response as express.Response);
  if (authService.isEnabled()) {
    response.setHeader('Vary', 'Cookie');
  }
}

export function createApp() {
  const app = express();
  app.use(createTextCompression());

  // Only bounded source-evidence text needs more than the default JSON limit.
  // The service separately caps raw text, lines, URLs and diagnostics; no uploads.
  app.use('/api/admin/archive-catalog/source-evidence', express.json({ limit: '1mb' }));
  // Bounded selection/confirmation payloads only; files and manifests are never uploaded.
  app.use('/api/admin/local-admission', express.json({ limit: '1mb' }));
  app.use('/api/admin/local-review', express.json({ limit: '1mb' }));
  app.use('/api/archive-bridge/metadata-tasks/:id/source-evidence', express.json({ limit: '1mb' }));
  app.use(express.json());

  if (appConfig.derivativeMode === 'lazy') {
    app.use('/thumbnails', requireMediaAuthentication, lazyThumbnailsRouter);
    app.use('/previews', requireMediaAuthentication, lazyPreviewsRouter);
  } else {
    app.use('/thumbnails', requireMediaAuthentication, express.static(appConfig.thumbnailsDir, createProtectedStaticOptions()));
    app.use('/previews', requireMediaAuthentication, express.static(appConfig.previewsDir, createProtectedStaticOptions()));
  }

  app.use('/api', (_request, response, next) => {
    applyApiNoStoreHeaders(response);
    next();
  });
  app.use('/api/archive-bridge', archiveBridgeRouter);
  app.use('/api', blockPublicDemoMutations, requireTrustedMutationRequest, requireApiAuthentication, apiRouter);

  if (appConfig.nodeEnv === 'production') {
    const clientDist = path.join(repositoryRoot, 'client', 'dist');
    if (fs.existsSync(clientDist)) {
      mountClientDelivery(app, clientDist);
    }
  }

  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const message = error instanceof Error ? error.message : 'Unexpected server error';
    response.status(error instanceof ArchiveMetadataTaskError ? error.status : 400).json({ message });
  });

  return app;
}
