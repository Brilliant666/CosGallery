#!/usr/bin/env node
/**
 * Read-only browser benchmark against an independently configured localhost server.
 * Never use production 4141. Private samples/results must remain in ignored storage.
 *
 * BROWSER_NODE_MODULES=/absolute/node_modules node scripts/perf/gallery-browser.mjs
 *   --url=http://127.0.0.1:4411 --samples=.mocks/perf/samples.json --out=.mocks/perf/browser.json
 *
 * Sample shape (IDs/paths below are placeholders, not a bundled private fixture):
 * { clockTime: "2026-01-01T12:00:00Z",
 *   library: { targetPaths: ["/thumbnails/xx/cover.webp"], returnCreatorId: 1 },
 *   ordinary: { creatorId: 1, postId: 2, mediaId: 3,
 *     targetPaths: ["/thumbnails/xx/cover.webp"], workTargetPaths: ["/thumbnails/xx/image.webp"] },
 *   multi: { creatorId: 4, postId: 5, mediaId: 6,
 *     targetPaths: ["/thumbnails/xx/cover.webp"], workTargetPaths: ["/thumbnails/xx/image.webp"], pagination: true },
 *   large: { creatorId: 1, postId: 7, mediaId: 8,
 *     targetPaths: ["/thumbnails/xx/image.webp"], previewPath: "/previews/xx/image.webp" } }
 * All target paths identify a fixed first-viewport image set, excluding ?v=.
 * Disk derivatives must already exist in both isolated runs. This program does not
 * generate/cache fixtures or modify the database. It only performs UI reads.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const split = arg.indexOf('=');
  return split < 0 ? [arg.replace(/^--/, ''), true] : [arg.slice(2, split), arg.slice(split + 1)];
}));
if (args.help) {
  console.log('Usage: node scripts/perf/gallery-browser.mjs --url=http://127.0.0.1:PORT --samples=IGNORED.json --out=IGNORED.json [--iterations=5] [--cases=library,ordinary,multi,large,deep] [--interaction-only|--performance-only] [--warmup-only]');
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const origin = new URL(String(args.url));
assert(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Only an isolated localhost server is permitted');
assert(origin.protocol === 'http:' && origin.port && origin.port !== '4141', 'Use an explicit isolated HTTP port, never production 4141');
assert(origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password);
const outFile = path.resolve(root, String(args.out));
const sampleFile = path.resolve(root, String(args.samples));
for (const file of [outFile, sampleFile]) {
  execFileSync('git', ['check-ignore', '--quiet', '--', file], { cwd: root, stdio: 'pipe' });
}
const samples = JSON.parse(await readFile(sampleFile, 'utf8'));
const iterations = Number(args.iterations ?? 5);
assert(Number.isInteger(iterations) && iterations >= 5, 'At least five measured iterations are required');
const requireBrowser = createRequire(path.join(process.env.BROWSER_NODE_MODULES ?? path.join(root, 'node_modules'), '__gallery_benchmark__.cjs'));
const { chromium } = requireBrowser('playwright');
const timeout = Number(args.timeout ?? 90000);
assert(!(args['interaction-only'] && args['performance-only']), 'Choose only one phase restriction');
const viewer = '.work-gallery__viewer';
const gridCard = '.work-media-card';
const fixedPaths = values => {
  assert(Array.isArray(values) && values.length > 0, 'A non-empty, fixed image target set is required');
  return values.map(value => {
    const parsed = new URL(value, origin);
    assert(parsed.origin === origin.origin && /^\/(thumbnails|previews)\//.test(parsed.pathname));
    return parsed.pathname;
  });
};
for (const key of ['ordinary', 'multi', 'large']) {
  for (const field of ['creatorId', 'postId', 'mediaId']) assert(Number.isSafeInteger(samples[key]?.[field]) && samples[key][field] > 0, `${key}.${field} required`);
}
const workPath = sample => `/library/${sample.creatorId}/works/${sample.postId}`;
const cases = [
  { name: 'library', pathname: '/library', selector: '[aria-label="博主目录"] > a', kind: 'library', returnCreatorId: samples.library.returnCreatorId, targetPaths: fixedPaths(samples.library.targetPaths) },
  ...['ordinary', 'multi'].map(name => ({ name, pathname: `/library/${samples[name].creatorId}`, selector: `a[href^="/library/${samples[name].creatorId}/works/"]`, kind: 'creator', sample: samples[name], targetPaths: fixedPaths(samples[name].targetPaths) })),
  { name: 'large', pathname: workPath(samples.large), selector: gridCard, kind: 'work', sample: samples.large, targetPaths: fixedPaths(samples.large.targetPaths) },
  { name: 'deep', pathname: `${workPath(samples.large)}?media=${samples.large.mediaId}`, selector: `${viewer} .viewer__media img`, kind: 'viewer', sample: samples.large, targetPaths: fixedPaths([samples.large.previewPath]) }
].filter(value => !args.cases || String(args.cases).split(',').includes(value.name));
assert(cases.length > 0, 'No selected cases');

// This hook rejects write requests without Playwright routing (routing disables
// HTTP cache and would invalidate the same-session comparison).
function browserInit(clockTime) {
  // Freeze only civil time used by the sidebar's daily selection seed. Playwright's
  // full clock shim also changes Performance APIs, which must remain native here.
  if (clockTime) {
    const NativeDate = window.Date;
    const fixed = NativeDate.parse(clockTime);
    if (!Number.isFinite(fixed)) throw new Error('clockTime must be a valid date');
    let FixedDate;
    FixedDate = new Proxy(NativeDate, {
      apply: () => new NativeDate(fixed).toString(),
      construct: (target, values, newTarget) => Reflect.construct(target, values.length ? values : [fixed], newTarget === FixedDate ? target : newTarget),
      get: (target, key, receiver) => key === 'now' ? () => fixed : Reflect.get(target, key, receiver)
    });
    window.Date = FixedDate;
  }
  const allowRead = method => {
    if (!['GET', 'HEAD'].includes(String(method ?? 'GET').toUpperCase())) throw new Error('Benchmark blocked non-read HTTP method');
  };
  const nativeFetch = window.fetch;
  window.fetch = function(input, init) { allowRead(init?.method ?? (input instanceof Request ? input.method : 'GET')); return nativeFetch.call(this, input, init); };
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, ...rest) { allowRead(method); return nativeOpen.call(this, method, ...rest); };
  navigator.sendBeacon = () => { throw new Error('Benchmark blocked sendBeacon'); };
  document.addEventListener('submit', event => event.preventDefault(), true);
  window.__galleryImageErrors = [];
  document.addEventListener('error', event => {
    if (!(event.target instanceof HTMLImageElement)) return;
    const image = event.target;
    window.__galleryImageErrors.push({ page: location.pathname + location.search, src: image.currentSrc || image.src, alt: image.alt,
      className: image.className, ancestors: [...(function* () { let element = image.parentElement; for (let i = 0; element && i < 5; i += 1, element = element.parentElement) yield { tag: element.tagName, className: element.className, href: element.getAttribute('href') }; })()] });
  }, true);
  performance.setResourceTimingBufferSize(20000);
  window.__galleryMeasure = null;
  window.__galleryStartMeasure = config => {
    window.__galleryMeasure?.disconnect();
    const state = { start: performance.now(), cardsMs: null, cardsPending: false, imagesMs: null, targets: [], cardCount: 0, done: false };
    const visible = element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    };
    const check = () => {
      if (location.pathname !== config.pathname.split('?')[0]) return;
      if (config.kind === 'creator' && document.querySelector('.work-gallery')) return;
      if (config.kind === 'viewer' && !document.querySelector('.work-gallery__viewer')) return;
      if (config.kind === 'work' && document.querySelector('.work-gallery__viewer')) return;
      const cards = [...document.querySelectorAll(config.selector)].filter(visible);
      if (cards.length && state.cardsMs === null && !state.cardsPending) {
        state.cardsPending = true;
        // Two animation frames allow the visible DOM an actual rendering opportunity;
        // this is not claimed to be Chromium's trace-based first-contentful-paint.
        requestAnimationFrame(() => requestAnimationFrame(() => { state.cardsMs = performance.now() - state.start; check(); }));
      }
      state.cardCount = document.querySelectorAll(config.selector).length;
      const all = [...document.images];
      state.targets = config.targetPaths.map(target => {
        const image = all.find(img => new URL(img.currentSrc || img.src || '/', location.href).pathname === target && visible(img));
        return { path: target, visible: Boolean(image), loaded: Boolean(image?.complete && image.naturalWidth > 0), naturalWidth: image?.naturalWidth ?? 0, naturalHeight: image?.naturalHeight ?? 0 };
      });
      if (cards.length && state.cardsMs !== null && state.targets.every(item => item.loaded)) {
        if (state.imagesMs === null) state.imagesMs = performance.now() - state.start;
        state.done = true;
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class', 'style'] });
    document.addEventListener('load', check, true);
    document.addEventListener('error', check, true);
    const timer = setInterval(check, 16);
    state.disconnect = () => { observer.disconnect(); clearInterval(timer); document.removeEventListener('load', check, true); document.removeEventListener('error', check, true); };
    window.__galleryMeasure = state;
    check();
  };
}

const browser = await chromium.launch({ headless: !args.headed });
const result = {
  schemaVersion: 1, createdAt: new Date().toISOString(), origin: origin.origin,
  browser: browser.version(), node: process.version, viewport: { width: 1440, height: 1000 },
  conditions: { derivatives: 'pre-existing isolated disk cache supplied by caller', first: 'new browser context; no browser HTTP or application memory cache', return: 'same context; application reading state and HTTP cache retained', externalFonts: 'Google Fonts blocked using CDP, identical in both runs', fixedWallClock: samples.clockTime ?? null, dateMethod: 'window.Date proxy only; argument constructors, parse and UTC preserved', performanceClock: 'native performance and timers; no Playwright clock shim', warmup: 1, measuredIterations: iterations, noHttpRouting: true, resourceBytes: 'Native Resource Timing transferSize includes encoded body plus protocol overhead; encodedBodySize is compressed body; decodedBodySize is uncompressed. HTTP-cache transferSize can be zero.' },
  runs: [], interactions: [], failures: []
};

async function newPage(config) {
  const context = await browser.newContext({ viewport: result.viewport, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', colorScheme: 'light', serviceWorkers: 'block' });
  // A single init script avoids depending on unspecified ordering between hooks.
  await context.addInitScript({ content: `(${browserInit.toString()})(${JSON.stringify(samples.clockTime ?? null)});${config ? `window.__galleryStartMeasure(${JSON.stringify(config)}); window.__galleryMeasure.start = 0;` : ''}` });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*'] });
  const events = { requests: [], responses: [], errors: [], failed: [], cancelled: [] };
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === origin.origin) {
      events.requests.push({ url: url.pathname + url.search, method: request.method() });
      if (!['GET', 'HEAD'].includes(request.method())) events.errors.push(`Unexpected method ${request.method()} ${url.pathname}`);
    }
  });
  page.on('response', response => { const url = new URL(response.url()); if (url.origin === origin.origin && response.status() >= 400) events.responses.push({ path: url.pathname, status: response.status() }); });
  page.on('pageerror', error => events.errors.push(error.message));
  page.on('requestfailed', request => {
    const url = new URL(request.url());
    if (url.origin === origin.origin) {
      const error = request.failure()?.errorText;
      (error === 'net::ERR_ABORTED' ? events.cancelled : events.failed).push({ path: url.pathname, error });
    }
  });
  return { context, page, events };
}

async function finishMeasure(page, events, startRequestIndex = 0) {
  await page.waitForFunction(() => window.__galleryMeasure?.done, null, { timeout });
  // All target images are decoded/loaded; do not wait on offscreen lazy assets.
  const metrics = await page.evaluate(() => {
    const { start, cardsMs, imagesMs, targets, cardCount } = window.__galleryMeasure;
    const end = performance.now();
    const resources = performance.getEntriesByType('resource').filter(entry => entry.startTime >= start && entry.responseEnd <= end).map(entry => ({
      path: new URL(entry.name).pathname, initiatorType: entry.initiatorType,
      startMs: entry.startTime - start, waitMs: entry.responseStart - entry.requestStart,
      durationMs: entry.duration, transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize
    }));
    window.__galleryMeasure.disconnect();
    return { cardsMs, imagesMs, targets, cardCount, resources };
  });
  metrics.requests = events.requests.slice(startRequestIndex);
  metrics.apiRequests = metrics.requests.filter(request => request.url.startsWith('/api/'));
  if (metrics.apiRequests.length > 0) assert(metrics.resources.some(entry => entry.path.startsWith('/api/')), 'Native Resource Timing must contain completed API entries');
  metrics.apiBytes = metrics.resources.filter(entry => entry.path.startsWith('/api/')).reduce((sum, entry) => ({ transferSize: sum.transferSize + entry.transferSize, encodedBodySize: sum.encodedBodySize + entry.encodedBodySize, decodedBodySize: sum.decodedBodySize + entry.decodedBodySize }), { transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 });
  return metrics;
}

async function sameSessionReturn(config, session) {
  const { page, events } = session;
  let openedWork = null;
  if (config.kind === 'library') {
    assert(Number.isSafeInteger(config.returnCreatorId), 'library.returnCreatorId must identify a first-screen creator with prepared covers');
    const entry = page.locator(`${config.selector}[href="/library/${config.returnCreatorId}"]`);
    const box = await entry.boundingBox();
    assert(box && box.y >= 0 && box.y < result.viewport.height, 'Library return fixture must be in the initial viewport');
    await entry.click();
    await page.locator(`a[href^="/library/${config.returnCreatorId}/works/"]`).first().waitFor();
    await page.locator('a[href^="/library"]').filter({ hasText: '返回我的图库' }).waitFor();
  } else if (config.kind === 'creator') {
    const openConfig = { pathname: workPath(config.sample), selector: gridCard, kind: 'work', targetPaths: fixedPaths(config.sample.workTargetPaths) };
    const openRequestStart = events.requests.length;
    await page.evaluate(value => window.__galleryStartMeasure(value), openConfig);
    await page.locator(`a[href^="${workPath(config.sample)}"]`).first().click();
    openedWork = await finishMeasure(page, events, openRequestStart);
  } else if (config.kind === 'work') {
    await page.locator(`${gridCard} a`).first().click();
    await page.locator(`${viewer} .viewer`).waitFor();
  } else {
    await page.locator(`${viewer} .viewer__modal-close`).click();
    await page.locator(viewer).waitFor({ state: 'detached' });
  }
  const requestStart = events.requests.length;
  await page.evaluate(value => window.__galleryStartMeasure(value), config);
  if (config.kind === 'library') await page.locator('a[href^="/library"]').filter({ hasText: '返回我的图库' }).click();
  else if (config.kind === 'creator') await page.locator('.work-gallery__back').click();
  else if (config.kind === 'work') await page.locator(`${viewer} .viewer__modal-close`).click();
  else await page.locator(`${gridCard}[data-media-id="${config.sample.mediaId}"] a`).click();
  return { ...await finishMeasure(page, events, requestStart), ...(openedWork ? { openedWork } : {}) };
}

async function performanceCase(config, iteration) {
  const session = await newPage(config);
  const entry = { case: config.name, iteration, warmup: iteration === 0 };
  try {
    await session.page.goto(new URL(config.pathname, origin).href, { waitUntil: 'domcontentloaded', timeout });
    entry.freshContext = await finishMeasure(session.page, session.events);
    entry.sameSessionReturn = await sameSessionReturn(config, session);
    entry.errors = session.events;
    assert.deepEqual(session.events.errors, [], 'Page JS or read-only guard errors');
    assert.deepEqual(session.events.responses, [], 'HTTP error responses');
    assert.deepEqual(session.events.failed, [], 'Failed same-origin requests');
  } catch (error) {
    entry.error = String(error.stack ?? error);
    entry.diagnostic = await session.page.evaluate(() => ({ url: location.pathname + location.search, imageErrors: window.__galleryImageErrors, measure: window.__galleryMeasure ? { cardsMs: window.__galleryMeasure.cardsMs, targets: window.__galleryMeasure.targets, cardCount: window.__galleryMeasure.cardCount } : null })).catch(() => null);
    result.failures.push({ case: config.name, iteration, error: error.message });
  } finally {
    result.runs.push(entry);
    await session.context.close();
  }
  console.log(JSON.stringify({ case: config.name, iteration, freshMs: entry.freshContext?.imagesMs, returnMs: entry.sameSessionReturn?.imagesMs, error: entry.error?.split('\n')[0], ...(entry.error ? { responses: session.events.responses, failed: session.events.failed, errors: session.events.errors } : {}) }));
  if (entry.error) throw new Error(`Browser ${config.name} iteration ${iteration} failed; inspect saved diagnostic before retrying`);
}

async function interactions(sample, name) {
  const session = await newPage();
  const { page, events } = session;
  const checks = { name };
  const detailPath = `/api/cos-gallery/creators/${sample.creatorId}/works/${sample.postId}`;
  const countDetails = () => events.requests.filter(entry => entry.url.split('?')[0] === detailPath).length;
  try {
    await page.goto(new URL(`/library/${sample.creatorId}`, origin).href, { waitUntil: 'domcontentloaded', timeout });
    const firstCard = page.locator(`a[href^="${workPath(sample)}"]`).first();
    await firstCard.waitFor();
    checks.cardRatio = await firstCard.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.width / rect.height; });
    assert(Math.abs(checks.cardRatio - 2 / 3) < 0.005, 'Work card must remain 2:3');
    const creatorCards = page.locator(`a[href^="/library/${sample.creatorId}/works/"]`);
    if (sample.pagination) {
      const firstPageCount = await creatorCards.count();
      assert.equal(firstPageCount, 24, 'Pagination fixture requires one initial page of 24 works');
      await creatorCards.last().scrollIntoViewIfNeeded();
      await page.waitForFunction(id => document.querySelectorAll(`a[href^="/library/${id}/works/"]`).length > 24, sample.creatorId, { timeout });
      await page.waitForFunction(() => Number(new URL(location.href).searchParams.get('loaded')) >= 2, null, { timeout });
      checks.loadedPages = Number(new URL(page.url()).searchParams.get('loaded'));
    }
    const cardIdsBefore = await creatorCards.evaluateAll(elements => elements.map(element => new URL(element.href).pathname));
    await page.evaluate(() => window.scrollTo(0, 400));
    const scrollBefore = await page.evaluate(() => scrollY);
    // Click its visible portion without Playwright scrolling the source card first,
    // otherwise the test would compare against a scroll position it changed itself.
    const box = await firstCard.boundingBox();
    assert(box && box.y + box.height > 100 && box.y < result.viewport.height);
    const clickTop = Math.max(100, box.y);
    const clickBottom = Math.min(result.viewport.height - 20, box.y + box.height);
    await page.mouse.click(box.x + box.width / 2, (clickTop + clickBottom) / 2);
    await page.locator(gridCard).first().waitFor();
    checks.detailsAfterOpen = countDetails();
    assert.equal(checks.detailsAfterOpen, 1, 'Only selected work detail should be fetched once');
    const mediaIds = await page.locator(gridCard).evaluateAll(elements => elements.map(element => Number(element.dataset.mediaId)));
    checks.mediaCount = mediaIds.length;
    const selected = page.locator(`${gridCard}[data-media-id="${sample.mediaId}"] a`);
    await selected.click();
    await page.locator(`${viewer} .viewer`).waitFor();
    await page.waitForFunction(id => new URL(location.href).searchParams.get('media') === String(id), sample.mediaId);
    const stage = page.locator(`${viewer} [aria-roledescription="carousel"]`);
    await stage.waitFor();
    const activeImage = stage.locator('img').first();
    await activeImage.waitFor();
    await page.waitForFunction(() => { const image = document.querySelector('.work-gallery__viewer [aria-roledescription="carousel"] img'); return image?.complete && image.naturalWidth > 0; }, null, { timeout });
    checks.viewer = await stage.evaluate(element => { const image = element.querySelector('img'); const rect = element.getBoundingClientRect(); return { styleRatio: getComputedStyle(element).aspectRatio, boxRatio: rect.width / rect.height, objectFit: image ? getComputedStyle(image).objectFit : null, width: Number(image?.getAttribute('width')), height: Number(image?.getAttribute('height')) }; });
    assert.equal(checks.viewer.objectFit, 'contain');
    const cssRatio = checks.viewer.styleRatio.split('/').map(Number);
    assert(Math.abs(cssRatio[0] / cssRatio[1] - checks.viewer.width / checks.viewer.height) < 0.005, 'Viewer must retain selected media aspect ratio');
    const position = mediaIds.indexOf(sample.mediaId);
    const expectedNext = mediaIds[position + 1] ?? mediaIds[position - 1];
    if (expectedNext) {
      await stage.focus();
      await page.keyboard.press(mediaIds[position + 1] ? 'ArrowRight' : 'ArrowLeft');
      await page.waitForFunction(id => new URL(location.href).searchParams.get('media') === String(id), expectedNext);
      checks.switchedMediaId = expectedNext;
    }
    await page.locator(`${viewer} .viewer__modal-close`).click();
    await page.locator(viewer).waitFor({ state: 'detached' });
    checks.detailsAfterViewerClose = countDetails();
    assert.equal(checks.detailsAfterViewerClose, 1, 'Viewer open/switch/close must not refetch detail');
    await page.locator('.work-gallery__back').click();
    await firstCard.waitFor();
    await page.waitForFunction(y => Math.abs(scrollY - y) <= 3, scrollBefore);
    checks.scrollBefore = scrollBefore;
    checks.scrollAfter = await page.evaluate(() => scrollY);
    const cardIdsAfter = await page.locator(`a[href^="/library/${sample.creatorId}/works/"]`).evaluateAll(elements => elements.map(element => new URL(element.href).pathname));
    assert.deepEqual(cardIdsAfter, cardIdsBefore, 'Returning must preserve already loaded work order');
    checks.returnedCardCount = cardIdsAfter.length;
    assert.deepEqual(events.errors, []);
    assert.deepEqual(events.responses, []);
    assert.deepEqual(events.failed, []);
    checks.passed = true;
  } catch (error) {
    checks.error = String(error.stack ?? error);
    result.failures.push({ interaction: name, error: error.message });
  } finally { checks.events = events; result.interactions.push(checks); await session.context.close(); }
}

function summarize(numbers) {
  const sorted = numbers.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return { n: sorted.length, median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, min: sorted[0], max: sorted.at(-1) };
}
try {
  if (!args['interaction-only']) for (const config of cases) for (let i = 0; i <= (args['warmup-only'] ? 0 : iterations); i += 1) await performanceCase(config, i);
  if (!args['performance-only']) for (const name of ['ordinary', 'multi']) if (cases.some(entry => entry.name === name)) await interactions(samples[name], name);
  result.summary = Object.fromEntries(cases.map(config => {
    const runs = result.runs.filter(run => run.case === config.name && !run.warmup);
    const modes = { freshContext: run => run.freshContext, sameSessionReturn: run => run.sameSessionReturn };
    if (config.kind === 'creator') modes.openedWork = run => run.sameSessionReturn?.openedWork;
    return [config.name, Object.fromEntries(Object.entries(modes).map(([name, get]) => [name,
      Object.fromEntries(['cardsMs', 'imagesMs'].map(metric => [metric, summarize(runs.map(run => get(run)?.[metric]))]))]))];
  }));
} finally {
  await browser.close();
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify({ output: outFile, failures: result.failures.length, summary: result.summary }));
if (result.failures.length) process.exitCode = 1;
