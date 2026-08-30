import type express from 'express';

import { appConfig } from '../config/env.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const PUBLIC_DEMO_DISABLED_MESSAGE = 'Disabled in public demo.';

export function blockPublicDemoMutations(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction
): void {
  const isCosGalleryRatingUpdate =
    appConfig.cosGalleryMode &&
    request.method.toUpperCase() === 'PATCH' &&
    /^\/api\/cos-gallery\/creators\/\d+\/content-rating$/.test(request.originalUrl.split('?')[0] ?? '');

  if (isCosGalleryRatingUpdate) {
    next();
    return;
  }

  if (!appConfig.publicDemoMode || !MUTATING_METHODS.has(request.method.toUpperCase())) {
    next();
    return;
  }

  response.status(403).json({ message: PUBLIC_DEMO_DISABLED_MESSAGE });
}
