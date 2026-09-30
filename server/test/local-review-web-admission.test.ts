import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestTestApp } from './http-test-utils.js';

const closes: Array<() => void> = [];
const roots: string[] = [];
async function fixture(extra: Record<string, Buffer> = { '坏图.jpg': Buffer.alloc(0) }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-web-folder-review-')); roots.push(root);
  const inbox = path.join(root, '等待区'), gallery = path.join(root, '图库');
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('COS_GALLERY_MODE', '1'); vi.stubEnv('PUBLIC_DEMO_MODE', '0');
  for (const [name, location] of Object.entries({ DATA_ROOT: path.join(root, 'data'), DB_DIR: path.join(root, 'db'), GALLERY_ROOT: gallery,
    THUMBNAILS_DIR: path.join(root, 'thumbs'), PREVIEWS_DIR: path.join(root, 'previews') })) {
    vi.stubEnv(name, location); await fs.mkdir(location, { recursive: true });
  }
  await fs.mkdir(inbox); vi.resetModules();
  const { databaseManager } = await import('../src/db/database.js'); closes.push(() => databaseManager.close());
  const db = databaseManager.connection;
  const { localReviewWebSchemaSql } = await import('../src/db/local-review-web-schema.js'); db.exec(localReviewWebSchemaSql);
  const { ManagedCreatorService } = await import('../src/services/managed-creator-service.js');
  const creator = new ManagedCreatorService(db, gallery).create({ name: '审核 中文', rating: 'R15', preference: 'liked' }).id;
  const { LocalFolderAdmissionService } = await import('../src/services/local-folder-admission-service.js');
  const folder = new LocalFolderAdmissionService(db, gallery), name = '审核 中文 NO.032 特殊 [标题]';
  const directory = path.join(inbox, name); await fs.mkdir(directory);
  await sharp({ create: { width: 16, height: 24, channels: 3, background: '#112244' } }).jpeg().toFile(path.join(directory, '正常.jpg'));
  for (const [filename, bytes] of Object.entries(extra)) await fs.writeFile(path.join(directory, filename), bytes);
  const preview = await folder.preview({ creatorId: creator, inputRoot: inbox, directories: [name] });
  const plan = { ...preview, confirmed: true, items: preview.items.map(item => ({ ...item, reason: '隔离用户确认独立作品' })) };
  const { scannerService } = await import('../src/services/scanner-service.js');
  const failure = vi.spyOn(scannerService, 'scanCosCreators').mockRejectedValueOnce(new Error('Synthetic after-move interruption'));
  await expect(folder.apply(plan)).rejects.toThrow('after-move'); failure.mockRestore();
  const { LocalReviewWebService } = await import('../src/services/local-review-web-service.js');
  const web = new LocalReviewWebService(db, { galleryRoot: gallery, admission: folder });
  const { createLocalReviewRouter } = await import('../src/routes/local-review-routes.js');
  const app = express(); app.use(express.json()); app.use('/review', createLocalReviewRouter(web));
  const post = (url: string, body: unknown) => requestTestApp(app, 'POST', `/review${url}`, {}, body);
  const reply = await post('/sessions', { creatorId: creator, target: { kind: 'admission', planId: plan.planId, itemKey: plan.items[0].key }, requestKey: 'prepare-folder' });
  expect(reply.status).toBe(202); const sessionId = reply.body.sessionId as string; await web.wait(sessionId);
  expect(web.get(sessionId).status, web.get(sessionId).error ?? '').toBe('ready');
  const confirm = (choices = [{ relativePath: '坏图.jpg', action: 'quarantine', reason: 'damaged' }]) => post(`/sessions/${sessionId}/execute`, {
    requestKey: 'folder-confirm', confirmed: true, quarantineConfirmed: true, note: '网页明确选择本批列出的文件处置', choices
  });
  return { db, root, gallery, inbox, creator, plan, item: plan.items[0], web, sessionId, confirm, folder, post };
}
afterEach(async () => {
  vi.restoreAllMocks(); for (const close of closes.splice(0)) close(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe.sequential('web precise review preserves original folder admission', () => {
  it.each(['异常.jpg', '异常.png'])('preserves undecodable %s byte-for-byte inside its work and indexes only display media', async filename => {
    const bytes = Buffer.from('synthetic undecodable image bytes'), f = await fixture({ [filename]: bytes });
    const original = f.db.prepare('SELECT * FROM archive_local_admission_plans').get();
    expect(f.web.get(f.sessionId)).toMatchObject({ previewNeedsRefresh: false, continuation: { totalItems: 1, completedItems: 0, pendingItems: 1 } });
    expect(f.web.files(f.sessionId, { issuesOnly: true }).items).toMatchObject([{ relativePath: filename, issue: 'decode_failed', allowedActions: ['retain_original', 'quarantine'] }]);
    expect((await f.confirm([{ relativePath: filename, action: 'retain_original', reason: 'pixel_limit' }])).status).toBe(409);
    const choices = [{ relativePath: filename, action: 'retain_original', reason: 'decode_failed' }];
    expect((await f.confirm(choices)).status).toBe(202); await f.web.wait(f.sessionId);
    expect(f.web.get(f.sessionId)).toMatchObject({ status: 'completed', result: { summary: { images: 1, retainedOriginals: 1, quarantined: 0 } }, continuation: { completedItems: 1, pendingItems: 0 } });
    expect(await fs.readFile(path.join(f.item.targetPath, '_未支持格式原件', filename))).toEqual(bytes);
    await expect(fs.stat(path.join(f.item.targetPath, filename))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.db.prepare('SELECT COUNT(*) n FROM post_items').get()!.n).toBe(1);
    expect(f.db.prepare('SELECT * FROM archive_local_admission_plans').get()).toEqual(original);
    expect(f.db.prepare('SELECT COUNT(*) n FROM local_review_web_file_actions').get()!.n).toBe(0);
    expect((await f.confirm(choices)).status).toBe(202);
    expect(await fs.readFile(path.join(f.item.targetPath, '_未支持格式原件', filename))).toEqual(bytes);
    expect((await f.post(`/sessions/${f.sessionId}/refresh`, { requestKey: 'after-confirm' })).status).toBe(409);
  });

  it('requires explicit refresh of an old unconfirmed preview and does not change its original plan', async () => {
    const f = await fixture({ '异常.jpg': Buffer.from('undecodable original') });
    const original = f.db.prepare('SELECT * FROM archive_local_admission_plans').get();
    const baseline = JSON.parse(String(f.db.prepare('SELECT baseline_json FROM local_review_web_sessions WHERE id=?').get(f.sessionId)!.baseline_json));
    delete baseline.rulesVersion; baseline.files.find((file: {relativePath:string}) => file.relativePath === '异常.jpg').allowedActions = ['quarantine'];
    f.db.prepare('UPDATE local_review_web_sessions SET baseline_json=? WHERE id=?').run(JSON.stringify(baseline), f.sessionId);
    const before = f.db.prepare('SELECT * FROM local_review_web_sessions WHERE id=?').get(f.sessionId);
    expect(f.web.get(f.sessionId).previewNeedsRefresh).toBe(true);
    f.web.files(f.sessionId, { issuesOnly: true });
    expect(f.db.prepare('SELECT * FROM local_review_web_sessions WHERE id=?').get(f.sessionId)).toEqual(before);
    expect((await f.confirm([{ relativePath: '异常.jpg', action: 'quarantine', reason: 'damaged' }])).status).toBe(409);
    expect((await f.post(`/sessions/${f.sessionId}/refresh`, { requestKey: 'refresh-preview' })).status).toBe(202);
    await f.web.wait(f.sessionId);
    expect(f.web.get(f.sessionId)).toMatchObject({ status: 'ready', previewNeedsRefresh: false, confirmed: false });
    expect(f.web.files(f.sessionId, { issuesOnly: true }).items).toMatchObject([{ issue: 'decode_failed', allowedActions: ['retain_original', 'quarantine'] }]);
    expect(f.db.prepare('SELECT * FROM archive_local_admission_plans').get()).toEqual(original);
    expect(await fs.readFile(path.join(f.item.targetPath, '异常.jpg'), 'utf8')).toBe('undecodable original');
  });

  it.each(['EACCES', 'ENOMEM'])('does not turn %s into permission to preserve unreadable media', async code => {
    const f = await fixture({ '异常.jpg': Buffer.from('undecodable original') });
    f.db.prepare("UPDATE local_review_web_sessions SET baseline_json=json_remove(baseline_json,'$.rulesVersion') WHERE id=?").run(f.sessionId);
    const originalRead = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(((filename: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
      if (String(filename) === path.join(f.item.targetPath, '异常.jpg')) return Promise.reject(Object.assign(new Error('Input buffer contains unsupported image format'), { code }));
      return originalRead(filename, ...args as []);
    }) as typeof fs.readFile);
    await f.post(`/sessions/${f.sessionId}/refresh`, { requestKey: `refresh-${code}` }); await f.web.wait(f.sessionId);
    expect(f.web.get(f.sessionId)).toMatchObject({ status: 'failed', confirmed: false });
    expect(f.db.prepare('SELECT state FROM archive_local_admission_items').get()!.state).toBe('files_verified');
    expect(f.db.prepare("SELECT COUNT(*) n FROM archive_catalog_work_decisions WHERE kind='admission_file_removal'").get()!.n).toBe(0);
  });

  it('resumes an interrupted retained-file rename without moving or approving the file twice', async () => {
    const bytes = Buffer.from('undecodable original'), f = await fixture({ '异常.jpg': bytes });
    const rename = fs.rename.bind(fs);
    const interruption = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => { await rename(...args); throw new Error('Synthetic interruption after retained rename'); });
    await f.confirm([{ relativePath: '异常.jpg', action: 'retain_original', reason: 'decode_failed' }]); await f.web.wait(f.sessionId);
    expect(f.web.get(f.sessionId).status).toBe('failed'); interruption.mockRestore();
    f.web.retry(f.sessionId, 'continue-retention'); await f.web.wait(f.sessionId);
    expect(f.web.get(f.sessionId).status, f.web.get(f.sessionId).error ?? '').toBe('completed');
    expect(await fs.readFile(path.join(f.item.targetPath, '_未支持格式原件', '异常.jpg'))).toEqual(bytes);
    expect(f.db.prepare("SELECT COUNT(*) n FROM archive_catalog_work_decisions WHERE kind='admission_file_removal'").get()!.n).toBe(1);
  });

  it('refuses retention when no normal display media would remain', async () => {
    const f = await fixture({ '正常.jpg': Buffer.from('undecodable replacement'), '异常.png': Buffer.from('undecodable png') });
    const choices = ['正常.jpg', '异常.png'].map(relativePath => ({ relativePath, action: 'retain_original', reason: 'decode_failed' }));
    const reply = await f.confirm(choices);
    expect(reply.status).toBe(409); expect(reply.body.message).toContain('没有可正常展示');
    expect(f.web.get(f.sessionId).confirmed).toBe(false);
    await expect(fs.stat(path.join(f.item.targetPath, '_未支持格式原件'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses original recover and actual scoped indexing without creating a Stage3 history', async () => {
    const f = await fixture(); const original = f.db.prepare('SELECT * FROM archive_local_admission_plans').get();
    const identity = f.db.prepare('SELECT work_id,local_work_id FROM archive_local_admission_items').get();
    await f.confirm(); await f.web.wait(f.sessionId);
    expect(f.web.get(f.sessionId).status, f.web.get(f.sessionId).error ?? '').toBe('completed');
    expect(f.db.prepare('SELECT * FROM archive_local_admission_plans').get()).toEqual(original);
    expect(f.db.prepare('SELECT work_id,local_work_id FROM archive_local_admission_items').get()).toEqual(identity);
    expect(f.db.prepare('SELECT state FROM archive_local_admission_items').get()!.state).toBe('completed');
    expect(f.db.prepare('SELECT COUNT(*) n FROM local_ingest_jobs').get()!.n).toBe(0);
    expect(f.db.prepare('SELECT COUNT(*) n FROM post_items').get()!.n).toBe(1);
    expect(f.web.get(f.sessionId).result.summary).toEqual({ images: 1, videos: 0, retainedOriginals: 0, retainedAttachments: 0, quarantined: 1 });
    const file = f.db.prepare('SELECT quarantine_path FROM local_review_web_file_actions').get()!;
    expect(await fs.stat(String(file.quarantine_path))).toBeTruthy();
    expect((await f.confirm()).status).toBe(202); expect(f.db.prepare('SELECT COUNT(*) n FROM archive_catalog_work_decisions WHERE kind=?').get('admission_file_removal')!.n).toBe(1);
    const receipt = f.web.get(f.sessionId).result, read = vi.spyOn(fs, 'lstat');
    expect(f.web.get(f.sessionId).result).toEqual(receipt); expect(read).not.toHaveBeenCalled();
  });

  it('adds a separately confirmed exact advertisement decision without rewriting original approvedAds', async () => {
    const f = await fixture({ '坏图.jpg': Buffer.alloc(0), '广告.url': Buffer.from('[InternetShortcut]\nURL=https://invalid.example'),
      '笔记.txt': Buffer.from('keep'), '附件.pdf': Buffer.from('%PDF-1.4\nkeep') });
    const original = f.db.prepare('SELECT payload_json,content_hash FROM archive_local_admission_plans').get();
    const choices = [{ relativePath: '坏图.jpg', action: 'quarantine', reason: 'damaged' }, { relativePath: '广告.url', action: 'quarantine', reason: 'advertisement' }];
    await f.confirm(choices); await f.web.wait(f.sessionId);
    expect(f.web.get(f.sessionId).status, f.web.get(f.sessionId).error ?? '').toBe('completed');
    expect(await fs.readFile(path.join(f.item.targetPath, '笔记.txt'), 'utf8')).toBe('keep');
    expect(await fs.readFile(path.join(f.item.targetPath, '附件.pdf'), 'utf8')).toContain('PDF');
    expect(f.db.prepare('SELECT payload_json,content_hash FROM archive_local_admission_plans').get()).toEqual(original);
    const decisions = f.db.prepare("SELECT payload_json FROM archive_catalog_work_decisions WHERE kind='admission_file_removal'").all().map(row => JSON.parse(String(row.payload_json)));
    expect(decisions.find(value => value.entry.relativePath === '广告.url')).toMatchObject({ approvedAdvertisement: true });
    expect(f.web.get(f.sessionId).result.summary).toEqual({ images: 1, videos: 0, retainedOriginals: 0, retainedAttachments: 2, quarantined: 2 });
    expect(f.db.prepare('SELECT COUNT(*) n FROM post_items').get()!.n).toBe(1);
  });

  it('retries a failed physical move without recording removal before it actually occurs', async () => {
    const f = await fixture(); const original = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Synthetic file is locked'));
    await f.confirm(); await f.web.wait(f.sessionId); expect(f.web.get(f.sessionId).status).toBe('failed');
    expect(f.db.prepare("SELECT COUNT(*) n FROM archive_catalog_work_decisions WHERE kind='admission_file_removal'").get()!.n).toBe(0);
    expect(await fs.stat(path.join(f.item.targetPath, '坏图.jpg'))).toBeTruthy(); rename.mockRestore();
    const renamed = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('Synthetic response lost after rename'); });
    f.web.retry(f.sessionId, 'retry-1'); await f.web.wait(f.sessionId); expect(f.web.get(f.sessionId).status).toBe('failed'); renamed.mockRestore();
    f.web.retry(f.sessionId, 'retry-2'); await f.web.wait(f.sessionId);
    expect(f.web.get(f.sessionId).status, f.web.get(f.sessionId).error ?? '').toBe('completed');
    expect(f.db.prepare('SELECT COUNT(*) n FROM local_review_web_file_actions').get()!.n).toBe(1);
  });

  it('preserves a real pixel-limit JPEG through the original retainOriginal decision and scanner exclusion', async () => {
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'blue' } }).jpeg().toBuffer();
    for (let offset = 2; offset < bytes.length - 9;) {
      const marker = bytes[offset + 1], size = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) { bytes.writeUInt16BE(32768, offset + 5); bytes.writeUInt16BE(32768, offset + 7); break; } offset += size + 2;
    }
    const f = await fixture({ '原件.jpeg': bytes });
    await f.confirm([{ relativePath: '原件.jpeg', action: 'retain_original', reason: 'pixel_limit' }]); await f.web.wait(f.sessionId);
    expect(f.web.get(f.sessionId).status, f.web.get(f.sessionId).error ?? '').toBe('completed');
    const { RETAINED_ORIGINALS_DIRECTORY } = await import('../src/constants/retained-originals.js');
    expect(await fs.readFile(path.join(f.item.targetPath, RETAINED_ORIGINALS_DIRECTORY, '原件.jpeg'))).toEqual(bytes);
    expect(f.web.get(f.sessionId).result.summary).toEqual({ images: 1, videos: 0, retainedOriginals: 1, retainedAttachments: 0, quarantined: 0 });
    expect(f.db.prepare('SELECT COUNT(*) n FROM post_items').get()!.n).toBe(1);
  });

  it('rejects an in-root directory junction/reparse replacement before touching the approved file', async () => {
    const f = await fixture(); const moved = path.join(f.gallery, 'other'); await fs.rename(f.item.targetPath, moved);
    await fs.symlink(moved, f.item.targetPath, process.platform === 'win32' ? 'junction' : 'dir');
    await f.confirm(); await f.web.wait(f.sessionId);
    expect(f.web.get(f.sessionId).status).toBe('failed'); expect(f.web.get(f.sessionId).error).toMatch(/链接|reparse|safe/i);
    expect(await fs.stat(path.join(moved, '坏图.jpg'))).toBeTruthy();
    expect(f.db.prepare('SELECT COUNT(*) n FROM local_review_web_file_actions').get()!.n).toBe(0);
    await fs.unlink(f.item.targetPath);
  });

  it('rejects a newly occupied quarantine destination and never overwrites it', async () => {
    const f = await fixture(); const location = path.join(f.inbox, '.local-review-attachments', f.sessionId, '坏图.jpg');
    await fs.mkdir(path.dirname(location), { recursive: true }); await fs.writeFile(location, 'unrelated');
    await f.confirm(); await f.web.wait(f.sessionId);
    expect(f.web.get(f.sessionId).status).toBe('failed'); expect(await fs.readFile(location, 'utf8')).toBe('unrelated');
    expect(await fs.stat(path.join(f.item.targetPath, '坏图.jpg'))).toBeTruthy();
  });

  it('cannot use the web review entry to mutate an already completed work', async () => {
    const f = await fixture(); await f.confirm(); await f.web.wait(f.sessionId);
    const overview = f.web.target({ kind: 'admission', planId: f.plan.planId, itemKey: f.item.key }, f.creator);
    expect(overview.eligible).toBe(false); expect(overview.reason).toMatch(/已完成/);
    expect((await f.post('/sessions', { creatorId: f.creator, target: overview.target, requestKey: 'second-session' })).status).toBe(409);
  });

  it('real application mount rejects missing intent, anonymous callers and viewer accounts', async () => {
    const f = await fixture();
    const { createApp } = await import('../src/app.js'); const app = createApp();
    const { authService } = await import('../src/services/auth-service.js');
    const endpoint = `/api/admin/local-review/sessions/${f.sessionId}`;
    expect((await requestTestApp(app, 'POST', endpoint + '/retry', {}, { requestKey: 'forbidden' })).status).toBe(403);
    expect((await requestTestApp(app, 'POST', endpoint + '/refresh', {}, { requestKey: 'forbidden-refresh' })).status).toBe(403);
    authService.setAdminPassword('synthetic-admin-password'); authService.setViewerAccess('password', 'synthetic-viewer-password');
    expect((await requestTestApp(app, 'GET', endpoint)).status).toBe(401);
    const login = await requestTestApp(app, 'POST', '/api/auth/login', { 'x-foldergram-intent': '1' }, { password: 'synthetic-viewer-password' });
    expect(login.status).toBe(200); const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect((await requestTestApp(app, 'GET', endpoint, { cookie })).status).toBe(403);
    expect((await requestTestApp(app, 'POST', endpoint + '/retry', { cookie, 'x-foldergram-intent': '1' }, { requestKey: 'denied' })).status).toBe(403);
    expect((await requestTestApp(app, 'POST', endpoint + '/refresh', { cookie, 'x-foldergram-intent': '1' }, { requestKey: 'denied-refresh' })).status).toBe(403);
    expect(f.web.get(f.sessionId).status).toBe('ready');
  });
});
