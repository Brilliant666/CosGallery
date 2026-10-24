import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { databaseManager } from '../db/database.js';
import { GALLERY_LABELS, type GalleryLabel } from '../types/gallery-labels.js';
import { ManagedCreatorError } from './managed-creator-service.js';

export const galleryLabelSchema = z.enum(GALLERY_LABELS);
const updateSchema = z.object({
  galleryLabels: z.array(galleryLabelSchema).max(GALLERY_LABELS.length)
    .refine(labels => new Set(labels).size === labels.length, '图库标签不能重复'),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();

/** Metadata only: labels neither classify Works nor change sources or files. */
export class CreatorGalleryLabelService {
  constructor(private readonly database: DatabaseSync = databaseManager.connection) {}

  list(creatorId?: number): Map<number, GalleryLabel[]> {
    const rows = this.database.prepare(`SELECT creator_id,label FROM archive_catalog_creator_gallery_labels
      ${creatorId === undefined ? '' : 'WHERE creator_id=?'}`).all(...(creatorId === undefined ? [] : [creatorId])) as
      Array<{ creator_id: number; label: GalleryLabel }>;
    const result = new Map<number, GalleryLabel[]>();
    for (const row of rows) result.set(row.creator_id, [...(result.get(row.creator_id) ?? []), row.label]);
    for (const [id, labels] of result) result.set(id, GALLERY_LABELS.filter(label => labels.includes(label)));
    return result;
  }

  get(id: number) {
    // One SQLite statement keeps the revision and labels in the same read snapshot.
    const creator = this.database.prepare(`SELECT gallery_labels_revision,
      (SELECT json_group_array(label) FROM archive_catalog_creator_gallery_labels WHERE creator_id=creator.id) AS labels
      FROM archive_catalog_creators creator WHERE id=?`).get(id) as
      { gallery_labels_revision: number; labels: string } | undefined;
    if (!creator) throw new ManagedCreatorError(404, 'CREATOR_NOT_FOUND', '博主不存在');
    const labels = JSON.parse(creator.labels) as string[];
    return {
      galleryLabels: GALLERY_LABELS.filter(label => labels.includes(label)),
      revision: createHash('sha256').update(`creator-gallery-labels:${id}:${creator.gallery_labels_revision}`).digest('hex')
    };
  }

  update(id: number, input: unknown) {
    const data = updateSchema.parse(input);
    const ownsTransaction = !this.database.isTransaction;
    this.database.exec(ownsTransaction ? 'BEGIN IMMEDIATE' : 'SAVEPOINT creator_gallery_labels');
    try {
      const current = this.get(id);
      if (data.expectedRevision !== current.revision) throw new ManagedCreatorError(409,
        'GALLERY_LABELS_CHANGED', '图库标签已被其他操作修改，请重新读取后保存');
      this.database.prepare('DELETE FROM archive_catalog_creator_gallery_labels WHERE creator_id=?').run(id);
      const insert = this.database.prepare('INSERT INTO archive_catalog_creator_gallery_labels(creator_id,label) VALUES(?,?)');
      for (const label of GALLERY_LABELS.filter(label => data.galleryLabels.includes(label))) insert.run(id, label);
      this.database.prepare('UPDATE archive_catalog_creators SET gallery_labels_revision=gallery_labels_revision+1 WHERE id=?').run(id);
      const result = this.get(id);
      this.database.exec(ownsTransaction ? 'COMMIT' : 'RELEASE creator_gallery_labels');
      return result;
    } catch (error) {
      this.database.exec(ownsTransaction ? 'ROLLBACK' : 'ROLLBACK TO creator_gallery_labels; RELEASE creator_gallery_labels');
      throw error;
    }
  }
}
