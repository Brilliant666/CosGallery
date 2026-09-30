import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schemaSql } from '../src/db/schema.js';
import { localReviewWebSchemaSql } from '../src/db/local-review-web-schema.js';
import { LocalIngestService, type LocalIngestRuntimeDependencies } from '../src/services/local-ingest-service.js';
import type { LocalIngestSettingsService } from '../src/services/local-ingest-settings-service.js';
import { LocalReviewWebService } from '../src/services/local-review-web-service.js';
import { createLocalReviewRouter } from '../src/routes/local-review-routes.js';
import { requestTestApp } from './http-test-utils.js';
import { RETAINED_ORIGINALS_DIRECTORY } from '../src/constants/retained-originals.js';

const fixtures: Array<{ root: string; db: DatabaseSync }> = [];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const slt = (files: Record<string, Buffer>) => 'Path = sample.7z\nType = 7z\n\n----------\n' + Object.entries(files)
  .map(([name, bytes]) => `Path = ${name}\nSize = ${bytes.length}\nCRC = ${crc32(bytes).toString(16).padStart(8, '0').toUpperCase()}\nAttributes = A\n\n`).join('');
const jpeg = () => sharp({ create: { width: 8, height: 12, channels: 3, background: '#2468aa' } }).jpeg().toBuffer();

async function fixture(extra: Record<string, Buffer> = { '坏图.jpg': Buffer.alloc(0) }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-review-web-'));
  const gallery = path.join(root, 'gallery'), inbox = path.join(root, 'inbox'), processing = path.join(root, 'processing');
  for (const dir of [gallery, path.join(inbox, '中文 博主'), processing]) await fs.mkdir(dir, { recursive: true });
  const source = path.join(inbox, '中文 博主', '007.7z'), outer = Buffer.from('outer synthetic'), inner = Buffer.from('inner synthetic');
  await fs.writeFile(source, outer);
  const db = new DatabaseSync(path.join(root, 'db.sqlite')); fixtures.push({ root, db }); db.exec(schemaSql); db.exec(localReviewWebSchemaSql);
  db.exec(`INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,preference,effective_rating,seed_source,seed_source_creator_id)
    VALUES(1,'中文 博主','中文博主','liked','R15','test','review');
    INSERT INTO archive_catalog_collections(id,creator_id,source,source_collection_id,title,observed_at,is_active) VALUES(1,1,'costuan','web','Web','2024-01-01',1);
    INSERT INTO archive_catalog_works(id,creator_id,display_title) VALUES(1,1,'中文 图集');
    INSERT INTO archive_catalog_source_works(id,work_id,collection_id,source,source_work_id,source_order,source_order_label,source_title,raw_title,media_summary,is_active,first_seen_at,last_seen_at)
    VALUES(1,1,1,'costuan','web-7',7,'NO.007','中文 图集','NO.007 中文 图集','2P',1,'2024-01-01','2024-01-01');
    INSERT INTO archive_catalog_download_tasks(id,source_work_id,provider,target_root,target_relative_directory,target_filename,status,claimed_by,attempt_count)
    VALUES(1,1,'baidu','inbox','中文 博主','007.7z','staged','old-worker',3);`);
  const members = { '正常 [1].jpg': await jpeg(), ...extra };
  const settings = { get: () => ({ libraryRoot: gallery, inboxRoot: inbox, processingRoot: processing, sevenZipPath: 'test-7z',
    fileStableSeconds: 1, recycleAfterIngest: false, maxExtractionDepth: 2 as const, allowlist: ['中文 博主'], archivePasswordConfigured: true }), getArchivePassword: () => 'test-password' } as unknown as LocalIngestSettingsService;
  let clock = Date.now(), indexFailures = 0;
  const command: NonNullable<LocalIngestRuntimeDependencies['runCommand']> = async (_exe, args) => {
    expect(args).toContain('-sccUTF-8');
    if (args[0] === 'l') return { code: 0, stdout: slt(args.at(-1) === source ? { '007.7zz': inner } : members), stderr: '' };
    if (args[0] === 't') return { code: 0, stdout: '', stderr: '' };
    const output = args.find(arg => arg.startsWith('-o'))!.slice(2); await fs.mkdir(output, { recursive: true });
    for (const [name, bytes] of Object.entries(path.basename(output) === 'level-1' ? { '007.7zz': inner } : members)) {
      await fs.mkdir(path.dirname(path.join(output, name)), { recursive: true }); await fs.writeFile(path.join(output, name), bytes);
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const scan = async () => {
    if (indexFailures-- > 0) throw new Error('Synthetic indexing interruption');
    const row = db.prepare('SELECT target_path,summary_json FROM local_ingest_jobs WHERE id=1').get()!;
    const target = String(row.target_path), summary = JSON.parse(String(row.summary_json));
    const relative = path.relative(await fs.realpath(gallery), await fs.realpath(target)).split(path.sep).join('/');
    db.prepare("INSERT OR IGNORE INTO folders(id,slug,name,folder_path,role) VALUES(10,'web','web',?,'carousel_source')").run(relative);
    db.prepare("INSERT OR IGNORE INTO posts(id,folder_id,source_path,post_type,sort_timestamp) VALUES(11,10,?,'carousel',1700000000000)").run(relative);
    const files = (await fs.readdir(target)).filter(name => /\.(jpg|jpeg|webp)$/i.test(name));
    for (const [index, name] of files.sort().entries()) {
      const filename = path.join(target, name), bytes = await fs.readFile(filename), stat = await fs.stat(filename), meta = await sharp(filename).metadata();
      db.prepare(`INSERT OR IGNORE INTO images(id,folder_id,filename,extension,relative_path,absolute_path,file_size,width,height,mime_type,checksum_or_fingerprint,mtime_ms,first_seen_at,sort_timestamp,thumbnail_path,preview_path)
        VALUES(?,10,?,?,?,?,?,?,?,'image/jpeg',?,?,'2024-01-01',1700000000000,?,?)`).run(20 + index, name, path.extname(name), `${relative}/${name}`, filename, bytes.length, meta.width!, meta.height!, hash(bytes), stat.mtimeMs, `t${index}`, `p${index}`);
      db.prepare('INSERT OR IGNORE INTO post_items(post_id,image_id,position) VALUES(11,?,?)').run(20 + index, index + 1);
    }
    db.prepare(`INSERT OR IGNORE INTO archive_catalog_local_creator_folders(id,creator_id,root_path,relative_path,absolute_path,folder_name,match_status,match_method,is_active,scanned_at)
      VALUES(30,1,?,'中文 博主',?,'中文 博主','matched','test',1,'2024-01-01')`).run(gallery, path.join(gallery, '中文 博主'));
    db.prepare(`INSERT OR IGNORE INTO archive_catalog_local_works(id,local_creator_folder_id,work_id,post_id,relative_path,absolute_path,folder_name,parsed_source_order,image_count,video_count,total_bytes,match_status,match_method,is_active,scanned_at)
      VALUES(31,30,1,11,?,?,?,7,?,0,?,'matched','test',1,'2024-01-01')`).run(relative, target, path.basename(target), summary.imageCount, summary.totalBytes);
    db.exec("UPDATE archive_catalog_works SET primary_local_work_id=31 WHERE id=1; UPDATE archive_catalog_download_tasks SET status='ingested' WHERE id=1;");
    return { scanRunId: 1, scanStatus: 'completed', scanError: null };
  };
  const ingest = new LocalIngestService(db, settings, undefined, scan, { now: () => new Date(clock), expectedGalleryRoot: gallery, runCommand: command });
  await ingest.scanInbox(); clock += 1100; await ingest.scanInbox();
  const outcome = await ingest.runJob(1); expect(outcome.status, outcome.errorDetail ?? '').toBe('awaiting_review');
  const restart = () => new LocalReviewWebService(db, { galleryRoot: gallery, ingest });
  const web = restart(), app = express(); app.use(express.json()); app.use('/review', createLocalReviewRouter(web));
  const post = (endpoint: string, body: unknown) => requestTestApp(app, 'POST', `/review${endpoint}`, {}, body);
  const open = async () => {
    const reply = await post('/sessions', { target: { kind: 'stage3', jobId: 1 }, creatorId: 1, requestKey: 'open-1' });
    expect(reply.status).toBe(202); await web.wait(reply.body.sessionId);
    expect(web.get(reply.body.sessionId).status, web.get(reply.body.sessionId).error ?? '').toBe('ready'); return reply.body.sessionId as string;
  };
  const confirm = (sessionId: string, choices = [{ relativePath: '坏图.jpg', action: 'quarantine', reason: 'damaged' }]) => post(`/sessions/${sessionId}/execute`, {
    requestKey: 'execute-1', confirmed: true, note: '用户确认精确列出的合成文件范围', quarantineConfirmed: true, choices
  });
  return { root, db, gallery, members, ingest, web, restart, post, open, confirm, levelTwo: path.join(processing, '1', 'level-2'),
    failIndex: () => { indexFailures++; } };
}

afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { f.db.close(); await fs.rm(f.root, { recursive: true, force: true }); } });

describe.sequential('web precise review of original Stage3 jobs', () => {
  it.each(['异常.jpg', '异常.png'])('retains undecodable %s through HTTP and the original Stage3 recovery', async filename => {
    const bytes = Buffer.from('synthetic undecodable image'), f = await fixture({ [filename]: bytes }), sessionId = await f.open();
    expect(f.web.files(sessionId, { issuesOnly: true }).items).toMatchObject([{ issue: 'decode_failed', suggestedAction: 'retain_original' }]);
    expect((await f.confirm(sessionId, [{ relativePath: filename, action: 'retain_original', reason: 'decode_failed' }])).status).toBe(202);
    await f.web.wait(sessionId);
    expect(f.web.get(sessionId).status, f.web.get(sessionId).error ?? '').toBe('completed');
    expect(await fs.readFile(path.join(f.ingest.getJob(1).targetPath!, RETAINED_ORIGINALS_DIRECTORY, filename))).toEqual(bytes);
    expect(f.web.get(sessionId).result.summary).toEqual({ images: 1, videos: 0, retainedOriginals: 1, retainedAttachments: 0, quarantined: 0 });
  });

  it('uses HTTP preview/confirm, recoverably moves the exact bad file and resumes original job once', async () => {
    const f = await fixture(), sessionId = await f.open();
    const history = f.db.prepare('SELECT claimed_by,attempt_count FROM archive_catalog_download_tasks').get();
    const listing = f.web.files(sessionId, { issuesOnly: true }); expect(listing.items).toMatchObject([{ relativePath: '坏图.jpg', issue: 'damaged', size: 0 }]);
    expect(f.ingest.getJob(1).status).toBe('awaiting_review');
    const reply = await f.confirm(sessionId); expect(reply.status).toBe(202);
    await f.web.wait(sessionId); expect(f.web.get(sessionId).status, f.web.get(sessionId).error ?? '').toBe('completed');
    expect(f.web.get(sessionId).result.summary).toEqual({ images: 1, videos: 0, retainedOriginals: 0, retainedAttachments: 0, quarantined: 1 });
    expect(f.ingest.getJob(1).status).toBe('ingested');
    const move = f.db.prepare('SELECT * FROM local_review_web_file_actions').get()!;
    expect(move.state).toBe('moved'); expect((await fs.stat(String(move.quarantine_path))).size).toBe(0);
    const before = f.db.prepare('SELECT * FROM local_ingest_jobs').get();
    expect((await f.confirm(sessionId)).status).toBe(202); expect(f.db.prepare('SELECT * FROM local_ingest_jobs').get()).toEqual(before);
    expect(f.db.prepare('SELECT COUNT(*) n FROM local_ingest_jobs').get()!.n).toBe(1);
    expect(f.db.prepare('SELECT claimed_by,attempt_count FROM archive_catalog_download_tasks').get()).toEqual(history);
    const receipt = f.web.get(sessionId).result, read = vi.spyOn(fs, 'lstat');
    expect(f.restart().get(sessionId).result).toEqual(receipt); expect(f.web.get(sessionId).result).toEqual(receipt);
    expect(read).not.toHaveBeenCalled();
  });

  it('recovers an intent whose rename completed before response/recording failed, without moving again', async () => {
    const f = await fixture(), sessionId = await f.open(), original = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('after-rename simulated crash'); });
    await f.confirm(sessionId); await f.web.wait(sessionId); expect(f.web.get(sessionId).status).toBe('failed');
    expect(f.db.prepare('SELECT state FROM local_review_web_file_actions').get()!.state).toBe('intent'); rename.mockRestore();
    const restarted = f.restart(); restarted.retry(sessionId, 'retry-1'); await restarted.wait(sessionId);
    expect(restarted.get(sessionId).status, restarted.get(sessionId).error ?? '').toBe('completed');
    expect(f.db.prepare('SELECT COUNT(*) n FROM local_review_web_file_actions').get()!.n).toBe(1);
  });

  it('rejects changed contents after preview before any recoverable move', async () => {
    const f = await fixture(), sessionId = await f.open(); await fs.writeFile(path.join(f.levelTwo, '坏图.jpg'), 'replacement');
    await f.confirm(sessionId); await f.web.wait(sessionId);
    expect(f.web.get(sessionId)).toMatchObject({ status: 'failed' }); expect(f.web.get(sessionId).error).toMatch(/变化/);
    expect(f.db.prepare('SELECT COUNT(*) n FROM local_review_web_file_actions').get()!.n).toBe(0);
    expect(f.ingest.getJob(1).status).toBe('awaiting_review');
  });

  it('blocks related acquisition claims and later retries the same immutable request', async () => {
    const f = await fixture(), sessionId = await f.open(); f.db.exec("UPDATE archive_catalog_download_tasks SET status='downloading'");
    await f.confirm(sessionId); await f.web.wait(sessionId); expect(f.web.get(sessionId).status).toBe('failed');
    expect(f.db.prepare('SELECT COUNT(*) n FROM local_review_web_file_actions').get()!.n).toBe(0);
    f.db.exec("UPDATE archive_catalog_download_tasks SET status='downloaded'"); f.web.retry(sessionId, 'retry-claim'); await f.web.wait(sessionId);
    expect(f.web.get(sessionId).status, f.web.get(sessionId).error ?? '').toBe('completed');
  });

  it('does not auto-run a durable interrupted operation on reading status or constructing a service', async () => {
    const f = await fixture(), sessionId = await f.open();
    f.db.prepare("UPDATE local_review_web_sessions SET status='running',owner_pid=NULL WHERE id=?").run(sessionId);
    const restarted = f.restart(); expect(restarted.get(sessionId).status).toBe('interrupted');
    expect(f.ingest.getJob(1).status).toBe('awaiting_review'); expect(await fs.stat(path.join(f.levelTwo, '坏图.jpg'))).toBeTruthy();
    expect(restarted.target({ kind: 'stage3', jobId: 1 }, 1).sessionId).toBe(sessionId);
  });

  it('requires separate file-removal confirmation and rejects foreign identities/arbitrary paths', async () => {
    const f = await fixture(), sessionId = await f.open();
    expect(() => f.web.target({ kind: 'stage3', jobId: 1 }, 2)).toThrow('不属于');
    expect((await f.post(`/sessions/${sessionId}/execute`, { requestKey: 'bad', confirmed: true, note: 'precise',
      choices: [{ relativePath: '坏图.jpg', action: 'quarantine', reason: 'damaged' }] })).status).toBe(409);
    expect((await f.confirm(sessionId, [{ relativePath: '../escape.jpg', action: 'quarantine', reason: 'damaged' }])).status).toBe(400);
    expect((await f.confirm(sessionId, [{ relativePath: '正常 [1].jpg', action: 'quarantine', reason: 'damaged' }])).status).toBe(409);
    expect(f.web.get(sessionId).status).toBe('ready');
  });

  it('preserves original confirmed choices across failure and refuses replacement', async () => {
    const f = await fixture(), sessionId = await f.open(); f.failIndex(); await f.confirm(sessionId); await f.web.wait(sessionId);
    expect(f.web.get(sessionId).status).toBe('failed');
    const row = f.db.prepare('SELECT choices_json,recovery_json FROM local_review_web_sessions WHERE id=?').get(sessionId)!;
    expect((await f.post(`/sessions/${sessionId}/execute`, { requestKey: 'different', confirmed: true, note: 'different', choices: [] })).status).toBe(409);
    f.web.retry(sessionId, 'original-retry'); await f.web.wait(sessionId);
    expect(f.web.get(sessionId).status, f.web.get(sessionId).error ?? '').toBe('completed');
    expect(f.db.prepare('SELECT choices_json,recovery_json FROM local_review_web_sessions WHERE id=?').get(sessionId)).toEqual(row);
  });

  it('retains a PDF without counting it as image while a genuine WebP remains ordinary media', async () => {
    const webp = await sharp(await jpeg()).webp().toBuffer();
    const f = await fixture({ '附件.pdf': Buffer.from('%PDF-1.4\nsynthetic\n%%EOF'), '正常.webp': webp }), sessionId = await f.open();
    expect(f.web.files(sessionId).items.find(file => file.relativePath === '正常.webp')).toMatchObject({ issue: null, allowedActions: [] });
    await f.confirm(sessionId, [{ relativePath: '附件.pdf', action: 'retain_attachment', reason: 'attachment' }]); await f.web.wait(sessionId);
    expect(f.web.get(sessionId).status, f.web.get(sessionId).error ?? '').toBe('completed');
    expect(f.ingest.getJob(1).summary!.imageCount).toBe(2);
    expect(f.web.get(sessionId).result.summary).toEqual({ images: 2, videos: 0, retainedOriginals: 0, retainedAttachments: 1, quarantined: 0 });
    expect(await fs.readFile(path.join(f.ingest.getJob(1).targetPath!, RETAINED_ORIGINALS_DIRECTORY, '附件.pdf'))).toEqual(f.members['附件.pdf' as keyof typeof f.members]);
  });

  it('retains only a decoder-proven JPEG pixel limit without changing decoder limits', async () => {
    const large = Buffer.from(await jpeg());
    for (let offset = 2; offset < large.length - 9;) {
      const marker = large[offset + 1], size = large.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) { large.writeUInt16BE(32768, offset + 5); large.writeUInt16BE(32768, offset + 7); break; }
      offset += 2 + size;
    }
    await expect(sharp(large).metadata()).rejects.toThrow('pixel limit');
    const f = await fixture({ '超限.jpeg': large }), sessionId = await f.open();
    expect(f.web.files(sessionId, { issuesOnly: true }).items).toMatchObject([{ issue: 'pixel_limit', suggestedAction: 'retain_original' }]);
    await f.confirm(sessionId, [{ relativePath: '超限.jpeg', action: 'retain_original', reason: 'pixel_limit' }]); await f.web.wait(sessionId);
    expect(f.web.get(sessionId).status, f.web.get(sessionId).error ?? '').toBe('completed');
    const filename = path.join(f.ingest.getJob(1).targetPath!, RETAINED_ORIGINALS_DIRECTORY, '超限.jpeg');
    expect(await fs.readFile(filename)).toEqual(large); await expect(sharp(filename).metadata()).rejects.toThrow('pixel limit');
    expect(f.web.get(sessionId).result.summary).toEqual({ images: 1, videos: 0, retainedOriginals: 1, retainedAttachments: 0, quarantined: 0 });
  });

  it('leaves an unapproved TXT/URL unchanged and never opens its contents as a URL', async () => {
    const f = await fixture({ '坏图.jpg': Buffer.alloc(0), 'private-notes.txt': Buffer.from('https://invalid.example/not-ad'),
      'keep.url': Buffer.from('[InternetShortcut]\nURL=https://invalid.example/keep'), 'approved.url': Buffer.from('[InternetShortcut]\nURL=https://invalid.example/ad') }), sessionId = await f.open();
    expect(f.web.files(sessionId, { issuesOnly: true }).total).toBe(4);
    expect(await fs.readFile(path.join(f.levelTwo, 'private-notes.txt'), 'utf8')).toContain('not-ad');
    expect(f.web.get(sessionId).confirmed).toBe(false);
    await f.confirm(sessionId, [{ relativePath: '坏图.jpg', action: 'quarantine', reason: 'damaged' },
      { relativePath: 'approved.url', action: 'quarantine', reason: 'advertisement' }]); await f.web.wait(sessionId);
    expect(f.web.get(sessionId).status, f.web.get(sessionId).error ?? '').toBe('completed');
    const job = f.ingest.getJob(1);
    expect(job.summary).toMatchObject({ imageCount: 1, retainedAttachmentCount: 2, retainedOriginalCount: 0 });
    expect(f.web.get(sessionId).result.summary).toEqual({ images: 1, videos: 0, retainedOriginals: 0, retainedAttachments: 2, quarantined: 2 });
    expect(await fs.readFile(path.join(job.targetPath!, RETAINED_ORIGINALS_DIRECTORY, 'private-notes.txt'), 'utf8')).toContain('not-ad');
    expect(await fs.readFile(path.join(job.targetPath!, RETAINED_ORIGINALS_DIRECTORY, 'keep.url'), 'utf8')).toContain('/keep');
    const ad = f.db.prepare('SELECT quarantine_path,state FROM local_review_web_file_actions WHERE relative_path=?').get('approved.url')!;
    expect(ad.state).toBe('moved'); expect(await fs.readFile(String(ad.quarantine_path), 'utf8')).toContain('/ad');
  });

  it('paginates inspected facts without additional archive listings or file reads', async () => {
    const f = await fixture(), sessionId = await f.open();
    const read = vi.spyOn(fs, 'lstat');
    expect(f.web.files(sessionId, { limit: 1, page: 1 }).items).toHaveLength(1);
    expect(f.web.files(sessionId, { limit: 1, page: 2 }).items).toHaveLength(1);
    f.web.get(sessionId); expect(read).not.toHaveBeenCalled();
  });
});
