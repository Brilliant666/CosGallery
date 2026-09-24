import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { denyRecoveryFileRequests } from '../src/middleware/protected-recovery-files.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-http-access-'));
  for (const file of ['.env', '.env.production', 'private/password.key', '.run/fixture.run.xml', 'data_backup/point-fixture/gallery.sqlite', 'backups/gallery.sqlite']) {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'fixture-secret-must-not-be-served');
  }
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const compatible = ['/api/folders/private', '/api/folders/.run', '/api/folders/album.key', '/api/folders/data_backup', '/thumbnails/album/private/file.jpg', '/previews/album/.env/photo.jpg'];
const protectedPaths = ['/.env', '/%2eenv', '/.env.production', '/private/password.key', '/.run/fixture.run.xml', '/data_backup/point-fixture/gallery.sqlite', '/backups/gallery.sqlite'];
function routes(app: express.Express) {
  for (const route of ['/api', '/thumbnails', '/previews']) {
    app.use(route, (request, response) => response.json({ reachedExistingRoute: route, path: request.path }));
  }
}

it('production protects static secrets without preempting existing API or media routes', async () => {
  const app = express();
  app.use(denyRecoveryFileRequests(path.join(root, 'backups')));
  routes(app);
  // Deliberately permissive fixture static mount proves the guard, not express dotfile defaults.
  app.use(express.static(root, { dotfiles: 'allow' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const suffix of compatible) {
      const response = await fetch(base + suffix);
      expect(response.status, suffix).toBe(200);
      expect((await response.json()).reachedExistingRoute).toBe('/' + suffix.split('/')[1]);
    }
    for (const suffix of protectedPaths) {
      const response = await fetch(base + suffix);
      expect(response.status, suffix).toBe(404);
      expect(await response.text()).not.toContain('fixture-secret');
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('Vite keeps proxy API/media paths while denying static and @fs secret paths', async () => {
  // Vite belongs to the client workspace, not the server's dependency graph.
  const clientRequire = createRequire(new URL('../../client/package.json', import.meta.url));
  const vitePackage = clientRequire.resolve('vite/package.json');
  const { createServer } = await import(pathToFileURL(path.join(path.dirname(vitePackage), 'dist/node/index.js')).href);
  const { recoveryFileProtection } = await import('../../client/vite.config.js');
  const backend = express(); routes(backend);
  const upstream = backend.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => upstream.once('listening', resolve));
  const target = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const vite = await createServer({ configFile: false, root, logLevel: 'silent',
    plugins: [recoveryFileProtection(path.join(root, 'backups'))],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] }, proxy: { '/api': target, '/thumbnails': target, '/previews': target } }
  });
  try {
    await vite.listen();
    const base = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
    for (const suffix of compatible) {
      const response = await fetch(base + suffix);
      expect(response.status, suffix).toBe(200);
      expect((await response.json()).reachedExistingRoute).toBe('/' + suffix.split('/')[1]);
    }
    for (const suffix of [...protectedPaths, `/@fs/${path.join(root, 'backups/gallery.sqlite').replace(/\\/g, '/')}`, `/@fs/${path.join(root, 'private/password.key').replace(/\\/g, '/')}`]) {
      const response = await fetch(base + suffix);
      expect(response.status, suffix).toBe(404);
      expect(await response.text()).not.toContain('fixture-secret');
    }
  } finally {
    await vite.close(); upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
