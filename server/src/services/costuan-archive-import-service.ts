import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { folderRepository, postRepository } from '../db/repositories.js';
import { databaseManager } from '../db/database.js';
import { ArchiveCatalogService } from './archive-catalog-service.js';
import {
  mergeCostuanDirectoryWorks,
  parseCostuanNumbering
} from './costuan-numbering-service.js';

const costuanWorkSchema = z.object({
  order: z.number().int().min(0).optional(),
  sourceOrder: z.string().trim().min(1),
  sourceOrderKey: z.string().optional(),
  label: z.string().trim().min(1),
  rawTitle: z.string().optional(),
  mediaSummary: z.string().optional()
}).passthrough();

const costuanRecordSchema = z.object({
  creatorName: z.string().trim().min(1),
  aliases: z.array(z.string()).default([]),
  costuan: z.object({
    postId: z.string(),
    resourceDirectoryText: z.string().optional(),
    works: z.array(costuanWorkSchema).default([])
  }).passthrough(),
  local: z.object({ folderName: z.string().optional() }).nullable().optional()
});

const costuanArchiveSchema = z.object({
  format: z.literal('costuan-archive-metadata'),
  version: z.number().int().positive(),
  records: z.record(costuanRecordSchema)
});

export type CostuanArchiveImportResult = {
  source: 'costuan';
  imported: number;
  matchedCreators: number;
  unmatchedCreators: string[];
  unmatchedWorks: string[];
};

export function parseCostuanSourceOrder(value: string): number | null {
  const leaf = path.posix.basename(value.replace(/\\/g, '/'));
  return parseCostuanNumbering(leaf)?.order ?? null;
}

export function parseCostuanSourceKey(value: string): string | null {
  const leaf = path.posix.basename(value.replace(/\\/g, '/'));
  return parseCostuanNumbering(leaf)?.key ?? null;
}

export function buildCostuanWorkCaption(creatorName: string, label: string): string {
  const displayLabel = label.trim().replace(/([\p{Script=Han}])\d+\.\d+$/u, '$1').trim();
  return `${creatorName.trim()} ${displayLabel}`.trim();
}

export async function importCostuanArchiveMetadata(filePath: string): Promise<CostuanArchiveImportResult> {
  const document = costuanArchiveSchema.parse(JSON.parse(await fs.readFile(filePath, 'utf8')));
  // Source metadata joins the existing managed roster; unknown creators are not seeded.
  await new ArchiveCatalogService().importCostuanArchive(filePath);
  const localCreators = folderRepository.getAll().filter((folder) => folder.role === 'normal');
  const result: CostuanArchiveImportResult = {
    source: 'costuan',
    imported: 0,
    matchedCreators: 0,
    unmatchedCreators: [],
    unmatchedWorks: []
  };

  for (const record of Object.values(document.records)) {
    const mergedWorks = mergeCostuanDirectoryWorks(
      record.costuan.works,
      record.costuan.resourceDirectoryText
    );
    if (mergedWorks.length === 0) continue;
    const canonical = databaseManager.connection.prepare(`SELECT creators.id, creators.canonical_name
      FROM archive_catalog_collections collections JOIN archive_catalog_creators creators ON creators.id=collections.creator_id
      WHERE collections.source='costuan' AND collections.source_collection_id=?`).get(record.costuan.postId) as {id:number;canonical_name:string}|undefined;
    const links = canonical ? databaseManager.connection.prepare(`SELECT gallery_folder_id FROM archive_catalog_local_creator_folders
      WHERE creator_id=? AND is_active=1 AND match_status='matched' AND gallery_folder_id IS NOT NULL`).all(canonical.id) as Array<{gallery_folder_id:number}> : [];
    const creators = localCreators.filter(folder => links.some(link => link.gallery_folder_id===folder.id));
    if (!canonical || !creators.length) {
      result.unmatchedCreators.push(record.creatorName);
      continue;
    }

    result.matchedCreators += 1;
    const worksByKey = new Map<string, z.infer<typeof costuanWorkSchema>>();
    for (const work of mergedWorks) {
      const key = work.sourceOrderKey ?? parseCostuanSourceKey(work.sourceOrder);
      if (key) worksByKey.set(key, work);
    }

    for (const post of creators.flatMap(creator => postRepository.listCarouselRecordsByFolder(creator.id))) {
      const key = parseCostuanSourceKey(post.source_path);
      const work = key === null ? null : worksByKey.get(key) ?? null;
      if (!work) {
        result.unmatchedWorks.push(post.source_path);
        continue;
      }

      postRepository.setCaption(post.id, buildCostuanWorkCaption(canonical.canonical_name, work.label));
      result.imported += 1;
    }
  }

  return result;
}
