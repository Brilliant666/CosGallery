import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { folderRepository, postRepository } from '../db/repositories.js';
import { normalizeCreatorIdentity } from './creator-rating-import-service.js';

const costuanWorkSchema = z.object({
  order: z.number().int().positive().optional(),
  sourceOrder: z.string().trim().min(1),
  label: z.string().trim().min(1),
  rawTitle: z.string().optional(),
  mediaSummary: z.string().optional()
});

const costuanRecordSchema = z.object({
  creatorName: z.string().trim().min(1),
  aliases: z.array(z.string()).default([]),
  costuan: z.object({
    postId: z.string(),
    works: z.array(costuanWorkSchema).default([])
  }),
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
  const match = leaf.match(/(?:^|[\s_\-–—])(?:NO\.?\s*)?(\d{1,4})(?=\s|[^\d]|$)/i);
  if (!match) return null;
  const order = Number(match[1]);
  return Number.isInteger(order) && order > 0 ? order : null;
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
    if (record.costuan.works.length === 0) continue;
    const creator = findLocalCreator(
      [record.creatorName, ...record.aliases, record.local?.folderName ?? ''],
      localCreators
    );
    if (!creator) {
      result.unmatchedCreators.push(record.creatorName);
      continue;
    }

    result.matchedCreators += 1;
    const worksByOrder = new Map<number, z.infer<typeof costuanWorkSchema>>();
    for (const work of record.costuan.works) {
      const order = work.order ?? parseCostuanSourceOrder(work.sourceOrder);
      if (order !== null) worksByOrder.set(order, work);
    }

    for (const post of postRepository.listCarouselRecordsByFolder(creator.id)) {
      const order = parseCostuanSourceOrder(post.source_path);
      const work = order === null ? null : worksByOrder.get(order) ?? null;
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
