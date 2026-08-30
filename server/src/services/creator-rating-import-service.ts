import fs from 'node:fs/promises';

import { z } from 'zod';

import { creatorRatingRepository, folderRepository } from '../db/repositories.js';

const hcfRatingEntrySchema = z.object({
  name: z.string().trim().min(1),
  rating: z.enum(['r15', 'r18']),
  checkedAt: z.number().finite().nullable().optional()
});

const hcfExportSchema = z.object({
  format: z.literal('hcf-tag-preferences'),
  exportedAt: z.string().optional(),
  state: z.object({
    liked: z.array(z.string()).default([]),
    kept: z.array(z.string()).default([])
  }),
  contentRatings: z.object({
    entries: z.array(hcfRatingEntrySchema)
  })
});

export type HcfRatingImportResult = {
  source: 'hentaiclub';
  imported: number;
  unmatchedCreators: string[];
  matches: Array<{
    creatorName: string;
    sourceName: string;
    rating: 'R15' | 'R18';
    matchType: 'exact' | 'alias';
  }>;
};

export function normalizeCreatorIdentity(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s_\-@·・.]+/gu, '');
}

function findRatingEntry(
  creatorName: string,
  entries: Array<z.infer<typeof hcfRatingEntrySchema>>
): { entry: z.infer<typeof hcfRatingEntrySchema>; matchType: 'exact' | 'alias' } | null {
  const creatorIdentity = normalizeCreatorIdentity(creatorName);
  const exactMatches = entries.filter((entry) => normalizeCreatorIdentity(entry.name) === creatorIdentity);
  if (exactMatches.length === 1) return { entry: exactMatches[0], matchType: 'exact' };

  const aliasMatches = entries
    .map((entry) => ({ entry, identity: normalizeCreatorIdentity(entry.name) }))
    .filter(({ identity }) =>
      Math.min(identity.length, creatorIdentity.length) >= 4
      && (creatorIdentity.includes(identity) || identity.includes(creatorIdentity))
    )
    .sort((left, right) => right.identity.length - left.identity.length);

  if (aliasMatches.length === 0) return null;
  if (aliasMatches.length > 1 && aliasMatches[0].identity.length === aliasMatches[1].identity.length) return null;
  return { entry: aliasMatches[0].entry, matchType: 'alias' };
}

export async function importHentaiclubCreatorRatings(filePath: string): Promise<HcfRatingImportResult> {
  const document = hcfExportSchema.parse(JSON.parse(await fs.readFile(filePath, 'utf8')));
  const preferenceByIdentity = new Map<string, 'liked' | 'kept'>();
  for (const name of document.state.kept) preferenceByIdentity.set(normalizeCreatorIdentity(name), 'kept');
  for (const name of document.state.liked) preferenceByIdentity.set(normalizeCreatorIdentity(name), 'liked');

  const creators = folderRepository.getAll().filter((folder) => folder.role === 'normal');
  const result: HcfRatingImportResult = {
    source: 'hentaiclub',
    imported: 0,
    unmatchedCreators: [],
    matches: []
  };

  creatorRatingRepository.deleteBySource('hentaiclub');
  for (const creator of creators) {
    const match = findRatingEntry(creator.name, document.contentRatings.entries);
    if (!match) {
      result.unmatchedCreators.push(creator.name);
      continue;
    }

    const rating = match.entry.rating.toUpperCase() as 'R15' | 'R18';
    creatorRatingRepository.upsertSource({
      folderId: creator.id,
      source: 'hentaiclub',
      sourceCreatorId: match.entry.name,
      sourceDisplayName: match.entry.name,
      rating,
      observedAt: match.entry.checkedAt ?? null,
      metadata: {
        exportedAt: document.exportedAt ?? null,
        preference: preferenceByIdentity.get(normalizeCreatorIdentity(match.entry.name)) ?? null,
        matchType: match.matchType
      }
    });
    result.imported += 1;
    result.matches.push({
      creatorName: creator.name,
      sourceName: match.entry.name,
      rating,
      matchType: match.matchType
    });
  }

  return result;
}
