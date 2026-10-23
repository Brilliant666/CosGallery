// Run from client/: BROWSER_NODE_MODULES=<bundled packages> node test/creator-gallery-browser.mjs
// Real Vue components and browser clicks; every API response is synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';

const bundled = process.env.BROWSER_NODE_MODULES;
if (!bundled) throw new Error('Set BROWSER_NODE_MODULES to the bundled Node packages directory.');
const { chromium } = createRequire(path.join(bundled, 'playwright', 'package.json'))('playwright');
const isolated = mkdtempSync(path.join(tmpdir(), 'cosgallery-label-browser-'));
for (const key of ['DATA_ROOT', 'DB_DIR', 'GALLERY_ROOT', 'THUMBNAILS_DIR', 'PREVIEWS_DIR', 'BACKUP_ROOT']) {
  process.env[key] = path.join(isolated, key.toLowerCase());
  mkdirSync(process.env[key]);
}
process.env.VITEST = 'true';
const output = path.resolve('../.mocks/pr52/browser');
mkdirSync(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, open: false }, logLevel: 'error' });
const errors = [], unexpected = [], requests = [], evidence = [];
let browser;
const sample = (id, name, galleryLabels, contentRating) => ({
  id, key: `creator:${id}`, identityType: 'creator', canonicalCreatorId: id, name, canonicalName: name,
  slug: `synthetic-${id}`, folderPath: `Synthetic-${id}`, folderNames: [], aliases: [], localFolders: [],
  galleryLabels, contentRating, rosterStatus: 'active', linkStatus: 'linked', preference: 'liked',
  coverUrl: null, avatarUrl: null, workCount: 1, imageCount: 1, videoCount: 0, latestWorkAt: null
});
const creators = [
  sample(1, '合成博主甲', ['cosplay', 'portrait'], 'R18'),
  sample(2, '合成博主乙', ['selfie'], 'R15'),
  sample(3, '合成博主丙', [], null)
];
let revision = 'a'.repeat(64);
let conflictNextSave = false;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  assert(![4140, 4141, 4241].includes(port));
  const origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const query = Object.fromEntries(url.searchParams);
    requests.push({ method: request.method(), path: url.pathname, query });
    const role = new URL(request.headers().referer ?? origin).searchParams.get('role') ?? 'admin';
    const publicCreator = creator => {
      if (role === 'admin') return creator;
      const { preference: _private, ...rest } = creator;
      return rest;
    };
    if (url.pathname === '/api/places') return route.fulfill({ json: { items: [] } });
    if (url.pathname === '/api/cos-gallery/creators') {
      const items = creators.filter(c => (!query.label || c.galleryLabels.includes(query.label))
        && (query.label || !query.contentRating || c.contentRating === query.contentRating)
        && (!query.q || c.name.includes(query.q)));
      return route.fulfill({ json: { items: items.map(publicCreator), total: items.length, page: 1, limit: 60, hasMore: false, summary: {} } });
    }
    const works = url.pathname.match(/^\/api\/cos-gallery\/creators\/(\d+)\/works$/);
    if (works) return route.fulfill({ json: { creator: publicCreator(creators.find(c => c.id === Number(works[1]))), items: [], total: 0, page: 1, limit: 24, hasMore: false } });
    const editing = url.pathname.match(/^\/api\/admin\/archive-catalog\/creators\/(\d+)\/gallery-labels$/);
    if (editing) {
      assert.equal(role, 'admin', 'Non-admin UI must not read/write the label editor');
      const creator = creators.find(c => c.id === Number(editing[1]));
      if (request.method() === 'PUT') {
        if (conflictNextSave) {
          conflictNextSave = false;
          revision = 'c'.repeat(64);
          return route.fulfill({ status: 409, json: { message: '图库标签已被其他操作修改，请重新读取后保存' } });
        }
        const input = request.postDataJSON();
        assert.equal(input.expectedRevision, revision);
        creator.galleryLabels = input.galleryLabels;
        revision = 'b'.repeat(64);
      }
      return route.fulfill({ json: { galleryLabels: creator.galleryLabels, revision } });
    }
    unexpected.push(url.pathname);
    return route.fulfill({ status: 500, json: { message: 'Unhandled synthetic endpoint' } });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  const entry = `${origin}/test/creator-gallery-browser.html`;
  const cards = () => page.getByRole('heading', { level: 2 }).filter({ hasText: '合成博主' });
  const expectCards = async count => {
    await page.waitForFunction(expected => [...document.querySelectorAll('main h2')]
      .filter(node => node.textContent.includes('合成博主')).length === expected, count);
    assert.equal(await cards().count(), count);
  };
  const nav = variant => page.locator(`.library-nav--${variant}`);
  const saveScreenshot = async (name, action) => {
    await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
    evidence.push({ screenshot: `${name}.png`, url: page.url(), viewport: page.viewportSize(), time: new Date().toISOString(), role: new URL(page.url()).searchParams.get('role') ?? 'admin', action });
  };
  await page.goto(`${entry}#/library`);
  await cards().first().waitFor();
  await expectCards(3);
  await page.getByRole('group', { name: '分级', exact: true }).getByRole('button', { name: 'R18', exact: true }).click();
  await page.waitForURL(/rating=R18/);
  await page.waitForFunction(() => document.querySelectorAll('main h2').length === 1);
  await page.locator('.sidebar').hover();
  await nav('desktop').getByRole('button', { name: '展开图库分类' }).click();
  assert.deepEqual(await nav('desktop').locator('.library-nav__menu a').allTextContents(), ['Cosplay', '写真', '自拍', '福利姬']);
  await page.mouse.move(600, 200);
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().width >= 200);
  assert(await nav('desktop').locator('.library-nav__menu').evaluate(menu => {
    const bounds = menu.getBoundingClientRect();
    return [...menu.querySelectorAll('a')].every(link => link.scrollWidth <= link.clientWidth
      && link.getBoundingClientRect().right <= bounds.right);
  }), 'Desktop category menu must remain expanded and readable after the pointer leaves');
  await saveScreenshot('desktop-menu', '全部图库选择R18后展开四项分类菜单');
  await nav('desktop').getByRole('link', { name: 'Cosplay', exact: true }).click();
  await page.waitForURL(/label=cosplay/);
  await page.getByRole('heading', { level: 1, name: /Cosplay/ }).waitFor();
  assert(!page.url().includes('rating='));
  assert.equal(await page.getByRole('group', { name: '分级', exact: true }).count(), 0);
  assert.equal(await page.locator('main').getByText('R18', { exact: true }).count(), 0);
  await expectCards(1);
  const categoryRequest = requests.filter(r => r.path === '/api/cos-gallery/creators' && r.query.label === 'cosplay').at(-1);
  assert(categoryRequest && !categoryRequest.query.contentRating);
  await page.getByRole('heading', { name: '合成博主甲', exact: true }).click();
  await page.waitForURL(/library\/1/);
  await page.getByRole('heading', { level: 1, name: '合成博主甲', exact: true }).waitFor();
  await page.goBack();
  await page.waitForURL(/label=cosplay/);
  await cards().first().waitFor();
  await saveScreenshot('desktop-category', 'Cosplay子分类进入博主并后退，分类范围恢复且无分级筛选');
  await page.locator('.sidebar').hover();
  await nav('desktop').getByRole('link', { name: '图库', exact: true }).click();
  await page.waitForURL(url => url.hash === '#/library');
  await page.getByRole('group', { name: '分级', exact: true }).waitFor();
  await expectCards(3);
  await page.getByRole('button', { name: '编辑 合成博主丙 的分类' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: '写真', exact: true }).check();
  await dialog.getByRole('checkbox', { name: '福利姬', exact: true }).check();
  await saveScreenshot('desktop-editor', '管理员多选写真和福利姬，尚未保存');
  await dialog.getByRole('button', { name: '保存分类', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(creators[2].galleryLabels, ['portrait', 'fuliji']);
  await page.getByRole('button', { name: '编辑 合成博主丙 的分类' }).click();
  await dialog.getByRole('checkbox', { name: '写真', exact: true }).waitFor();
  conflictNextSave = true;
  await dialog.getByRole('button', { name: '清空分类', exact: true }).click();
  await dialog.getByRole('button', { name: '保存分类', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  assert(await dialog.getByRole('button', { name: '保存分类', exact: true }).isDisabled());
  await dialog.getByRole('button', { name: '重新读取分类', exact: true }).click();
  await dialog.getByRole('checkbox', { name: '写真', exact: true }).waitFor();
  assert(await dialog.getByRole('checkbox', { name: '写真', exact: true }).isChecked());
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  for (const role of ['anonymous', 'viewer']) {
    await page.goto(`${entry}?role=${role}#/library?label=portrait&rating=R18&preference=liked`);
    await page.getByRole('heading', { level: 1, name: /写真/ }).waitFor();
    await page.waitForURL(url => !url.hash.includes('rating=') && !url.hash.includes('preference='));
    assert.equal(await page.getByRole('group', { name: '偏好', exact: true }).count(), 0);
    assert.equal(await page.locator('[data-test="edit-gallery-labels"]').count(), 0);
    await expectCards(2);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${entry}?role=anonymous#/library`);
  await cards().first().waitFor();
  await nav('mobile').getByRole('button', { name: '展开图库分类' }).click();
  assert.deepEqual(await nav('mobile').locator('.library-nav__menu a').allTextContents(), ['Cosplay', '写真', '自拍', '福利姬']);
  await saveScreenshot('mobile-menu', '390宽匿名图库展开四项分类菜单');
  await nav('mobile').getByRole('link', { name: '福利姬', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: /福利姬/ }).waitFor();
  await expectCards(1);
  assert.equal(await page.getByRole('group', { name: '分级', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await saveScreenshot('mobile-category', '390宽匿名福利姬分类，只显示匹配博主，无分级与管理偏好');
  await nav('mobile').getByRole('link', { name: '图库', exact: true }).click();
  await page.waitForURL(url => url.hash === '#/library');
  await page.getByRole('group', { name: '分级', exact: true }).waitFor();
  await expectCards(3);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ evidence, requests, errors, unexpected }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', output, screenshots: evidence.length, requests: requests.length, scenarios: ['desktop navigation and return', 'four menu options', 'category removes rating', 'multiple labels and conflict', 'anonymous and viewer privacy', 'mobile layout and all reset'] }));
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    console.error(JSON.stringify({ url: page.url(), errors, unexpected,
      navigation: await page.locator('.library-nav').evaluateAll(nodes => nodes.map(node => node.outerHTML)).catch(() => []) }));
  }
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
