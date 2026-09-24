import path from 'node:path';
import { constants } from 'node:zlib';

import compression from 'compression';
import express from 'express';

// Only complete, sized textual responses participate. In particular SSE and
// unknown-length streams must retain their original flushing behavior.
export function shouldCompressText(request: express.Request, response: express.Response): boolean {
  if (request.headers.range || response.statusCode === 206 || response.hasHeader('Content-Range')) return false;
  if (/^\/(?:thumbnails|previews)(?:\/|$)|^\/api\/originals(?:\/|$)/i.test(request.originalUrl)) return false;
  if (response.hasHeader('Content-Encoding') || !response.hasHeader('Content-Length')) return false;
  const contentType = String(response.getHeader('Content-Type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!/^(?:application\/(?:json|[\w.-]+\+json|javascript|xml)|text\/(?:html|plain|css|javascript|csv|xml))$/.test(contentType)) return false;
  return compression.filter(request, response);
}

export function createTextCompression() {
  return compression({
    threshold: 1024,
    level: 4,
    brotli: { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } },
    filter: shouldCompressText
  });
}

export function mountClientDelivery(app: express.Application, clientDist: string) {
  app.use(express.static(clientDist, {
    setHeaders(response, filePath) {
      const relativePath = path.relative(clientDist, filePath).split(path.sep).join('/');
      // Vite content-addressed assets only. Public files, HTML and the service
      // worker revalidate so an open installation can discover a new build.
      const hashedAsset = /^assets\/.+-[\w-]{8,}\.(?:js|css|woff2?|ttf|otf|svg|png|jpe?g|webp|avif|gif|ico)$/i.test(relativePath);
      response.setHeader('Cache-Control', hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
  }));
  // A stale lazy-chunk URL must be a real, non-cacheable 404, never index.html.
  app.use('/assets', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.status(404).end();
  });
  app.get(/^(?!\/api|\/thumbnails|\/previews).*/, (request, response, next) => {
    // Public root assets are not SPA routes. Nested route parameters can
    // legitimately contain dots (for example a legacy folder slug).
    if (/^\/[^/]+\.(?:js|css|json|webmanifest|ico|png|jpe?g|svg|webp|woff2?)$/i.test(request.path)) {
      response.setHeader('Cache-Control', 'no-store');
      response.status(404).end();
      return;
    }
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile(path.join(clientDist, 'index.html'), (error) => { if (error) next(error); });
  });
}
