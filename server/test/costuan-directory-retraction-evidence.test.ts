import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { schemaSql } from '../src/db/schema.js';
import { ArchiveDownloadTaskService } from '../src/services/archive-download-task-service.js';
import { ArchiveMetadataTaskService, type ArchiveMetadataTask } from '../src/services/archive-metadata-task-service.js';
import { parseCostuanDirectoryText } from '../src/services/costuan-numbering-service.js';
import { ManagedCreatorService } from '../src/services/managed-creator-service.js';

describe('Costuan retracted directory evidence is audit-only', () => {
  let db: DatabaseSync;
  let service: ArchiveMetadataTaskService;
  let root: string;
  let creatorId: number;
  const pageUrl = 'https://www.costuan.com/fixture-retractions.html';
  const activeLines = Array.from({ length: 61 }, (_, index) =>
    `Fixture NO.${String(index + 1).padStart(3, '0')} Work ${index + 1} [1P-1MB]`);
  const retiredEntries = [
    { rawTitle: 'Fixture NO.017 Retired revision [2P-2MB]', sourceOrder: 'NO.017', reason: 'strikethrough', markers: ['del'] },
    { rawTitle: 'Fixture NO.037 Retired revision [3P-3MB]', sourceOrder: 'NO.037', reason: 'strikethrough', markers: ['s', 'strike'] }
  ];

  const snapshot = () => JSON.stringify(db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(row => [row.name, db.prepare(`SELECT * FROM "${row.name}" ORDER BY 1`).all()]));

  const claim = (requestId: string) => {
    const result = service.planSelected({ creatorIds: [creatorId], requestId });
    const task = result.items[0].task!;
    return service.claim({ workerId: 'worker', taskIds: result.taskIds,
      rounds: [{ taskId: task.id, checkRoundId: task.checkRoundId! }] })[0];
  };

  const record = (task: ArchiveMetadataTask, lines = activeLines) => ({
    creatorName: 'Fixture',
    costuan: {
      postId: 'fixture-retractions', url: pageUrl,
      title: `Fixture COS写真图片包合集[${lines.length}套][持续更新]`, collectionCount: lines.length,
      // These are synthetic lines, not a claim about a current live collection.
      // Only the effective directory is parsed into works. The original 63 lines
      // and semantic deletion markers remain separately available for auditing.
      resourceDirectoryText: lines.join('\n'),
      resourceDirectoryEvidence: {
        version: 1, pageUrl,
        rawText: [activeLines.slice(0, 16).join('\r\n'), retiredEntries[0].rawTitle,
          activeLines.slice(16, 36).join('\r\n'), retiredEntries[1].rawTitle,
          activeLines.slice(36).join('\r\n')].join('\r\n'),
        excludedEntries: structuredClone(retiredEntries)
      },
      works: lines.flatMap(line => parseCostuanDirectoryText(line)),
      directoryVerification: { complete: true, checkedAt: '2026-09-11T01:00:00Z', parsedWorkCount: lines.length }
    },
    baidu: {
      transport: 'direct-share', status: 'share-verified', shareUrl: 'https://pan.baidu.com/s/1fixture',
      sourceFolderName: 'fixture-retractions',
      verification: { method: 'share-read', complete: true, checkedAt: '2026-09-11T01:00:00Z',
        checkRoundId: task.checkRoundId,
        files: lines.flatMap(line => parseCostuanDirectoryText(line))
          .map(work => `${String(work.order).padStart(3, '0')}.7z`) }
    }
  });

  const request = (task: ArchiveMetadataTask, lines = activeLines) => ({
    id: task.id, workerId: 'worker', canonicalCreatorId: creatorId,
    expectedAttempt: task.attemptCount, receiptId: `retractions-${task.attemptCount}`, record: record(task, lines)
  });

  const expectRejectedWithoutWrites = (payload: ReturnType<typeof request>, error: RegExp) => {
    const before = snapshot();
    expect(() => service.validateDirectory(payload)).toThrow(error);
    expect(snapshot()).toBe(before);
    expect(() => service.complete(payload)).toThrow(error);
    expect(snapshot()).toBe(before);
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'costuan-retraction-evidence-'));
    db = new DatabaseSync(':memory:');
    db.exec(schemaSql);
    service = new ArchiveMetadataTaskService(db);
    creatorId = new ManagedCreatorService(db, path.join(root, 'gallery')).create({ name: 'Fixture', preference: 'liked' }).id;
  });

  afterEach(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('persists all 63 raw lines and both exclusions, while accepting and planning only the 61 effective works', () => {
    const task = claim('effective-directory');
    const payload = request(task);
    const evidence = payload.record.costuan.resourceDirectoryEvidence;
    expect(evidence.rawText.split('\r\n')).toHaveLength(63);
    expect(evidence.excludedEntries).toHaveLength(2);
    const before = snapshot();
    const proof = service.validateDirectory(payload);
    expect(snapshot()).toBe(before);
    expect(proof.canonicalWorks).toHaveLength(61);
    expect(proof.requiredFilenames).toHaveLength(61);
    expect(proof.canonicalWorks.every(work => !work.rawTitle?.includes('Retired revision'))).toBe(true);

    service.complete(payload);
    const collection = db.prepare('SELECT raw_directory_text, metadata_json FROM archive_catalog_collections').get()!;
    const saved = JSON.parse(String(collection.metadata_json));
    expect(collection.raw_directory_text).toBe(payload.record.costuan.resourceDirectoryText);
    expect(saved.resourceDirectoryText).toBe(payload.record.costuan.resourceDirectoryText);
    expect(saved.resourceDirectoryEvidence).toEqual(evidence);
    expect(saved.works).toHaveLength(61);
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_catalog_source_works WHERE is_active=1').get()).toEqual({ n: 61 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM archive_catalog_source_works WHERE raw_title LIKE '%Retired revision%'").get()).toEqual({ n: 0 });

    const downloads = new ArchiveDownloadTaskService(db);
    expect(downloads.planMissing({ creatorIds: [creatorId], targetRoot: path.join(root, 'inbox') }).created).toBe(61);
    expect(downloads.list().items.map(item => item.targetFilename).sort()).toEqual(proof.requiredFilenames.slice().sort());
    const accepted = snapshot();
    service.complete(payload);
    expect(snapshot()).toBe(accepted);
  });

  it('rejects an unstruck duplicate retained in both effective works and directory text', () => {
    const payload = request(claim('unstruck-duplicate'));
    const duplicate = 'Fixture NO.017 Unstruck replacement [4P-4MB]';
    payload.record.costuan.resourceDirectoryText += `\n${duplicate}`;
    payload.record.costuan.works.push(...parseCostuanDirectoryText(duplicate));
    expectRejectedWithoutWrites(payload, /编号重复：NO\.017/);
  });

  it.each(['same-title', 'changed-title', 'forged-exclusion'])
    ('rejects a raw-only %s duplicate even when the supplied works have been deduplicated', mode => {
      const payload = request(claim(`raw-only-${mode}`));
      const duplicate = mode === 'same-title' ? activeLines[16] : 'Fixture NO.017 Unstruck replacement [4P-4MB]';
      payload.record.costuan.resourceDirectoryText += `\n${duplicate}`;
      expect(payload.record.costuan.works).toHaveLength(61);
      if (mode === 'forged-exclusion') {
        payload.record.costuan.resourceDirectoryEvidence.excludedEntries.push({
          rawTitle: duplicate, sourceOrder: 'NO.017', reason: 'strikethrough', markers: ['del']
        });
      }
      expectRejectedWithoutWrites(payload, /重复/);
    });

  it.each(['missing', 'changed-title', 'changed-media'])
    ('does not use excluded evidence to authorize %s historical source data', mode => {
      service.complete(request(claim('historical-source')));
      const downloads = new ArchiveDownloadTaskService(db);
      downloads.planMissing({ creatorIds: [creatorId], targetRoot: path.join(root, 'inbox') });
      downloads.claim({ seedTaskId: downloads.list().items[0].id, workerId: 'download-worker', limit: 1 });
      const lines = [...activeLines];
      if (mode === 'missing') lines.splice(16, 1);
      if (mode === 'changed-title') lines[16] = lines[16].replace('Work 17', 'Different content');
      if (mode === 'changed-media') lines[16] = lines[16].replace('[1P-1MB]', '[5P-5MB]');
      const payload = request(claim(`historical-${mode}`), lines);
      payload.record.costuan.resourceDirectoryEvidence.excludedEntries.push({
        rawTitle: activeLines[16], sourceOrder: 'NO.017', reason: 'strikethrough', markers: ['del']
      });
      expectRejectedWithoutWrites(payload, /已有来源编号缺失、重排或内容声明发生变化/);
    });

  it.each(['works-duplicate', 'raw-extra-number', 'raw-historical-change'])
    ('ignores forged exclusions when checking a %s conflict in the effective input', mode => {
      service.complete(request(claim('before-forged-evidence')));
      const payload = request(claim(`forged-${mode}`));
      let forgedLine = 'Fixture NO.017 Conflicting revision [7P-7MB]';
      if (mode === 'works-duplicate') payload.record.costuan.works.push(...parseCostuanDirectoryText(forgedLine));
      if (mode === 'raw-extra-number') {
        forgedLine = 'Fixture NO.062 Unexpected extra work [1P-1MB]';
        payload.record.costuan.resourceDirectoryText += `\n${forgedLine}`;
      }
      if (mode === 'raw-historical-change') {
        payload.record.costuan.resourceDirectoryText = payload.record.costuan.resourceDirectoryText.replace(activeLines[16], forgedLine);
      }
      payload.record.costuan.resourceDirectoryEvidence.excludedEntries.push({
        rawTitle: forgedLine, sourceOrder: mode === 'raw-extra-number' ? 'NO.062' : 'NO.017',
        reason: 'strikethrough', markers: ['del']
      });
      const error = mode === 'works-duplicate' ? /来源编号重复/
        : mode === 'raw-extra-number' ? /完整核验或声明数量不符/ : /已有来源编号缺失、重排或内容声明发生变化/;
      expectRejectedWithoutWrites(payload, error);
    });
});
