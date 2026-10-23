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
const output = path.resolve(process.env.CREATOR_GALLERY_BROWSER_OUTPUT ?? '../.mocks/pr52/browser');
mkdirSync(output, { recursive: true });
const server = await createServer({
  server: { host: '127.0.0.1', port: 0, strictPort: false, open: false }, logLevel: 'error',
  plugins: [{
    name: 'synthetic-home-unused-media', enforce: 'pre',
    // The home fixture contains no feed posts and never opens a story viewer.
    // Keep its actual root, story rail, Avatar and resize behavior without loading
    // the unrelated video player graph through these unused components.
    resolveId(source, importer) {
      if (importer?.replaceAll('\\', '/').endsWith('/src/views/HomeView.vue') && /(?:FeedList|StoriesModal)\.vue$/.test(source)) return '\0synthetic-home-unused-media';
    },
    load(id) { if (id === '\0synthetic-home-unused-media') return 'export default { render: () => null }'; }
  }]
});
const errors = [], unexpected = [], requests = [], evidence = [], layouts = [], classificationRows = [], sidebarFrames = [], homeLayouts = [], storageChecks = [];
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
  page.on('console', message => { if (message.type() === 'error') console.error(`Browser console: ${message.text()}`); });
  page.on('requestfailed', request => console.error(`Browser request failed: ${new URL(request.url()).pathname} ${request.failure()?.errorText}`));
  page.setDefaultTimeout(15000);
  const entry = `${origin}/test/creator-gallery-browser.html`;
  const cards = () => page.getByRole('heading', { level: 2 }).filter({ hasText: '合成博主' });
  const expectCards = async count => {
    await page.waitForFunction(expected => [...document.querySelectorAll('main h2')]
      .filter(node => node.textContent.includes('合成博主')).length === expected, count);
    assert.equal(await cards().count(), count);
  };
  const nav = variant => page.locator(`.library-nav--${variant}`);
  const classificationControls = () => page.locator('main [data-test="creator-gallery-labels"], main [data-test="edit-gallery-labels"]');
  const expectCategoryCards = async () => {
    assert.equal(await classificationControls().count(), 0, 'Category cards must not render public labels or admin editing controls');
    assert.equal(await page.locator('main [data-test="creator-classification"]').count(), 0, 'Category cards must not leave an empty classification row');
  };
  const expectAllLabels = async role => {
    for (const creator of creators) {
      const card = page.locator('[aria-label="博主目录"] article').filter({ has: page.getByRole('heading', { level: 2, name: creator.name, exact: true }) });
      const labels = await card.locator('[data-test="creator-gallery-labels"] span').allTextContents();
      const title = { cosplay: 'Cosplay', portrait: '写真', selfie: '自拍', fuliji: '福利姬' };
      assert.deepEqual(labels.map(text => text.trim()), creator.galleryLabels.map(label => title[label]), `${role}: all-gallery preserves every public label`);
      assert.equal(await card.locator('[data-test="edit-gallery-labels"]').count(), role === 'admin' ? 1 : 0, `${role}: editor access includes untagged admin cards`);
    }
  };
  const readClassificationRows = () => page.locator('[aria-label="博主目录"] article').evaluateAll(cards => {
    const bounds = element => {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    return cards.flatMap(card => {
      const labels = card.querySelector('[data-test="creator-gallery-labels"]');
      const edit = card.querySelector('[data-test="edit-gallery-labels"]');
      if (!labels || !edit) return [];
      return [{
        name: card.querySelector('h2').textContent.trim(), card: bounds(card), labels: bounds(labels), edit: bounds(edit),
        accessibleEditName: edit.getAttribute('aria-label'),
        badges: [...labels.querySelectorAll('span')].map(badge => ({ text: badge.textContent.trim(), ...bounds(badge), overflow: badge.scrollWidth > badge.clientWidth + 1 })),
        editOverflow: edit.scrollWidth > edit.clientWidth + 1,
        cardOverflow: card.scrollWidth > card.clientWidth + 1
      }];
    });
  });
  const expectClassificationRows = async viewport => {
    const rows = await readClassificationRows();
    assert(rows.some(row => row.badges.length === 1), 'Same-row fixture must include a single-label card');
    assert(rows.some(row => row.badges.length > 1), 'Same-row fixture must include a multi-label card');
    for (const row of rows) {
      const description = `${viewport.width}px ${row.name}`;
      assert(row.labels.right <= row.edit.left + 1, `${description}: labels and edit button stay side by side without overlap`);
      assert(Math.min(row.labels.bottom, row.edit.bottom) - Math.max(row.labels.top, row.edit.top) > 0,
        `${description}: edit button shares the label block row`);
      assert(row.labels.left >= row.card.left && row.edit.right <= row.card.right, `${description}: the classification row stays within its card`);
      assert.equal(row.editOverflow || row.cardOverflow, false, `${description}: no clipped button or card content`);
      assert.equal(row.accessibleEditName, `编辑 ${row.name} 的分类`);
      for (const badge of row.badges) {
        assert(badge.left >= row.labels.left - 1 && badge.right <= row.labels.right + 1 && badge.top >= row.labels.top - 1 && badge.bottom <= row.labels.bottom + 1,
          `${description}: ${badge.text} wraps within its label block`);
        assert.equal(badge.overflow, false, `${description}: ${badge.text} remains readable`);
      }
      classificationRows.push({ viewport, ...row });
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  };
  const saveScreenshot = async (name, action, target = page) => {
    await target.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
    evidence.push({ screenshot: `${name}.png`, url: page.url(), viewport: page.viewportSize(), time: new Date().toISOString(), role: new URL(page.url()).searchParams.get('role') ?? 'admin', action });
  };
  const saveLayoutScreenshot = async (name, action) => {
    await setSidebar(false);
    await saveScreenshot(name, action);
  };
  const expectOpenMenu = async variant => {
    assert.equal(await nav(variant).getByRole('button', { name: '展开图库分类' }).getAttribute('aria-expanded'), 'true');
    await nav(variant).locator('.library-nav__menu').waitFor({ state: 'visible' });
    await page.waitForFunction(currentVariant => !document.querySelector(`.library-nav--${currentVariant} .library-nav__menu`)?.classList.contains('library-categories-enter-active'), variant);
    assert(await nav(variant).locator('.library-nav__menu').isVisible());
    assert.equal(await nav(variant).locator('.library-nav__category-icon').count(), 4);
    assert(await nav(variant).locator('.library-nav__category-icon').evaluateAll(icons => icons.every(icon => {
      const style = getComputedStyle(icon);
      return icon.getAttribute('aria-hidden') === 'true' && style.maskImage !== 'none'
        && icon.getBoundingClientRect().width > 0 && icon.getBoundingClientRect().height > 0;
    })), 'Each category must render its decorative Fluent icon');
  };
  const expectClosedMenu = async variant => {
    await page.waitForFunction(currentVariant => !document.querySelector(`.library-nav--${currentVariant} .library-nav__menu`), variant);
    assert.equal(await nav(variant).locator('.library-nav__menu').count(), 0);
  };
  const checkSidebarTransition = async (name, action) => {
    // Sample the real AppShell throughout expansion/collapse, not just its end state.
    await page.evaluate(() => {
      window.__sidebarFrames = [];
      window.__sidebarSampling = new Promise(resolve => {
        const started = performance.now();
        const sample = () => {
          const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
          const content = document.querySelector('.app-shell__content').getBoundingClientRect();
          const firstCard = document.querySelector('[aria-label="博主目录"] article')?.getBoundingClientRect();
          const firstStory = document.querySelector('.story-rail__item')?.getBoundingClientRect();
          const firstStoryRing = document.querySelector('.story-rail__ring')?.getBoundingClientRect();
          window.__sidebarFrames.push({ elapsed: performance.now() - started, sidebarRight: sidebar.right, sidebarWidth: sidebar.width,
            contentLeft: content.left, cardLeft: firstCard?.left ?? null, cardRight: firstCard?.right ?? null,
            storyLeft: firstStory?.left ?? null, storyRingLeft: firstStoryRing?.left ?? null });
          if (performance.now() - started < 650) requestAnimationFrame(sample);
          else resolve(window.__sidebarFrames);
        };
        requestAnimationFrame(sample);
      });
    });
    await action();
    const frames = await page.evaluate(() => window.__sidebarSampling);
    sidebarFrames.push({ viewport: page.viewportSize(), name, frames });
    for (const frame of frames) {
      assert(frame.contentLeft >= frame.sidebarRight - 1, `${page.viewportSize().width}px ${name}: content ${frame.contentLeft} overlaps sidebar ${frame.sidebarRight}`);
      if (frame.cardLeft !== null) assert(frame.cardLeft >= frame.sidebarRight - 1, `${page.viewportSize().width}px ${name}: first card ${frame.cardLeft} overlaps sidebar ${frame.sidebarRight}`);
      if (frame.storyLeft !== null) assert(frame.storyLeft >= frame.sidebarRight - 1, `${page.viewportSize().width}px ${name}: first home story ${frame.storyLeft} overlaps sidebar ${frame.sidebarRight}`);
      if (frame.storyRingLeft !== null) assert(frame.storyRingLeft >= frame.sidebarRight - 1, `${page.viewportSize().width}px ${name}: first home story ring overlaps the sidebar`);
    }
    return frames.at(-1);
  };
  const clearSidebarInteraction = async () => {
    await page.mouse.move(page.viewportSize().width - 10, 10);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  };
  const settleSidebar = () => page.waitForFunction(() => {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return false; // Reload may finish before the router mounts AppShell.
    if (getComputedStyle(sidebar).display === 'none') return true;
    const toggle = document.querySelector('[data-test="sidebar-toggle"]');
    if (!toggle) return false;
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    return Math.abs(sidebar.getBoundingClientRect().width - (expanded ? 240 : 77.6)) < 1;
  });
  const sidebarToggle = () => page.locator('[data-test="sidebar-toggle"]');
  const expectSidebarNoHorizontalScroll = async () => {
    const metrics = await page.locator('.sidebar__nav').evaluate(node => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, scrollLeft: node.scrollLeft }));
    assert(metrics.scrollWidth <= metrics.clientWidth + 1 && metrics.scrollLeft === 0, `Sidebar navigation must not scroll horizontally: ${JSON.stringify(metrics)}`);
  };
  const setSidebar = async expanded => {
    if (page.viewportSize().width < 768) return;
    if ((await sidebarToggle().getAttribute('aria-expanded') === 'true') !== expanded) await sidebarToggle().click();
    await settleSidebar();
  };
  const shellGridBounds = () => page.locator('[aria-label="博主目录"]').evaluate(grid => {
    const { x, y, width } = grid.getBoundingClientRect();
    return { x, y, width };
  });
  const sidebarLabelsBefore = structuredClone(creators.map(creator => creator.galleryLabels));
  for (const width of [1440, 1098, 980, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${entry}#/library`);
    await expectCards(3);
    await page.evaluate(() => document.fonts.ready);
    assert(await page.locator('.sidebar').isVisible(), `${width}px uses the actual desktop breakpoint`);
    const collapsed = await checkSidebarTransition('collapsed', clearSidebarInteraction);
    assert(Math.abs(collapsed.sidebarWidth - 77.6) < 1);
    await expectSidebarNoHorizontalScroll();
    assert.equal(await sidebarToggle().getAttribute('aria-label'), '展开侧栏');
    const hovered = await checkSidebarTransition('hover-stays-collapsed', () => page.locator('.sidebar').hover());
    assert(Math.abs(hovered.sidebarWidth - 77.6) < 1);
    const focused = await checkSidebarTransition('keyboard-focus-stays-collapsed', async () => {
      await page.locator('.sidebar__brand').focus();
      await page.keyboard.press('Tab');
    });
    assert(Math.abs(focused.sidebarWidth - 77.6) < 1);
    assert(await page.locator('.sidebar').evaluate(sidebar => sidebar.contains(document.activeElement)));
    const expanded = await checkSidebarTransition('click-expand', () => sidebarToggle().click());
    assert(Math.abs(expanded.sidebarWidth - 240) < 1);
    await expectSidebarNoHorizontalScroll();
    assert.equal(await sidebarToggle().getAttribute('aria-label'), '收起侧栏');
    assert.equal(await page.evaluate(() => localStorage.getItem('cosgallery.sidebar-expanded.v1')), 'true');
    await saveScreenshot(`sidebar-${width}-expanded`, '点击展开真实侧栏；首列卡片完整位于侧栏右侧');
    await checkSidebarTransition('independent-category-open', () => nav('desktop').getByRole('button', { name: '展开图库分类' }).click());
    await expectOpenMenu('desktop');
    const openGrid = await shellGridBounds();
    for (const [label, title, count] of [['cosplay', 'Cosplay', 1], ['portrait', '写真', 1], ['selfie', '自拍', 1], ['fuliji', '福利姬', 0]]) {
      await checkSidebarTransition(`persistent-category-${label}`, async () => {
        await nav('desktop').getByRole('link', { name: title, exact: true }).click();
        await page.waitForURL(url => url.hash.includes(`label=${label}`));
        await expectCards(count);
        await clearSidebarInteraction();
      });
      await expectOpenMenu('desktop');
      await expectCategoryCards();
      if (count) {
        const currentGrid = await shellGridBounds();
        for (const coordinate of ['x', 'y', 'width']) assert(Math.abs(currentGrid[coordinate] - openGrid[coordinate]) <= 1,
          `${width}px ${label}: grid.${coordinate} stays stable while the sidebar remains expanded`);
      }
    }
    await checkSidebarTransition('hide-open-category-on-collapse', () => sidebarToggle().click());
    await expectClosedMenu('desktop');
    assert.equal(await page.evaluate(() => localStorage.getItem('cosgallery.sidebar-expanded.v1')), 'false');
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.library-nav__menu'))), false, 'Hidden submenu must not remain keyboard reachable');
    }
    await checkSidebarTransition('restore-open-category-on-expand', () => sidebarToggle().click());
    await expectOpenMenu('desktop');
    await checkSidebarTransition('rapid-pointer-reversal-with-open-menu', async () => {
      const button = await sidebarToggle().boundingBox();
      const x = button.x + 20, y = button.y + button.height / 2;
      // Coordinates stay inside the icon while width changes; locator.click()
      // would wait for layout stability and accidentally skip the live reversal.
      await page.mouse.click(x, y);
      await page.waitForTimeout(45);
      await page.mouse.click(x, y);
    });
    assert(await sidebarToggle().evaluate(button => button === document.activeElement), 'Global toggle retains keyboard focus through a reversal');
    await nav('desktop').getByRole('button', { name: '展开图库分类' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(45);
    await page.keyboard.press('Enter');
    await expectOpenMenu('desktop');
    assert(await nav('desktop').locator('.library-nav__menu').evaluate(menu => !menu.hasAttribute('inert') && !menu.hasAttribute('aria-hidden')
      && [...menu.querySelectorAll('a')].every(link => link.tabIndex >= 0)), 'Reversing submenu leave restores every link to keyboard and assistive technology');
    await page.keyboard.press('Tab');
    assert(await nav('desktop').getByRole('link', { name: 'Cosplay', exact: true }).evaluate(link => link === document.activeElement));
    await page.keyboard.press('Enter');
    await page.waitForURL(/label=cosplay/);
    await expectCards(1);
    await nav('desktop').getByRole('link', { name: '福利姬', exact: true }).click();
    await expectCards(0);
    await nav('desktop').getByRole('button', { name: '展开图库分类' }).click();
    await page.waitForFunction(() => !document.querySelector('.library-nav--desktop .library-nav__menu'));
    assert(Math.abs((await page.locator('.sidebar').boundingBox()).width - 240) < 1, 'Category toggle must not collapse the outer sidebar');
    await page.reload();
    await expectCards(0);
    await settleSidebar();
    assert.equal(await sidebarToggle().getAttribute('aria-expanded'), 'true', 'Reload restores the explicit expanded preference');
    await page.locator('.sidebar__brand').focus();
    for (let index = 0; index < 20 && !await sidebarToggle().evaluate(button => button === document.activeElement); index += 1) await page.keyboard.press('Tab');
    assert(await sidebarToggle().evaluate(button => button === document.activeElement), 'The global toggle is reachable by actual Tab navigation');
    await checkSidebarTransition('keyboard-space-collapse', () => page.keyboard.press('Space'));
    assert.equal(await sidebarToggle().getAttribute('aria-expanded'), 'false');
    await checkSidebarTransition('keyboard-enter-expand', () => page.keyboard.press('Enter'));
    assert.equal(await sidebarToggle().getAttribute('aria-expanded'), 'true');
    await checkSidebarTransition('rapid-keyboard-reversal', async () => {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(45);
      await page.keyboard.press('Enter');
    });
    assert.equal(await sidebarToggle().getAttribute('aria-expanded'), 'true');
    await setSidebar(false);
    await page.reload();
    await settleSidebar();
    assert.equal(await sidebarToggle().getAttribute('aria-expanded'), 'false', 'Reload restores the explicit collapsed preference');
    await page.goto(`${entry}#/library`);
    await expectCards(3);
    await clearSidebarInteraction();
    await settleSidebar();
    await saveScreenshot(`sidebar-${width}-collapsed`, '侧栏收起后主体同步恢复；首卡无遮挡');
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await checkSidebarTransition('reduced-motion-click-expand', () => sidebarToggle().click());
  await checkSidebarTransition('reduced-motion-click-collapse', () => sidebarToggle().click());
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const width of [767, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${entry}#/library`);
    await expectCards(3);
    assert.equal(await page.locator('.sidebar').isVisible(), false, `${width}px hides the desktop sidebar`);
    const content = await page.locator('.app-shell__content').boundingBox();
    assert(Math.abs(content.x) <= 1, `${width}px must not reserve desktop sidebar space`);
    const baseline = await shellGridBounds();
    await nav('mobile').getByRole('button', { name: '展开图库分类' }).click();
    await expectOpenMenu('mobile');
    await nav('mobile').getByRole('link', { name: 'Cosplay', exact: true }).click();
    await expectCards(1);
    await expectCategoryCards();
    await expectOpenMenu('mobile');
    const current = await shellGridBounds();
    for (const coordinate of ['x', 'y', 'width']) assert(Math.abs(baseline[coordinate] - current[coordinate]) <= 1,
      `${width}px mobile grid.${coordinate} remains stable without a sidebar gutter`);
    assert(await page.locator('.mobile-nav__bar').isVisible());
    assert(await nav('mobile').evaluate(node => {
      const menu = node.querySelector('.library-nav__menu').getBoundingClientRect();
      const bar = node.closest('.mobile-nav__bar').getBoundingClientRect();
      return menu.bottom < bar.top && menu.left >= 0 && menu.right <= innerWidth;
    }), `${width}px category menu leaves bottom navigation accessible`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await saveScreenshot(`sidebar-${width}-mobile-category`, '移动断点无桌面侧栏留白，分类菜单不遮挡底栏');
  }
  for (const width of [1440, 1098, 980, 768, 767, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${entry}#/`);
    await page.locator('.story-rail__item').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await setSidebar(false);
    const readHome = async state => {
      const geometry = await page.evaluate(() => {
        const bounds = selector => { const { left, right, width } = document.querySelector(selector).getBoundingClientRect(); return { left, right, width }; };
        return { sidebar: bounds('.sidebar'), content: bounds('.app-shell__content'), firstStory: bounds('.story-rail__item'), ring: bounds('.story-rail__ring'), horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      const description = `${width}px home ${state}`;
      assert(geometry.firstStory.left >= geometry.sidebar.right - 1, `${description}: first recent batch must be to the right of the sidebar`);
      assert(geometry.ring.left >= geometry.sidebar.right - 1, `${description}: first recent batch icon must not be hidden`);
      assert.equal(geometry.horizontalOverflow, false, description);
      homeLayouts.push({ width, state, ...geometry });
    };
    await readHome('collapsed');
    await saveScreenshot(`home-${width}-collapsed`, '真实HomeView合成近期批次：首个图标完整可见');
    if (width >= 768) {
      await checkSidebarTransition('home-click-expand', () => sidebarToggle().click());
      await readHome('expanded');
      await saveScreenshot(`home-${width}-expanded`, '真实HomeView随侧栏展开同步让位，首个近期批次图标无遮挡');
      await checkSidebarTransition('home-click-collapse', () => sidebarToggle().click());
    }
  }
  const restricted = await context.newPage();
  restricted.on('pageerror', error => errors.push(error.message));
  await restricted.addInitScript(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) { if (key === 'cosgallery.sidebar-expanded.v1') throw new DOMException('Synthetic blocked storage', 'SecurityError'); return get.call(this, key); };
    Storage.prototype.setItem = function(key, value) { if (key === 'cosgallery.sidebar-expanded.v1') throw new DOMException('Synthetic blocked storage', 'SecurityError'); return set.call(this, key, value); };
  });
  await restricted.goto(`${entry}#/library`);
  const restrictedToggle = restricted.locator('[data-test="sidebar-toggle"]');
  assert.equal(await restrictedToggle.getAttribute('aria-expanded'), 'false');
  await restrictedToggle.click();
  await restricted.waitForFunction(() => Math.abs(document.querySelector('.sidebar').getBoundingClientRect().width - 240) < 1);
  assert.equal(await restrictedToggle.getAttribute('aria-expanded'), 'true');
  await restricted.reload();
  assert.equal(await restrictedToggle.getAttribute('aria-expanded'), 'false');
  storageChecks.push({ reads: 'SecurityError', writes: 'SecurityError', toggling: 'PASS', reloadFallback: 'collapsed' });
  await restricted.close();
  assert.deepEqual(creators.map(creator => creator.galleryLabels), sidebarLabelsBefore, 'Sidebar layout must preserve all assigned labels');
  assert.equal(requests.filter(request => request.method !== 'GET').length, 0, 'Sidebar interactions must not persist any business data');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${entry}#/library`);
  await cards().first().waitFor();
  await expectCards(3);
  await expectAllLabels('admin');
  const originalLabels = structuredClone(creators.map(creator => creator.galleryLabels));
  await page.getByRole('group', { name: '分级', exact: true }).getByRole('button', { name: 'R18', exact: true }).click();
  await page.waitForURL(/rating=R18/);
  await page.waitForFunction(() => document.querySelectorAll('main h2').length === 1);
  await setSidebar(true);
  await nav('desktop').getByRole('button', { name: '展开图库分类' }).click();
  assert.deepEqual((await nav('desktop').locator('.library-nav__menu a').allTextContents()).map(text => text.trim()), ['Cosplay', '写真', '自拍', '福利姬']);
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
  await expectCategoryCards();
  await expectOpenMenu('desktop');
  for (const [label, title] of [['portrait', '写真'], ['selfie', '自拍'], ['fuliji', '福利姬'], ['cosplay', 'Cosplay'], ['cosplay', 'Cosplay']]) {
    await nav('desktop').getByRole('link', { name: title, exact: true }).click();
    await page.waitForURL(url => url.hash.includes(`label=${label}`));
    await page.getByRole('heading', { level: 1, name: `${title}图库`, exact: true }).waitFor();
    await expectOpenMenu('desktop');
    await expectCategoryCards();
    assert.equal((await nav('desktop').locator('a[aria-current="page"]').textContent()).trim(), title);
  }
  await saveScreenshot('desktop-selected-menu', '连续切换四分类并重复选择后菜单保持展开，Cosplay选中');
  await saveScreenshot('desktop-menu-detail', '四分类中性图标和缩进导航细节', nav('desktop'));
  await nav('desktop').getByRole('button', { name: '展开图库分类' }).focus();
  await page.keyboard.press('Tab');
  assert(await nav('desktop').getByRole('link', { name: 'Cosplay', exact: true }).evaluate(link => link === document.activeElement && getComputedStyle(link).outlineStyle !== 'none'));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await saveScreenshot('desktop-dark-menu', '暗色主题下分类选中和键盘焦点清晰可见');
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Escape');
  await expectClosedMenu('desktop');
  assert(await nav('desktop').getByRole('button', { name: '展开图库分类' }).evaluate(button => button === document.activeElement));
  await nav('desktop').getByRole('button', { name: '展开图库分类' }).click();
  await expectOpenMenu('desktop');
  const categoryRequest = requests.filter(r => r.path === '/api/cos-gallery/creators' && r.query.label === 'cosplay').at(-1);
  assert(categoryRequest && !categoryRequest.query.contentRating);
  await page.getByRole('heading', { name: '合成博主甲', exact: true }).click();
  await page.waitForURL(/library\/1/);
  await expectClosedMenu('desktop');
  await page.getByRole('heading', { level: 1, name: '合成博主甲', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter), 'auto',
    'Gallery scrollbar reservation must not affect creator details');
  await page.goBack();
  await page.waitForURL(/label=cosplay/);
  await cards().first().waitFor();
  await saveScreenshot('desktop-category', 'Cosplay子分类进入博主并后退，分类范围恢复且无分级筛选');
  await setSidebar(true);
  await nav('desktop').getByRole('link', { name: '图库', exact: true }).click();
  await page.waitForURL(url => url.hash === '#/library');
  await page.getByRole('group', { name: '分级', exact: true }).waitFor();
  await expectCards(3);
  await expectAllLabels('admin');
  assert.deepEqual(creators.map(creator => creator.galleryLabels), originalLabels, 'Navigation must not alter stored labels');
  assert.equal(requests.filter(request => request.method !== 'GET').length, 0, 'Displaying or hiding classification rows must not save labels');
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
    await expectCategoryCards();
    await page.goto(`${entry}?role=${role}#/library`);
    await expectCards(3);
    await expectAllLabels(role);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${entry}?role=anonymous#/library`);
  await cards().first().waitFor();
  await nav('mobile').getByRole('button', { name: '展开图库分类' }).click();
  assert.deepEqual((await nav('mobile').locator('.library-nav__menu a').allTextContents()).map(text => text.trim()), ['Cosplay', '写真', '自拍', '福利姬']);
  await expectOpenMenu('mobile');
  await saveScreenshot('mobile-menu', '390宽匿名图库展开四项分类菜单');
  await nav('mobile').getByRole('link', { name: '福利姬', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: /福利姬/ }).waitFor();
  await expectCards(1);
  await expectCategoryCards();
  await expectOpenMenu('mobile');
  assert.equal(await page.getByRole('group', { name: '分级', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert(await nav('mobile').evaluate(node => {
    const menu = node.querySelector('.library-nav__menu').getBoundingClientRect();
    const bar = node.closest('.mobile-nav__bar').getBoundingClientRect();
    return menu.bottom < bar.top && menu.left >= 0 && menu.right <= innerWidth;
  }), 'The open mobile category menu must leave the bottom navigation accessible');
  await saveScreenshot('mobile-category', '390宽匿名福利姬分类保持菜单展开，底部导航仍可操作');
  await nav('mobile').getByRole('button', { name: '展开图库分类' }).click();
  await expectClosedMenu('mobile');
  await nav('mobile').getByRole('button', { name: '展开图库分类' }).click();
  await expectOpenMenu('mobile');
  await page.locator('.mobile-nav').getByRole('link', { name: '搜索', exact: true }).click();
  await page.waitForURL(url => url.hash === '#/explore');
  await expectClosedMenu('mobile');
  await nav('mobile').getByRole('button', { name: '展开图库分类' }).click();
  await expectOpenMenu('mobile');
  await nav('mobile').getByRole('link', { name: '图库', exact: true }).click();
  await page.waitForURL(url => url.hash === '#/library');
  await page.getByRole('group', { name: '分级', exact: true }).waitFor();
  await expectCards(3);
  await expectClosedMenu('mobile');
  // A long all-creators page and an empty category exercise both filter wrapping
  // and the document scrollbar appearing/disappearing. All fixtures stay in memory.
  creators.splice(0, creators.length,
    sample(1, '合成博主甲', ['cosplay', 'portrait'], 'R18'),
    sample(2, '合成博主乙', ['fuliji'], 'R15'),
    ...Array.from({ length: 22 }, (_, index) => sample(index + 3, `合成博主${index + 3}`, [], null)));
  const labelsBeforeLayoutChecks = structuredClone(creators.map(creator => creator.galleryLabels));
  const writesBeforeLayoutChecks = requests.filter(request => request.method !== 'GET').length;
  const readLayout = () => page.locator('main > section').evaluate(section => {
    const bounds = element => {
      const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
      return { x, y, width, height, right, bottom };
    };
    const header = section.querySelector('header');
    const preference = header.querySelector('[aria-label="偏好"]');
    return {
      search: bounds(header.querySelector('form')),
      count: bounds(header.querySelector('[aria-label="博主筛选"] > span:last-child')),
      preference: preference ? bounds(preference) : null,
      results: bounds(header.nextElementSibling),
      scrollbarGutter: getComputedStyle(document.documentElement).scrollbarGutter,
      pageWidth: document.documentElement.clientWidth,
      hasVerticalScroll: document.documentElement.scrollHeight > innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1
    };
  });
  const expectStableLayout = (baseline, current, description) => {
    const comparisons = [['search', ['x', 'y', 'width', 'height']], ['count', ['right', 'y']], ['results', ['x', 'y', 'width']]];
    if (baseline.preference) comparisons.push(['preference', ['x', 'y', 'width', 'height']]);
    for (const [part, coordinates] of comparisons) {
      for (const coordinate of coordinates) assert(Math.abs(baseline[part][coordinate] - current[part][coordinate]) <= 1,
        `${description}: ${part}.${coordinate} moved from ${baseline[part][coordinate]} to ${current[part][coordinate]}`);
    }
    assert.equal(current.horizontalOverflow, false, `${description}: no horizontal overflow`);
  };
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    const variant = viewport.width >= 768 ? 'desktop' : 'mobile';
    await page.setViewportSize(viewport);
    for (const role of ['admin', 'anonymous', 'viewer']) {
      await page.goto(`${entry}?role=${role}#/library`);
      await expectCards(24);
      await page.evaluate(() => document.fonts.ready);
      await expectAllLabels(role);
      if (role === 'admin') {
        await expectClassificationRows(viewport);
        await saveLayoutScreenshot(`classification-${viewport.width}-admin-all`, '全部图库单标签、多标签与编辑按钮同排，未分类博主保留编辑入口');
        await saveScreenshot(`classification-${viewport.width}-multi-label`, '多标签块可内部换行，编辑按钮在旁边', page.locator('[aria-label="博主目录"] article').first());
        await saveScreenshot(`classification-${viewport.width}-single-label`, '单标签与编辑按钮同排', page.locator('[aria-label="博主目录"] article').nth(1));
      }
      if (role !== 'viewer' && viewport.width !== 320) await saveLayoutScreenshot(`layout-${variant}-${role}-all`, '全部图库收起侧栏布局');
      // Expansion now deliberately moves the content. Compare all/category at
      // the same expanded state, and compare return-to-all after full collapse.
      await clearSidebarInteraction();
      await setSidebar(false);
      await settleSidebar();
      const collapsedBaseline = await readLayout();
      await setSidebar(true);
      await nav(variant).getByRole('button', { name: '展开图库分类' }).click();
      await settleSidebar();
      const baseline = await readLayout();
      assert(baseline.hasVerticalScroll, 'The all-creators fixture must need a vertical scrollbar');
      assert.equal(baseline.scrollbarGutter, 'stable');
      layouts.push({ viewport, role, category: 'all', sidebarState: variant === 'desktop' ? 'expanded' : 'hidden', ...baseline });
      for (const [label, title, count] of [['cosplay', 'Cosplay', 1], ['portrait', '写真', 1], ['selfie', '自拍', 0], ['fuliji', '福利姬', 1]]) {
        await nav(variant).getByRole('link', { name: title, exact: true }).click();
        await page.waitForURL(url => url.hash.includes(`label=${label}`));
        await page.getByRole('heading', { level: 1, name: `${title}图库`, exact: true }).waitFor();
        await expectCards(count);
        if (!count) await page.getByText('没有符合当前条件的博主。', { exact: true }).waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const current = await readLayout();
        layouts.push({ viewport, role, category: label, sidebarState: variant === 'desktop' ? 'expanded' : 'hidden', ...current });
        expectStableLayout(baseline, current, `${viewport.width}px ${role} ${title}`);
        await expectCategoryCards();
        assert.equal(await page.locator('main [aria-label="分级"], main button[value="R15"], main button[value="R18"], main [data-test="creator-rating"]').count(), 0,
          'Category pages must remove grading controls and badges from the DOM');
        assert.equal(await page.locator('main [aria-hidden="true"] button, main [aria-hidden="true"] input, main [aria-hidden="true"] a, main [aria-hidden="true"] [tabindex]').count(), 0,
          'Layout placeholders must not contain hidden focus targets');
        if (label === 'selfie') assert.equal(current.hasVerticalScroll, false, 'The empty category fixture must fit without scrolling');
        if (role !== 'viewer' && viewport.width !== 320 && ['cosplay', 'selfie'].includes(label)) {
          await expectOpenMenu(variant);
          await nav(variant).getByRole('button', { name: '展开图库分类' }).click();
          await saveLayoutScreenshot(`layout-${variant}-${role}-${label}`, label === 'selfie' ? '空自拍分类布局保持稳定' : 'Cosplay分类布局保持稳定');
          await setSidebar(true);
          await nav(variant).getByRole('button', { name: '展开图库分类' }).click();
          await settleSidebar();
        }
      }
      await nav(variant).getByRole('link', { name: '图库', exact: true }).click();
      await page.waitForURL(url => url.hash === '#/library');
      await expectCards(24);
      await clearSidebarInteraction();
      await settleSidebar();
      await setSidebar(false);
      expectStableLayout(collapsedBaseline, await readLayout(), `${viewport.width}px ${role} return to all collapsed`);
      await expectAllLabels(role);
    }
  }
  assert.deepEqual(creators.map(creator => creator.galleryLabels), labelsBeforeLayoutChecks, 'Role and category transitions must preserve labels');
  assert.equal(requests.filter(request => request.method !== 'GET').length, writesBeforeLayoutChecks, 'Layout checks must not send label writes');
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ evidence, layouts, classificationRows, sidebarFrames, homeLayouts, storageChecks, requests, errors, unexpected }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', output, screenshots: evidence.length, requests: requests.length, layoutSamples: layouts.length, classificationRows: classificationRows.length,
    sidebarTransitions: sidebarFrames.length, sidebarFrameCount: sidebarFrames.reduce((total, transition) => total + transition.frames.length, 0), homeLayouts: homeLayouts.length, storageChecks,
    scenarios: ['desktop navigation and return', 'explicit click-only sidebar; hover/focus do not expand', 'actual Tab/Enter/Space and rapid reversal without overlap', 'submenu open choice survives global collapse and is hidden from keyboard', 'reload and route persistence; blocked storage fallback', 'real HomeView recent batches remain outside the sidebar at rest and throughout transitions', 'reduced-motion sidebar/content alignment', '767/768 breakpoint and 390 mobile navigation without desktop gap', 'persistent category selections and rendered icons', 'category removes rating and classification row', 'all-gallery public labels and admin-only editing including untagged creators', 'single and multiple labels alongside edit at 1440, 390 and 320 pixels', 'navigation does not persist labels', 'multiple labels and conflict', 'anonymous and viewer privacy', 'mobile navigation accessible with menu open', 'all, outside and Escape dismissal', 'stable search, count and results across categories and scrollbar changes at matching sidebar states'] }));
} catch (error) {
  writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ status: 'FAIL', message: error.message, evidence, layouts, classificationRows, sidebarFrames, homeLayouts, storageChecks, requests, errors, unexpected }, null, 2));
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
