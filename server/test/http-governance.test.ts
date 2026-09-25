import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentSecurityPolicy, securityHeaders } from '../src/middleware/security-headers.js';
import { createHttpErrorHandler, publicErrorText, requestIdentity } from '../src/middleware/http-errors.js';
import { requestTestApp } from './http-test-utils.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function appWithFailure(error: unknown) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestIdentity, securityHeaders());
  app.get('/failure', () => { throw error; });
  app.use(createHttpErrorHandler());
  return app;
}

describe('HTTP error boundary', () => {
  it('scrubs paths and secret assignments from existing business error descriptions', () => {
    expect(publicErrorText('Failed at C:\\private\\db.sqlite')).toBe('Failed at [local path]');
    expect(publicErrorText('Failed at /tmp/private.sqlite')).toBe('Failed at [local path]');
    expect(publicErrorText('password=sample token:sample Cookie=sample')).not.toContain('sample');
  });
  it('does not serialize unknown errors or log secrets and provides a correlated id', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await requestTestApp(appWithFailure(new Error('C:\\private\\db.sqlite password=secret Cookie=secret token=secret')), 'GET', '/failure?password=secret', { Cookie: 'secret', 'X-Request-Id': 'untrusted-secret' });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ code: 'INTERNAL_ERROR', message: 'Unexpected server error.', requestId: expect.any(String) });
    expect(response.body.requestId).toBe(response.headers.get('x-request-id'));
    const logged = JSON.stringify(logger.mock.calls);
    expect(logged).toContain(response.body.requestId);
    expect(logged).not.toMatch(/secret|private|db\.sqlite/);
    expect(response.headers.get('x-powered-by')).toBeNull();
  });

  it('returns a safe 400 for validation errors, without echoing supplied values', async () => {
    const parsed = z.enum(['safe']).safeParse('private-secret');
    const response = await requestTestApp(appWithFailure(parsed.error), 'GET', '/failure');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_REQUEST');
    expect(JSON.stringify(response.body)).not.toContain('private-secret');
  });

  it.each([401, 403, 404, 409, 410, 416, 429, 503])('preserves transport status %s without leaking diagnostic text', async status => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await requestTestApp(appWithFailure(Object.assign(new Error('/private/media secret'), { status })), 'GET', '/failure');
    expect(response.status).toBe(status);
    expect(response.body.code).toBeTruthy();
    expect(JSON.stringify(response.body)).not.toContain('private');
  });

  it('retains explicitly classified business code and message', async () => {
    const app = express();
    app.get('/', () => { throw new Error('known'); });
    app.use(createHttpErrorHandler(() => ({ status: 409, code: 'REVISION_CHANGED', message: 'Refresh the catalog.' })));
    const response = await requestTestApp(app, 'GET', '/');
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ code: 'REVISION_CHANGED', message: 'Refresh the catalog.' });
  });

  it('retains known 503 code while hiding underlying availability diagnostics', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = express();
    app.get('/', () => { throw new Error('C:\\private\\store unavailable'); });
    app.use(createHttpErrorHandler(() => ({ status: 503, code: 'CATALOG_NOT_READY', message: 'C:\\private\\store unavailable' })));
    const response = await requestTestApp(app, 'GET', '/');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ code: 'CATALOG_NOT_READY', message: 'Service is temporarily unavailable.' });
  });

  it('does not mistake missing internal configuration for a missing HTTP resource', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await requestTestApp(appWithFailure(Object.assign(new Error('missing private configuration'), { code: 'ENOENT' })), 'GET', '/failure');
    expect(response.status).toBe(500);
    expect(response.body.code).toBe('INTERNAL_ERROR');
  });

  it.each([['entity.parse.failed', 400], ['entity.too.large', 413], ['encoding.unsupported', 415]] as const)('classifies body parser %s', async (type, status) => {
    const response = await requestTestApp(appWithFailure(Object.assign(new Error('body contains secret'), { type })), 'GET', '/failure');
    expect(response.status).toBe(status);
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('does not send twice or delegate a raw stack after headers are sent', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = { headersSent: true, locals: { requestId: 'id' }, destroy: vi.fn(), status: vi.fn() };
    const next = vi.fn();
    createHttpErrorHandler()(new Error('secret'), {} as never, response as never, next);
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('does not write after a client abort', () => {
    const response = { status: vi.fn() };
    createHttpErrorHandler()(new Error('aborted'), { aborted: true } as never, response as never, vi.fn());
    expect(response.status).not.toHaveBeenCalled();
  });
});

describe('enforced security headers', () => {
  it('hashes delivered inline scripts with HTML newline normalization; keeps Inter, blobs, and local HTTP', async () => {
    const html = await fs.readFile(path.resolve('..', 'client', 'index.html'), 'utf8');
    const policy = contentSecurityPolicy(html);
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]![1]!;
    expect(policy).toContain(`'sha256-${createHash('sha256').update(script.replace(/\r\n?/g, '\n')).digest('base64')}'`);
    expect(policy).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(policy).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(policy).toContain("media-src 'self' blob:");
    expect(policy).not.toMatch(/upgrade-insecure|unsafe-eval|script-src[^;]*unsafe-inline/);
    expect(contentSecurityPolicy('', true)).toContain("connect-src 'self' ws: wss:");
  });

  it.each(['/page', '/api/value', '/media'])('applies the same enforced policy to %s without changing Range', async endpoint => {
    const app = express();
    app.use(securityHeaders());
    app.get('/page', (_req, res) => { res.type('html').send('<html></html>'); });
    app.get('/api/value', (_req, res) => { res.json({ ok: true }); });
    app.get('/media', (_req, res) => { res.status(206).set('Content-Range', 'bytes 0-1/3').send('ab'); });
    const response = await requestTestApp(app, 'GET', endpoint, { Range: 'bytes=0-1' });
    expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
    expect(response.headers.get('content-security-policy-report-only')).toBeNull();
    expect(response.headers.get('strict-transport-security')).toBeNull();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    if (endpoint === '/media') expect(response.headers.get('content-range')).toBe('bytes 0-1/3');
  });

  it('public health reports storage unavailability without its filesystem reason', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'http-health-'));
    vi.stubEnv('NODE_ENV', 'test');
    for (const [key, directory] of [['DATA_ROOT', 'data'], ['DB_DIR', 'db'], ['GALLERY_ROOT', 'gallery'], ['THUMBNAILS_DIR', 'thumbs'], ['PREVIEWS_DIR', 'previews']]) vi.stubEnv(key!, path.join(root, directory!));
    vi.resetModules();
    try {
      const { storageService } = await import('../src/services/storage-service.js');
      vi.spyOn(storageService, 'getState').mockReturnValue({ libraryAvailable: false, usingInMemoryDatabase: false, reason: 'C:\\private\\storage secret', databasePath: 'C:\\private\\gallery.sqlite' });
      const { createApp } = await import('../src/app.js');
      const response = await requestTestApp(createApp(), 'GET', '/api/health');
      expect(response.status).toBe(200);
      expect(response.body.storage).toEqual({ available: false, reason: 'Configured library storage is unavailable.', usingInMemoryDatabase: false });
      expect(JSON.stringify(response.body)).not.toMatch(/private|secret|sqlite/);
      const { databaseManager } = await import('../src/db/database.js');
      databaseManager.close();
    } finally { vi.resetModules(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
