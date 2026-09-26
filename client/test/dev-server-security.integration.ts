import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { developmentFileAllow, developmentFileDeny, privateDevelopmentFiles, resolveDevelopmentHost } from '../dev-server-security';

const require = createRequire(import.meta.url);
const roots: string[] = [];
let vite: ViteDevServer | undefined;
let upstream: ReturnType<typeof createHttpServer> | undefined;

afterEach(async () => {
  await vite?.close(); vite = undefined;
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream!.close(() => resolve()));
    upstream = undefined;
  }
  for (const root of roots.splice(0)) {
    if (!root.startsWith(path.join(os.tmpdir(), 'cosgallery-vite-boundary-'))) throw new Error('Unexpected fixture root');
    rmSync(root, { recursive: true, force: true });
  }
});

it('uses loopback unless an operator explicitly selects a listen IP', () => {
  expect(resolveDevelopmentHost()).toBe('127.0.0.1');
  expect(resolveDevelopmentHost('')).toBe('127.0.0.1');
  expect(resolveDevelopmentHost('192.0.2.10')).toBe('192.0.2.10');
  expect(resolveDevelopmentHost('0.0.0.0')).toBe('0.0.0.0');
  expect(resolveDevelopmentHost('::1')).toBe('::1');
  for (const invalid of ['true', '*', 'https://example.test', 'example.test']) {
    expect(() => resolveDevelopmentHost(invalid)).toThrow('DEV_CLIENT_HOST');
  }
});

it('blocks private static, raw, encoded, @fs and symlink paths while preserving app and proxy reads', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cosgallery-vite-boundary-')); roots.push(root);
  const client = path.join(root, 'client');
  const privateRoot = path.join(root, 'backup-custom');
  const sentinel = 'SYNTHETIC-PRIVATE-SENTINEL';
  const put = (relative: string, contents: string) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents);
    return file;
  };
  put('client/index.html', '<div id="app"></div><script type="module" src="/src/main.ts"></script>');
  put('client/src/main.ts', 'import App from "./App.vue"; console.log(App);');
  put('client/src/App.vue', '<template><p>synthetic vue fixture</p></template>');
  put('client/public/fixture-font.woff2', 'synthetic-font');
  put('outside/sentinel.txt', sentinel);
  const privateFiles = [
    '.env', '.env.production', '.mocks/fixture.txt', 'data/gallery.sqlite', 'db/gallery.db',
    'private/password.key', '.run/fixture.run.xml', 'data_backup/point/config.txt',
    'loose.sqlite-wal', 'loose.db-shm', 'backup-custom/sentinel.txt'
  ];
  for (const file of privateFiles) { put('client/' + file, sentinel); put(file, sentinel); }
  // A harmless alias must not bypass the configured private root or allow list.
  symlinkSync(privateRoot, path.join(client, 'public', 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(path.join(root, 'outside'), path.join(client, 'public', 'outside-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  upstream = createHttpServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ proxy: true, path: request.url }));
  });
  await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const dependencyRoot = realpathSync(path.dirname(require.resolve('vue/package.json')));
  const dependencyAlias = path.join(root, 'linked-dependency');
  symlinkSync(dependencyRoot, dependencyAlias, process.platform === 'win32' ? 'junction' : 'dir');
  vite = await createServer({
    configFile: false, root: client, logLevel: 'silent',
    plugins: [privateDevelopmentFiles([privateRoot, path.join(client, 'backup-custom')]), vue()],
    resolve: { alias: { vue: require.resolve('vue/dist/vue.runtime.esm-bundler.js') } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      host: '127.0.0.1', port: 0,
      fs: { strict: true, allow: developmentFileAllow(client, dependencyAlias), deny: developmentFileDeny },
      proxy: Object.fromEntries(['api', 'thumbnails', 'previews'].map(prefix => [`^/${prefix}(?:/|$)`, `http://127.0.0.1:${upstreamPort}`]))
    }
  });
  await vite.listen();
  const base = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  const attacks = privateFiles.flatMap(file => [
    '/' + file, '/' + file + '?raw', '/' + file + '?url&import',
    '/@fs/' + path.join(root, file).replace(/\\/g, '/'),
    '/@fs/' + encodeURIComponent(path.join(root, file).replace(/\\/g, '/'))
  ]);
  attacks.push('/%2emocks/fixture.txt', '/%252emocks/fixture.txt?raw', '/%2eenv%3fraw',
    '/.mocks%5cfixture.txt', '/alias/sentinel.txt', '/outside-alias/sentinel.txt',
    '/src/%2e%2e/%2emocks/fixture.txt', '/%00.env', '/.env::$DATA', '/.env:stream', '/.env.');
  for (const url of attacks) {
    const response = await fetch(base + url);
    expect([400, 404], url).toContain(response.status);
    expect(await response.text(), url).not.toContain(sentinel);
  }
  for (const url of ['/', '/src/main.ts', '/src/App.vue', '/@vite/client', '/fixture-font.woff2']) {
    const response = await fetch(base + url);
    expect(response.status, url).toBe(200);
    expect(await response.text(), url).not.toContain(sentinel);
  }
  const dependency = await fetch(base + '/@fs/' + require.resolve('vue/dist/vue.runtime.esm-bundler.js').replace(/\\/g, '/'));
  expect(dependency.status).toBe(200);
  const hmrClient = await (await fetch(base + '/@vite/client')).text();
  const token = /const wsToken = "([^"]+)"/.exec(hmrClient)?.[1];
  expect(token).toBeTruthy();
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/?token=' + token, 'vite-hmr');
  try {
    const connected = await new Promise<string>((resolve, reject) => {
      socket.addEventListener('message', event => resolve(String(event.data)), { once: true });
      socket.addEventListener('error', () => reject(new Error('Synthetic HMR socket failed')), { once: true });
    });
    expect(JSON.parse(connected)).toEqual({ type: 'connected' });
  } finally { socket.close(); }
  for (const url of ['/api/status', '/api/folders/.mocks', '/thumbnails/private/photo.jpg', '/previews/.env/photo.jpg']) {
    const response = await fetch(base + url);
    expect(response.status, url).toBe(200);
    expect(await response.json()).toEqual({ proxy: true, path: url });
  }
  const lookalike = await fetch(base + '/api-private/.env?raw');
  expect(lookalike.status).toBe(404);
});
