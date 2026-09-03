import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { schemaSql } from '../src/db/schema.js';
import { LocalIngestService, type LocalIngestStatus } from '../src/services/local-ingest-service.js';
import type { LocalIngestSettingsService } from '../src/services/local-ingest-settings-service.js';

describe('LocalIngest grouped and paginated dashboard', () => {
  it('keeps all 558 jobs accessible without returning them in one response', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(schemaSql);
    const now = new Date().toISOString();
    const creatorInsert = database.prepare(
      `INSERT INTO archive_catalog_creators (
         id, canonical_name, normalized_name, preference, effective_rating,
         seed_source, seed_source_creator_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'liked', 'R15', 'test', ?, ?, ?)`
    );
    creatorInsert.run(1, 'Creator Complete', 'creatorcomplete', 'creator-1', now, now);
    creatorInsert.run(2, 'Creator Review', 'creatorreview', 'creator-2', now, now);
    creatorInsert.run(3, 'Creator Current', 'creatorcurrent', 'creator-3', now, now);
    const insert = database.prepare(
      `INSERT INTO local_ingest_jobs (
         creator_id, source_archive_path, source_archive_name, source_archive_size,
         source_archive_mtime, source_archive_sha256, status, phase,
         validation_status, cleanup_status, created_at, updated_at
       ) VALUES (?, ?, ?, 1, 1, ?, ?, ?, 'unknown', 'not_ready', ?, ?)`
    );
    const add = (creatorId: number, count: number, statusFor: (index: number) => LocalIngestStatus) => {
      for (let index = 1; index <= count; index += 1) {
        const status = statusFor(index);
        const phase = status === 'ingested' ? 'done' : status === 'awaiting_review' ? 'mapping' : 'discovered';
        insert.run(
          creatorId,
          `C:\\temp\\creator-${creatorId}\\${index}.7z`,
          `${String(index).padStart(3, '0')}.7z`,
          `${creatorId}-${index}`,
          status,
          phase,
          now,
          now
        );
      }
    };
    add(1, 320, () => 'ingested');
    add(2, 200, (index) => index === 1 ? 'awaiting_review' : 'ingested');
    add(3, 38, (index) => index <= 4 ? 'queued' : 'ingested');

    const service = new LocalIngestService(
      database,
      { get: () => ({ allowlist: [] }) } as unknown as LocalIngestSettingsService
    );
    const summary = service.listJobDashboard({ currentCreatorId: 3 });
    expect(summary.summary.total).toBe(558);
    expect(summary.items).toEqual([]);
    expect(summary.creators.map((creator) => creator.creatorId)).toEqual([3, 2, 1]);
    expect(summary.creators[0]).toMatchObject({ isCurrent: true, total: 38, pending: 4 });

    const page = service.listJobDashboard({ creatorId: 1, page: 3, limit: 50, currentCreatorId: 3 });
    expect(page).toMatchObject({ total: 320, page: 3, limit: 50, hasMore: true });
    expect(page.items).toHaveLength(50);
    expect(page.items.every((job) => job.creatorId === 1)).toBe(true);

    const finalPage = service.listJobDashboard({ creatorId: 1, page: 7, limit: 50 });
    expect(finalPage).toMatchObject({ total: 320, hasMore: false });
    expect(finalPage.items).toHaveLength(20);

    const pending = service.listJobDashboard({ creatorId: 3, status: 'pending', page: 1, limit: 50 });
    expect(pending.total).toBe(4);
    expect(pending.items.every((job) => ['queued', 'reconciling'].includes(job.status))).toBe(true);
    const review = service.listJobDashboard({ creatorId: 2, status: 'awaiting_review' });
    expect(review.total).toBe(1);
    database.close();
  });
});
