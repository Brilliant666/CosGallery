import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { folderRepository, postRepository } from '../db/repositories.js';
import { normalizeCreatorIdentity } from './creator-rating-import-service.js';
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

function findLocalCreator(
  names: string[],
  localCreators: ReturnType<typeof folderRepository.getAll>
) {
  const identities = new Set(names.filter(Boolean).map(normalizeCreatorIdentity));
  const matches = localCreators.filter((creator) => identities.has(normalizeCreatorIdentity(creator.name)));
  return matches.length === 1 ? matches[0] : null;
}

export async function importCostuanArchiveMetadata(filePath: string): Promise<CostuanArchiveImportResult> {
  const document = costuanArchiveSchema.parse(JSON.parse(await fs.readFile(filePath, 'utf8')));
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
    const creator = findLocalCreator(
      [record.creatorName, ...record.aliases, record.local?.folderName ?? ''],
      localCreators
    );
    if (!creator) {
      result.unmatchedCreators.push(record.creatorName);
      continue;
    }

    result.matchedCreators += 1;
    const worksByKey = new Map<string, z.infer<typeof costuanWorkSchema>>();
    for (const work of mergedWorks) {
      const key = work.sourceOrderKey ?? parseCostuanSourceKey(work.sourceOrder);
      if (key) worksByKey.set(key, work);
    }

    for (const post of postRepository.listCarouselRecordsByFolder(creator.id)) {
      const key = parseCostuanSourceKey(post.source_path);
      const work = key === null ? null : worksByKey.get(key) ?? null;
      if (!work) {
        result.unmatchedWorks.push(post.source_path);
        continue;
      }

      postRepository.setCaption(post.id, buildCostuanWorkCaption(creator.name, work.label));
      result.imported += 1;
    }
  }

  return result;
}
