import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTextCompression, mountClientDelivery } from '../src/middleware/text-delivery.js';

const text = JSON.stringify({ mediaItems: Array.from({ length: 200 }, (_, id) => ({ id, title: `图集 ${id}`, url: `/thumbnails/${id}.webp` })) });

describe('bounded text HTTP delivery', () => {
  let root: string;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cosgallery-delivery-'));
    await fs.mkdir(path.join(root, 'assets'));
    await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>current entry</title>');
    await fs.writeFile(path.join(root, 'assets', 'index-abcdefgh.js'), `export default ${text};`);
    await fs.writeFile(path.join(root, 'assets', 'index-abcdefgh.css'), '.sample{color:red}\n'.repeat(200));
    await fs.writeFile(path.join(root, 'sw.js'), '// service worker');
    const app = express();
    app.use(createTextCompression());
    app.get('/api/text', (_request, response) => {
      response.setHeader('Vary', 'Cookie, Origin');
      response.setHeader('Cache-Control', 'private, no-store');
      response.type('json').send(text);
    });
    app.get('/api/small', (_request, response) => response.json({ ok: true }));
    app.get('/api/no-transform', (_request, response) => response.set('Cache-Control', 'no-transform').type('json').send(text));
    app.get('/api/already-encoded', (_request, response) => response.set('Content-Encoding', 'gzip').type('json').send(text));
    app.get('/api/partial', (_request, response) => response.status(206).set('Content-Range', 'bytes 0-99/200').type('json').send(text));
    app.get('/api/events', (_request, response) => { response.type('text/event-stream'); response.write('data: ' + text); response.end(); });
    app.get('/api/stream', (_request, response) => { response.type('json'); response.write(text); response.end(); });
    app.get(['/api/originals/1', '/thumbnails/1.svg', '/previews/1.svg'], (_request, response) => response.type('text/plain').send(text));
    app.get('/api/video', (_request, response) => response.type('video/mp4').send(text));
    mountClientDelivery(app, root);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  function request(url: string, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: url, headers }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
  }

  it.each(['gzip', 'br', 'deflate'])('negotiates %s without changing JSON, privacy or existing Vary', async encoding => {
    const result = await request('/api/text', { 'Accept-Encoding': encoding });
    expect(result.headers['content-encoding']).toBe(encoding);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.headers.vary?.split(/,\s*/).sort()).toEqual(['Accept-Encoding', 'Cookie', 'Origin']);
    const decoded = encoding === 'br' ? brotliDecompressSync(result.body) : encoding === 'gzip' ? gunzipSync(result.body) : inflateSync(result.body);
    expect(decoded.toString()).toBe(text);
    expect(JSON.parse(decoded.toString()).mediaItems).toHaveLength(200);
    expect(result.body.length).toBeLessThan(Buffer.byteLength(text));
  });

  it.each([{}, { 'Accept-Encoding': 'identity' }, { 'Accept-Encoding': 'gzip;q=0, br;q=0, deflate;q=0' }])('retains identity for clients without accepted compression: %j', async headers => {
    const result = await request('/api/text', headers);
    expect(result.headers['content-encoding']).toBeUndefined();
    expect(result.body.toString()).toBe(text);
    expect(result.headers.vary).toContain('Accept-Encoding');
  });

  it.each(['/api/small', '/api/no-transform', '/api/partial', '/api/events', '/api/stream', '/api/originals/1', '/thumbnails/1.svg', '/previews/1.svg', '/api/video'])('does not transform %s', async url => {
    const result = await request(url, { 'Accept-Encoding': 'gzip, br' });
    expect(result.headers['content-encoding']).toBeUndefined();
  });

  it('preserves existing encoding and range requests', async () => {
    const encoded = await request('/api/already-encoded', { 'Accept-Encoding': 'br' });
    expect(encoded.headers['content-encoding']).toBe('gzip');
    expect(encoded.body.toString()).toBe(text);
    const range = await request('/assets/index-abcdefgh.js', { Range: 'bytes=0-15', 'Accept-Encoding': 'gzip' });
    expect(range.status).toBe(206);
    expect(range.headers['content-encoding']).toBeUndefined();
    expect(range.body.length).toBe(16);
  });

  it.each(['js', 'css'])('compresses content-hash %s assets and gives them immutable caching', async extension => {
    const result = await request(`/assets/index-abcdefgh.${extension}`, { 'Accept-Encoding': 'gzip' });
    expect(result.status).toBe(200);
    expect(result.headers['content-encoding']).toBe('gzip');
    expect(result.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it.each(['/', '/index.html', '/creator-admission/local?collection=one', '/sw.js'])('revalidates the entry/public resource %s', async url => {
    const result = await request(url);
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-cache');
  });

  it.each(['/assets/retired-abcdefgh.js', '/assets/nonexistent', '/missing.js'])('returns non-cacheable 404 for missing asset %s', async url => {
    const result = await request(url);
    expect(result.status).toBe(404);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.toString()).not.toContain('current entry');
  });

  it('revalidates HTML across a build change and retains still-present old hashed chunks', async () => {
    const before = await request('/creator-admission/local');
    await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>new entry changed</title>');
    const after = await request('/creator-admission/local', { 'If-None-Match': String(before.headers.etag) });
    expect(after.status).toBe(200);
    expect(after.body.toString()).toContain('new entry changed');
    expect((await request('/assets/index-abcdefgh.js')).status).toBe(200);
  });
});
