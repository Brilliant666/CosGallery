// Real Vue interactions on synthetic API responses; never connects to the app server.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { isolatedTestEnvironment } from '../../scripts/test-environment.mjs';

const output = mkdtempSync(path.join(process.env.BROWSER_SMOKE_ROOT ?? tmpdir(), 'cosgallery-browser-smoke-'));
const requests = [], errors = [], unexpected = [], websockets = [], results = [];
let server, browser, page, port, browserVersion, failure;
try {
  Object.assign(process.env, isolatedTestEnvironment(output), { DEV_CLIENT_HOST: '127.0.0.1', DEV_CLIENT_PORT: '0', DEV_SERVER_PORT: '0', VITEST: 'true' });
  for (const key of ['LOCAL_INGEST_INBOX_ROOT', 'LOCAL_INGEST_PROCESSING_ROOT']) process.env[key] = path.join(output, key.toLowerCase());
  for (const key of ['DATA_ROOT', 'DB_DIR', 'THUMBNAILS_DIR', 'PREVIEWS_DIR', 'GALLERY_ROOT', 'BACKUP_ROOT', 'LOCAL_INGEST_INBOX_ROOT', 'LOCAL_INGEST_PROCESSING_ROOT']) mkdirSync(process.env[key], { recursive: true });
  const selectedPort = await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const candidate = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(candidate));
    });
  });
  assert.notEqual(selectedPort, 4141);
  server = await createServer({ server: { host: '127.0.0.1', port: selectedPort, strictPort: true, open: false, hmr: false }, logLevel: 'error' });
  await server.listen();
  port = server.httpServer.address().port;
  assert.notEqual(port, 4141);
  const origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ headless: true });
  browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' });
  await context.routeWebSocket('**/*', ws => {
    const url = new URL(ws.url());
    websockets.push({ hostname: url.hostname, port: url.port, path: url.pathname });
    ws.close();
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    requests.push({ method: request.method(), path: url.pathname, query: Object.fromEntries(url.searchParams) });
    let body;
    if (url.pathname.endsWith('/166/works')) body = { creator: { ...row, key: 'creator:166', slug: 'synthetic', folderPath: 'Synthetic', contentRating: 'R15', localFolders: [{ id: 1, slug: 'synthetic', name: folder.name, path: folder.folderPath, workCount: 1 }] }, items: [], total: 0, page: 1, limit: 24, hasMore: false };
    else if (url.pathname === '/api/folders/synthetic') {
      if (request.method() === 'PATCH') Object.assign(folder, request.postDataJSON());
      body = folder;
    } else if (url.pathname.endsWith('/share-links')) body = { links: [], password: { enabled: false, updatedAt: null } };
    else if (url.pathname === '/api/admin/archive-catalog') body = { items: [{ ...row, preference: url.searchParams.get('preference') || row.preference, name: url.searchParams.get('q') ? `匹配:${url.searchParams.get('q')}` : row.name }], summary, total: 1, page: 1, limit: 50, hasMore: false };
    else { unexpected.push(url.pathname); return route.fulfill({ status: 500, json: { error: 'Unhandled synthetic endpoint' } }); }
    await route.fulfill({ status: 200, json: body });
  });
  const summary = Object.fromEntries(['creators','activeCreators','inactiveCreators','liked','kept','unsetPreference','r15','r18','unclassified','creatorsWithSources','creatorsWithLocalWorks','creatorsWithoutLocalWorks','unlinkedLocalFolders','sourceCollections','remoteWorks','localWorks','matchedWorks','missingWorks','unresolvedCreatorFolders','unresolvedLocalWorks'].map(key => [key, 2]));
  const folder = { id: 1, slug: 'synthetic', name: '测试目录', folderPath: 'Synthetic/Photos', description: '目录资料', breadcrumb: null, contentRating: 'R15', imageCount: 0, videoCount: 0, latestImageMtimeMs: null, avatarImageId: null, avatarUrl: null };
  const row = { id: 166, name: '测试博主', preference: 'liked', rating: 'R15', isActive: true, aliasCount: 0, sourceCount: 1, localFolderCount: 1, localWorks: 1, sourceCollections: 1, remoteWorks: 1, matchedWorks: 1, missingWorks: 0, updatedAt: '2026-09-09', latestSourceObservation: null };
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const base = `${origin}/test/ci-browser-smoke.html`;
  await page.goto(`${base}#/library/166`);
  await page.getByRole('heading', { name: '测试博主', exact: true }).waitFor();
  assert.equal(requests.filter(r => r.path === '/api/folders/synthetic').length, 0);
  assert.equal(await page.locator('[data-test=creator-folder-actions] details').count(), 0);
  const initialUrl = page.url();
  await page.getByRole('button', { name: '编辑目录资料：测试目录', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.locator('#profile-name').fill('更新目录');
  await page.getByRole('dialog').getByRole('button').last().click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(page.url(), initialUrl);
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), '测试博主');
  await page.getByRole('button', { name: '分享此目录：更新目录', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: path.join(output, 'directory-share.png') });
  await page.getByRole('dialog').getByRole('button').first().click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(page.url(), initialUrl);
  results.push('Directory lazy loading, profile save scope, share open/close and unchanged route passed');
  await page.goto(`${base}#/archive-catalog`);
  const roster = page.getByRole('region', { name: '博主库', exact: true });
  await roster.locator('.creator-card').waitFor();
  await roster.locator('input[type=search]').fill('即时');
  await roster.getByText('匹配:即时', { exact: true }).waitFor();
  const selectResponse = page.waitForResponse(response => response.url().includes('preference=kept'));
  await roster.locator('select').first().selectOption('kept');
  await page.waitForFunction(() => document.querySelector('.roster select')?.value === 'kept');
  await selectResponse;
  assert(requests.some(r => r.query.q === '即时' && r.query.preference === 'kept'));
  await roster.screenshot({ path: path.join(output, 'roster-filter.png') });
  results.push('Roster search debounce and immediate select filtering passed');
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  // Vite injects an HMR client even with HMR disabled. The browser routing
  // blocks these attempts before any socket is opened; no external host is OK.
  assert(websockets.every(ws => ws.hostname === '127.0.0.1' && [String(port), '0'].includes(ws.port) && ws.path === '/'));
  assert.equal(requests.filter(r => r.method !== 'GET').length, 1);
} catch (error) {
  failure = String(error?.message ?? error);
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  const report = { status: failure ? 'FAIL' : 'PASS', port, browserVersion, results, errors, unexpected, websockets, requests, failure };
  try {
    writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, output }, null, 2));
  } finally {
    try { await browser?.close(); } finally { await server?.close(); }
  }
}
