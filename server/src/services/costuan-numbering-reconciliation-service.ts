import type { DatabaseSync } from 'node:sqlite';

import { sanitizeArchiveDirectoryName } from './archive-download-task-service.js';
import { preserveDownloadStagedAt } from './archive-download-activity.js';
import {
  areCostuanTitlesCompatible,
  mergeCostuanDirectoryWorks,
  normalizeCostuanTitle,
  parseCostuanNumbering,
  type CostuanNumberingScheme
} from './costuan-numbering-service.js';

type CollectionRow = {
  collection_id: number;
  creator_id: number;
  creator_name: string;
  source_collection_id: string;
  raw_directory_text: string;
  metadata_json: string | null;
};

type SourceWorkRow = {
  id: number;
  work_id: number;
  collection_id: number;
  source_work_id: string;
  source_order: number | null;
  source_order_label: string | null;
  source_title: string;
  raw_title: string | null;
  media_summary: string | null;
  metadata_json: string | null;
  is_active: number;
};

type LocalWorkRow = {
  id: number;
  creator_id: number;
  creator_name: string;
  folder_name: string;
  relative_path: string;
  work_id: number | null;
  linked_source_work_id: number | null;
};

type ParsedWork = {
  order?: number;
  sourceOrder: string;
  sourceOrderRaw?: string;
  sourceOrderScheme?: CostuanNumberingScheme;
  sourceOrderKey?: string;
  label: string;
  rawTitle?: string;
  mediaSummary?: string;
  declaredImageCount?: number | null;
  declaredVideoCount?: number | null;
  declaredSize?: string | null;
  [key: string]: unknown;
};

type SimulatedSourceWork = {
  stableId: string;
  databaseId: number | null;
  workId: number | null;
  creatorId: number;
  creatorName: string;
  collectionId: number;
  sourceCollectionId: string;
  sourceWorkId: string;
  numberingKey: string;
  scheme: CostuanNumberingScheme;
  order: number | null;
  sourceOrderLabel: string;
  title: string;
  rawTitle: string | null;
  mediaSummary: string | null;
  metadataJson: string;
};

export type CostuanNumberingReconciliationOptions = {
  creatorNames?: string[];
};

export type CostuanNumberingReconciliationPlan = {
  generatedAt: string;
  creatorNames: string[];
  summary: {
    collections: number;
    parsedSourceWorks: number;
    sourceWorksToAdd: number;
    sourceWorksToUpdate: number;
    localLinksToCreate: number;
    preservedLocalLinks: number;
    numberingConflicts: number;
    titleConflicts: number;
    unresolvedLocalWorks: number;
    missingWorksBefore: number;
    missingWorksAfter: number;
    downloadTasksToIngest: number;
    downloadTasksToCreate: number;
    downloadTasksSkipped: number;
    blockingIssues: number;
  };
  collections: Array<{
    creatorName: string;
    collectionId: number;
    sourceCollectionId: string;
    parsedWorks: number;
    existingActiveWorks: number;
  }>;
  sourceWorksToAdd: Array<{
    creatorName: string;
    collectionId: number;
    sourceWorkId: string;
    numberingKey: string;
    title: string;
  }>;
  sourceWorksToUpdate: Array<{
    creatorName: string;
    collectionId: number;
    sourceWorkDatabaseId: number;
    sourceWorkId: string;
    numberingKey: string;
    title: string;
  }>;
  localLinksToCreate: Array<{
    creatorName: string;
    localWorkId: number;
    localFolder: string;
    collectionId: number;
    sourceWorkId: string;
    numberingKey: string;
    title: string;
    order: number | null;
    matchMethod: 'costuan-numbering-key' | 'costuan-exact-title';
  }>;
  numberingConflicts: Array<{
    creatorName: string;
    numberingKey: string;
    sourceWorkIds: string[];
    localFolder?: string;
  }>;
  titleConflicts: Array<{
    creatorName: string;
    localWorkId: number;
    localFolder: string;
    numberingKey: string;
    candidates: Array<{ sourceWorkId: string; title: string }>;
  }>;
  unresolvedLocalWorks: Array<{
    creatorName: string;
    localWorkId: number;
    localFolder: string;
    numberingKey: string | null;
    reason: string;
  }>;
  downloadTasksToIngest: Array<{ taskId: number; creatorName: string; sourceWorkId: string }>;
  downloadTasksToCreate: Array<{
    creatorName: string;
    collectionId: number;
    sourceWorkId: string;
    numberingKey: string;
    targetRoot: string;
    targetRelativeDirectory: string;
    targetFilename: string;
  }>;
  downloadTasksSkipped: Array<{
    creatorName: string;
    sourceWorkId: string;
    numberingKey: string;
    reason: string;
  }>;
  collectionMetadataUpdates: Array<{ collectionId: number; metadataJson: string }>;
};

export type CostuanNumberingReconciliationApplyResult = {
  applied: {
    sourceWorksAdded: number;
    sourceWorksUpdated: number;
    localLinksCreated: number;
    downloadTasksIngested: number;
    downloadTasksCreated: number;
  };
  before: CostuanNumberingReconciliationPlan;
  after: CostuanNumberingReconciliationPlan;
};

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseMetadataWorks(metadata: Record<string, unknown>): ParsedWork[] {
  return Array.isArray(metadata.works)
    ? metadata.works.filter((work): work is ParsedWork => Boolean(
      work && typeof work === 'object'
      && typeof (work as ParsedWork).sourceOrder === 'string'
      && typeof (work as ParsedWork).label === 'string'
    ))
    : [];
}

function sameNullable(left: unknown, right: unknown): boolean {
  return (left ?? null) === (right ?? null);
}

function sourceNeedsUpdate(existing: SourceWorkRow, candidate: SimulatedSourceWork): boolean {
  return existing.is_active !== 1
    || existing.source_work_id !== candidate.sourceWorkId
    || !sameNullable(existing.source_order, candidate.order)
    || !sameNullable(existing.source_order_label, candidate.sourceOrderLabel)
    || existing.source_title !== candidate.title
    || !sameNullable(existing.raw_title, candidate.rawTitle)
    || !sameNullable(existing.media_summary, candidate.mediaSummary)
    || existing.metadata_json !== candidate.metadataJson;
}

function existingSourceNumberingKey(source: SourceWorkRow): string | null {
  const metadata = parseJsonObject(source.metadata_json);
  if (typeof metadata.sourceOrderKey === 'string' && metadata.sourceOrderKey.trim()) {
    return metadata.sourceOrderKey.trim();
  }
  return parseCostuanNumbering(source.source_order_label ?? source.source_work_id)?.key ?? null;
}

function creatorFilterSql(creatorNames: string[]): { sql: string; parameters: string[] } {
  const names = [...new Set(creatorNames.map((name) => name.trim()).filter(Boolean))];
  return names.length === 0
    ? { sql: '', parameters: [] }
    : { sql: `AND creators.canonical_name IN (${names.map(() => '?').join(', ')})`, parameters: names };
}

export class CostuanNumberingReconciliationService {
  constructor(private readonly database: DatabaseSync) {}

  plan(options: CostuanNumberingReconciliationOptions = {}): CostuanNumberingReconciliationPlan {
    const filter = creatorFilterSql(options.creatorNames ?? []);
    const collections = this.database.prepare(
      `SELECT collections.id AS collection_id,
              collections.creator_id,
              creators.canonical_name AS creator_name,
              collections.source_collection_id,
              collections.raw_directory_text,
              collections.metadata_json
       FROM archive_catalog_collections collections
       JOIN archive_catalog_creators creators ON creators.id = collections.creator_id
       WHERE collections.source = 'costuan'
         AND collections.is_active = 1
         AND TRIM(COALESCE(collections.raw_directory_text, '')) <> ''
         ${filter.sql}
       ORDER BY creators.id, collections.id`
    ).all(...filter.parameters) as CollectionRow[];

    const existingSourceRows = this.database.prepare(
      `SELECT source_works.id, source_works.work_id, source_works.collection_id,
              source_works.source_work_id, source_works.source_order,
              source_works.source_order_label, source_works.source_title,
              source_works.raw_title, source_works.media_summary,
              source_works.metadata_json, source_works.is_active
       FROM archive_catalog_source_works source_works
       WHERE source_works.source = 'costuan'`
    ).all() as SourceWorkRow[];
    const existingByCollectionAndId = new Map(
      existingSourceRows.map((row) => [`${row.collection_id}:${row.source_work_id}`, row])
    );
    const existingByCollectionAndNumbering = new Map<string, SourceWorkRow[]>();
    for (const row of existingSourceRows) {
      const numberingKey = existingSourceNumberingKey(row);
      if (!numberingKey) continue;
      const key = `${row.collection_id}:${numberingKey}`;
      const values = existingByCollectionAndNumbering.get(key) ?? [];
      values.push(row);
      existingByCollectionAndNumbering.set(key, values);
    }

    const sourceWorksToAdd: CostuanNumberingReconciliationPlan['sourceWorksToAdd'] = [];
    const sourceWorksToUpdate: CostuanNumberingReconciliationPlan['sourceWorksToUpdate'] = [];
    const collectionMetadataUpdates: CostuanNumberingReconciliationPlan['collectionMetadataUpdates'] = [];
    const existingSourceNumberingConflicts: CostuanNumberingReconciliationPlan['numberingConflicts'] = [];
    const simulated: SimulatedSourceWork[] = [];
    const collectionSummaries: CostuanNumberingReconciliationPlan['collections'] = [];

    for (const collection of collections) {
      const metadata = parseJsonObject(collection.metadata_json);
      const mergedWorks = mergeCostuanDirectoryWorks(
        parseMetadataWorks(metadata),
        collection.raw_directory_text
      ) as ParsedWork[];
      const updatedMetadataJson = JSON.stringify({ ...metadata, works: mergedWorks });
      if (updatedMetadataJson !== collection.metadata_json) {
        collectionMetadataUpdates.push({ collectionId: collection.collection_id, metadataJson: updatedMetadataJson });
      }
      const existingActiveWorks = existingSourceRows.filter(
        (row) => row.collection_id === collection.collection_id && row.is_active === 1
      ).length;
      collectionSummaries.push({
        creatorName: collection.creator_name,
        collectionId: collection.collection_id,
        sourceCollectionId: collection.source_collection_id,
        parsedWorks: mergedWorks.length,
        existingActiveWorks
      });

      for (const work of mergedWorks) {
        const numbering = parseCostuanNumbering(work.sourceOrder)
          ?? (work.rawTitle ? parseCostuanNumbering(work.rawTitle) : null);
        const numberingKey = work.sourceOrderKey ?? numbering?.key;
        const scheme = work.sourceOrderScheme ?? numbering?.scheme;
        if (!numberingKey || !scheme) continue;
        const sourceWorkId = work.sourceOrder;
        const exactExisting = existingByCollectionAndId.get(`${collection.collection_id}:${sourceWorkId}`);
        const numberingExisting = existingByCollectionAndNumbering.get(
          `${collection.collection_id}:${numberingKey}`
        ) ?? [];
        if (numberingExisting.length > 1) {
          existingSourceNumberingConflicts.push({
            creatorName: collection.creator_name,
            numberingKey,
            sourceWorkIds: numberingExisting.map((row) => row.source_work_id)
          });
        }
        const existing = exactExisting ?? (numberingExisting.length === 1 ? numberingExisting[0] : undefined);
        const candidate: SimulatedSourceWork = {
          stableId: `${collection.collection_id}:${sourceWorkId}`,
          databaseId: existing?.id ?? null,
          workId: existing?.work_id ?? null,
          creatorId: collection.creator_id,
          creatorName: collection.creator_name,
          collectionId: collection.collection_id,
          sourceCollectionId: collection.source_collection_id,
          sourceWorkId,
          numberingKey,
          scheme,
          order: work.order ?? numbering?.order ?? null,
          sourceOrderLabel: work.sourceOrder,
          title: work.label,
          rawTitle: work.rawTitle ?? null,
          mediaSummary: work.mediaSummary ?? null,
          metadataJson: JSON.stringify(work)
        };
        simulated.push(candidate);
        if (!existing) {
          sourceWorksToAdd.push({
            creatorName: collection.creator_name,
            collectionId: collection.collection_id,
            sourceWorkId,
            numberingKey,
            title: work.label
          });
        } else if (sourceNeedsUpdate(existing, candidate)) {
          sourceWorksToUpdate.push({
            creatorName: collection.creator_name,
            collectionId: collection.collection_id,
            sourceWorkDatabaseId: existing.id,
            sourceWorkId,
            numberingKey,
            title: work.label
          });
        }
      }
    }

    const creatorIds = [...new Set(collections.map((collection) => collection.creator_id))];
    const localWorks = creatorIds.length === 0
      ? []
      : this.database.prepare(
        `SELECT local_works.id,
                local_folders.creator_id,
                creators.canonical_name AS creator_name,
                local_works.folder_name,
                local_works.relative_path,
                local_works.work_id,
                linked_source.id AS linked_source_work_id
         FROM archive_catalog_local_works local_works
         JOIN archive_catalog_local_creator_folders local_folders
           ON local_folders.id = local_works.local_creator_folder_id
         JOIN archive_catalog_creators creators ON creators.id = local_folders.creator_id
         LEFT JOIN archive_catalog_source_works linked_source
           ON linked_source.work_id = local_works.work_id
          AND linked_source.source = 'costuan'
          AND linked_source.is_active = 1
         WHERE local_works.is_active = 1
           AND local_folders.is_active = 1
           AND local_folders.creator_id IN (${creatorIds.map(() => '?').join(', ')})
         ORDER BY creators.id, local_works.id`
      ).all(...creatorIds) as LocalWorkRow[];

    const numberingConflicts: CostuanNumberingReconciliationPlan['numberingConflicts'] = [
      ...existingSourceNumberingConflicts
    ];
    const byCreatorAndNumbering = new Map<string, SimulatedSourceWork[]>();
    const byCreatorAndTitle = new Map<string, SimulatedSourceWork[]>();
    for (const sourceWork of simulated) {
      const mapKey = `${sourceWork.creatorId}:${sourceWork.numberingKey}`;
      const values = byCreatorAndNumbering.get(mapKey) ?? [];
      values.push(sourceWork);
      byCreatorAndNumbering.set(mapKey, values);
      const titleKey = `${sourceWork.creatorId}:${normalizeCostuanTitle(sourceWork.title)}`;
      const titleValues = byCreatorAndTitle.get(titleKey) ?? [];
      titleValues.push(sourceWork);
      byCreatorAndTitle.set(titleKey, titleValues);
    }
    for (const values of byCreatorAndNumbering.values()) {
      if (values.length <= 1) continue;
      numberingConflicts.push({
        creatorName: values[0].creatorName,
        numberingKey: values[0].numberingKey,
        sourceWorkIds: values.map((value) => value.sourceWorkId)
      });
    }

    const localLinksToCreate: CostuanNumberingReconciliationPlan['localLinksToCreate'] = [];
    const titleConflicts: CostuanNumberingReconciliationPlan['titleConflicts'] = [];
    const unresolvedLocalWorks: CostuanNumberingReconciliationPlan['unresolvedLocalWorks'] = [];
    const claimedSourceStableIds = new Set<string>();
    let preservedLocalLinks = 0;
    for (const localWork of localWorks) {
      if (localWork.linked_source_work_id !== null) {
        const linked = simulated.find((candidate) => candidate.databaseId === localWork.linked_source_work_id);
        if (linked) claimedSourceStableIds.add(linked.stableId);
        preservedLocalLinks += 1;
        continue;
      }
      if (localWork.work_id !== null) {
        unresolvedLocalWorks.push({
          creatorName: localWork.creator_name,
          localWorkId: localWork.id,
          localFolder: localWork.folder_name,
          numberingKey: parseCostuanNumbering(localWork.folder_name)?.key ?? null,
          reason: 'local-work-already-linked-outside-active-costuan-source'
        });
        continue;
      }
      const numbering = parseCostuanNumbering(localWork.folder_name);
      if (!numbering) {
        const titleCandidates = byCreatorAndTitle.get(
          `${localWork.creator_id}:${normalizeCostuanTitle(localWork.folder_name)}`
        ) ?? [];
        if (titleCandidates.length !== 1) {
          if (titleCandidates.length > 1) {
            titleConflicts.push({
              creatorName: localWork.creator_name,
              localWorkId: localWork.id,
              localFolder: localWork.folder_name,
              numberingKey: 'TITLE:EXACT',
              candidates: titleCandidates.map((candidate) => ({
                sourceWorkId: candidate.sourceWorkId,
                title: candidate.title
              }))
            });
          } else {
            unresolvedLocalWorks.push({
              creatorName: localWork.creator_name,
              localWorkId: localWork.id,
              localFolder: localWork.folder_name,
              numberingKey: null,
              reason: 'local-numbering-unparseable-and-exact-title-not-found'
            });
          }
          continue;
        }
        const candidate = titleCandidates[0];
        if (claimedSourceStableIds.has(candidate.stableId)) {
          numberingConflicts.push({
            creatorName: localWork.creator_name,
            numberingKey: candidate.numberingKey,
            sourceWorkIds: [candidate.sourceWorkId],
            localFolder: localWork.folder_name
          });
          continue;
        }
        claimedSourceStableIds.add(candidate.stableId);
        localLinksToCreate.push({
          creatorName: localWork.creator_name,
          localWorkId: localWork.id,
          localFolder: localWork.folder_name,
          collectionId: candidate.collectionId,
          sourceWorkId: candidate.sourceWorkId,
          numberingKey: candidate.numberingKey,
          title: candidate.title,
          order: candidate.order,
          matchMethod: 'costuan-exact-title'
        });
        continue;
      }
      const candidates = byCreatorAndNumbering.get(`${localWork.creator_id}:${numbering.key}`) ?? [];
      if (candidates.length === 0) {
        unresolvedLocalWorks.push({
          creatorName: localWork.creator_name,
          localWorkId: localWork.id,
          localFolder: localWork.folder_name,
          numberingKey: numbering.key,
          reason: 'source-numbering-key-not-found'
        });
        continue;
      }
      if (candidates.length > 1) {
        numberingConflicts.push({
          creatorName: localWork.creator_name,
          numberingKey: numbering.key,
          sourceWorkIds: candidates.map((candidate) => candidate.sourceWorkId),
          localFolder: localWork.folder_name
        });
        continue;
      }
      const compatible = candidates.filter((candidate) => areCostuanTitlesCompatible(
        localWork.folder_name,
        candidate.title,
        [localWork.creator_name]
      ));
      if (compatible.length === 0) {
        titleConflicts.push({
          creatorName: localWork.creator_name,
          localWorkId: localWork.id,
          localFolder: localWork.folder_name,
          numberingKey: numbering.key,
          candidates: candidates.map((candidate) => ({
            sourceWorkId: candidate.sourceWorkId,
            title: candidate.title
          }))
        });
        continue;
      }
      const candidate = compatible[0];
      if (claimedSourceStableIds.has(candidate.stableId)) {
        numberingConflicts.push({
          creatorName: localWork.creator_name,
          numberingKey: numbering.key,
          sourceWorkIds: [candidate.sourceWorkId],
          localFolder: localWork.folder_name
        });
        continue;
      }
      claimedSourceStableIds.add(candidate.stableId);
      localLinksToCreate.push({
        creatorName: localWork.creator_name,
        localWorkId: localWork.id,
        localFolder: localWork.folder_name,
        collectionId: candidate.collectionId,
        sourceWorkId: candidate.sourceWorkId,
        numberingKey: candidate.numberingKey,
        title: candidate.title,
        order: candidate.order,
        matchMethod: 'costuan-numbering-key'
      });
    }

    const sourceIds = existingSourceRows.map((row) => row.id);
    const existingTasks = sourceIds.length === 0
      ? []
      : this.database.prepare(
        `SELECT id, source_work_id, status
         FROM archive_catalog_download_tasks
         WHERE source_work_id IN (${sourceIds.map(() => '?').join(', ')})`
      ).all(...sourceIds) as Array<{ id: number; source_work_id: number; status: string }>;
    const taskBySourceDatabaseId = new Map(existingTasks.map((task) => [task.source_work_id, task]));
    const downloadTasksToIngest: CostuanNumberingReconciliationPlan['downloadTasksToIngest'] = [];
    for (const link of localLinksToCreate) {
      const source = simulated.find(
        (candidate) => candidate.collectionId === link.collectionId && candidate.sourceWorkId === link.sourceWorkId
      );
      if (!source?.databaseId) continue;
      const task = taskBySourceDatabaseId.get(source.databaseId);
      if (task && !['ingested', 'cancelled'].includes(task.status)) {
        downloadTasksToIngest.push({ taskId: task.id, creatorName: link.creatorName, sourceWorkId: link.sourceWorkId });
      }
    }

    const latestTargetRoot = (this.database.prepare(
      `SELECT target_root FROM archive_catalog_download_tasks
       WHERE TRIM(target_root) <> '' ORDER BY updated_at DESC, id DESC LIMIT 1`
    ).get() as { target_root: string } | undefined)?.target_root ?? null;
    const deliveryRows = this.database.prepare(
      `SELECT DISTINCT collection_id FROM archive_catalog_deliveries
       WHERE provider = 'baidu' AND status IN ('saved', 'already-saved')`
    ).all() as Array<{ collection_id: number }>;
    const deliveredCollections = new Set(deliveryRows.map((row) => row.collection_id));
    const downloadTasksToCreate: CostuanNumberingReconciliationPlan['downloadTasksToCreate'] = [];
    const downloadTasksSkipped: CostuanNumberingReconciliationPlan['downloadTasksSkipped'] = [];
    for (const source of simulated) {
      if (claimedSourceStableIds.has(source.stableId)) continue;
      if (source.databaseId && taskBySourceDatabaseId.has(source.databaseId)) continue;
      if (!latestTargetRoot || !deliveredCollections.has(source.collectionId)) continue;
      if (source.scheme !== 'NO' || source.order === null) {
        downloadTasksSkipped.push({
          creatorName: source.creatorName,
          sourceWorkId: source.sourceWorkId,
          numberingKey: source.numberingKey,
          reason: 'non-NO source filename requires manual delivery mapping'
        });
        continue;
      }
      downloadTasksToCreate.push({
        creatorName: source.creatorName,
        collectionId: source.collectionId,
        sourceWorkId: source.sourceWorkId,
        numberingKey: source.numberingKey,
        targetRoot: latestTargetRoot,
        targetRelativeDirectory: sanitizeArchiveDirectoryName(source.creatorName),
        targetFilename: `${String(source.order).padStart(3, '0')}.7z`
      });
    }

    const currentMissing = this.database.prepare(
      `SELECT COUNT(*) AS count
       FROM archive_catalog_source_works source_works
       JOIN archive_catalog_works works ON works.id = source_works.work_id
       WHERE source_works.source = 'costuan'
         AND source_works.is_active = 1
         AND works.creator_id IN (${creatorIds.length ? creatorIds.map(() => '?').join(', ') : 'NULL'})
         AND NOT EXISTS (
           SELECT 1 FROM archive_catalog_local_works local_works
           JOIN archive_catalog_local_creator_folders local_folders
             ON local_folders.id = local_works.local_creator_folder_id
           WHERE local_works.work_id = source_works.work_id
             AND local_works.is_active = 1 AND local_folders.is_active = 1
         )`
    ).get(...creatorIds) as { count: number };
    const missingAfter = simulated.filter((source) => !claimedSourceStableIds.has(source.stableId)).length;
    const blockingIssues = numberingConflicts.length + titleConflicts.length + unresolvedLocalWorks.length;

    return {
      generatedAt: new Date().toISOString(),
      creatorNames: [...new Set(collections.map((collection) => collection.creator_name))],
      summary: {
        collections: collections.length,
        parsedSourceWorks: simulated.length,
        sourceWorksToAdd: sourceWorksToAdd.length,
        sourceWorksToUpdate: sourceWorksToUpdate.length,
        localLinksToCreate: localLinksToCreate.length,
        preservedLocalLinks,
        numberingConflicts: numberingConflicts.length,
        titleConflicts: titleConflicts.length,
        unresolvedLocalWorks: unresolvedLocalWorks.length,
        missingWorksBefore: currentMissing.count,
        missingWorksAfter: missingAfter,
        downloadTasksToIngest: downloadTasksToIngest.length,
        downloadTasksToCreate: downloadTasksToCreate.length,
        downloadTasksSkipped: downloadTasksSkipped.length,
        blockingIssues
      },
      collections: collectionSummaries,
      sourceWorksToAdd,
      sourceWorksToUpdate,
      localLinksToCreate,
      numberingConflicts,
      titleConflicts,
      unresolvedLocalWorks,
      downloadTasksToIngest,
      downloadTasksToCreate,
      downloadTasksSkipped,
      collectionMetadataUpdates
    };
  }

  apply(options: CostuanNumberingReconciliationOptions = {}): CostuanNumberingReconciliationApplyResult {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const before = this.plan(options);
      if (before.summary.blockingIssues > 0) {
        throw new Error(`Costuan numbering reconciliation has ${before.summary.blockingIssues} blocking issue(s)`);
      }
      const timestamp = new Date().toISOString();

      for (const update of before.collectionMetadataUpdates) {
        this.database.prepare(
          `UPDATE archive_catalog_collections
           SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).run(update.metadataJson, update.collectionId);
      }

      for (const update of before.sourceWorksToUpdate) {
        const source = this.findPlannedSource(before, update.collectionId, update.sourceWorkId);
        if (!source) continue;
        const existing = this.database.prepare(
          `SELECT work_id FROM archive_catalog_source_works WHERE id = ?`
        ).get(update.sourceWorkDatabaseId) as { work_id: number };
        this.database.prepare(
          `UPDATE archive_catalog_works SET display_title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(source.title, existing.work_id);
        this.database.prepare(
          `UPDATE archive_catalog_source_works SET
             source_work_id = ?, source_order = ?, source_order_label = ?, source_title = ?, raw_title = ?,
             media_summary = ?, metadata_json = ?, is_active = 1, last_seen_at = ?
           WHERE id = ?`
        ).run(
          source.sourceWorkId,
          source.order,
          source.sourceOrderLabel,
          source.title,
          source.rawTitle,
          source.mediaSummary,
          source.metadataJson,
          timestamp,
          update.sourceWorkDatabaseId
        );
      }

      for (const addition of before.sourceWorksToAdd) {
        const source = this.findPlannedSource(before, addition.collectionId, addition.sourceWorkId);
        if (!source) throw new Error(`Planned Costuan source work disappeared: ${addition.sourceWorkId}`);
        const insertedWork = this.database.prepare(
          `INSERT INTO archive_catalog_works (creator_id, display_title) VALUES (?, ?)`
        ).run(source.creatorId, source.title);
        const workId = Number(insertedWork.lastInsertRowid);
        this.database.prepare(
          `INSERT INTO archive_catalog_source_works (
             work_id, collection_id, source, source_work_id, source_order,
             source_order_label, source_title, raw_title, media_summary,
             metadata_json, is_active, first_seen_at, last_seen_at
           ) VALUES (?, ?, 'costuan', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        ).run(
          workId,
          source.collectionId,
          source.sourceWorkId,
          source.order,
          source.sourceOrderLabel,
          source.title,
          source.rawTitle,
          source.mediaSummary,
          source.metadataJson,
          timestamp,
          timestamp
        );
      }

      for (const link of before.localLinksToCreate) {
        const source = this.database.prepare(
          `SELECT work_id FROM archive_catalog_source_works
           WHERE collection_id = ? AND source_work_id = ? AND source = 'costuan' AND is_active = 1`
        ).get(link.collectionId, link.sourceWorkId) as { work_id: number } | undefined;
        if (!source) throw new Error(`Cannot resolve Costuan source work ${link.sourceWorkId}`);
        const linkResult = this.database.prepare(
          `UPDATE archive_catalog_local_works SET
             work_id = ?, parsed_source_order = ?, match_status = 'matched',
             match_method = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND is_active = 1 AND work_id IS NULL`
        ).run(source.work_id, link.order, link.matchMethod, link.localWorkId);
        if (linkResult.changes !== 1) {
          throw new Error(`Local work ${link.localWorkId} changed after dry-run; reconciliation aborted`);
        }
      }

      for (const task of before.downloadTasksToIngest) {
        preserveDownloadStagedAt(this.database, { taskId: task.taskId });
        this.database.prepare(
          `UPDATE archive_catalog_download_tasks SET
             status = 'ingested', completed_at = COALESCE(completed_at, ?),
             claimed_by = NULL, claimed_at = NULL, last_error = NULL,
             updated_at = ?
           WHERE id = ? AND status NOT IN ('ingested', 'cancelled')`
        ).run(timestamp, timestamp, task.taskId);
      }

      for (const task of before.downloadTasksToCreate) {
        const source = this.database.prepare(
          `SELECT id FROM archive_catalog_source_works
           WHERE collection_id = ? AND source_work_id = ? AND source = 'costuan' AND is_active = 1`
        ).get(task.collectionId, task.sourceWorkId) as { id: number } | undefined;
        if (!source) throw new Error(`Cannot create task for Costuan source work ${task.sourceWorkId}`);
        this.database.prepare(
          `INSERT INTO archive_catalog_download_tasks (
             source_work_id, provider, target_root, target_relative_directory,
             target_filename, status, created_at, updated_at
           ) VALUES (?, 'baidu', ?, ?, ?, 'pending', ?, ?)
           ON CONFLICT(source_work_id, provider) DO NOTHING`
        ).run(
          source.id,
          task.targetRoot,
          task.targetRelativeDirectory,
          task.targetFilename,
          timestamp,
          timestamp
        );
      }

      const after = this.plan(options);
      if (
        after.summary.blockingIssues > 0
        || after.summary.sourceWorksToAdd > 0
        || after.summary.sourceWorksToUpdate > 0
        || after.summary.localLinksToCreate > 0
        || after.summary.downloadTasksToIngest > 0
        || after.summary.downloadTasksToCreate > 0
        || after.collectionMetadataUpdates.length > 0
      ) {
        throw new Error('Costuan numbering reconciliation did not converge to an idempotent state');
      }
      this.database.exec('COMMIT');
      return {
        applied: {
          sourceWorksAdded: before.sourceWorksToAdd.length,
          sourceWorksUpdated: before.sourceWorksToUpdate.length,
          localLinksCreated: before.localLinksToCreate.length,
          downloadTasksIngested: before.downloadTasksToIngest.length,
          downloadTasksCreated: before.downloadTasksToCreate.length
        },
        before,
        after
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private findPlannedSource(
    plan: CostuanNumberingReconciliationPlan,
    collectionId: number | null,
    sourceWorkId: string
  ): SimulatedSourceWork | null {
    const targetCollectionIds = collectionId === null
      ? plan.collections.map((collection) => collection.collectionId)
      : [collectionId];
    for (const targetCollectionId of targetCollectionIds) {
      const collection = this.database.prepare(
        `SELECT collections.id AS collection_id, collections.creator_id,
                creators.canonical_name AS creator_name,
                collections.source_collection_id, collections.raw_directory_text,
                collections.metadata_json
         FROM archive_catalog_collections collections
         JOIN archive_catalog_creators creators ON creators.id = collections.creator_id
         WHERE collections.id = ?`
      ).get(targetCollectionId) as CollectionRow | undefined;
      if (!collection) continue;
      const metadata = parseJsonObject(collection.metadata_json);
      const works = mergeCostuanDirectoryWorks(
        parseMetadataWorks(metadata),
        collection.raw_directory_text
      ) as ParsedWork[];
      const work = works.find((candidate) => candidate.sourceOrder === sourceWorkId);
      if (!work) continue;
      const numbering = parseCostuanNumbering(work.sourceOrder)
        ?? (work.rawTitle ? parseCostuanNumbering(work.rawTitle) : null);
      const numberingKey = work.sourceOrderKey ?? numbering?.key;
      const scheme = work.sourceOrderScheme ?? numbering?.scheme;
      if (!numberingKey || !scheme) continue;
      const existing = this.database.prepare(
        `SELECT id, work_id FROM archive_catalog_source_works
         WHERE collection_id = ? AND source_work_id = ?`
      ).get(collection.collection_id, sourceWorkId) as { id: number; work_id: number } | undefined;
      return {
        stableId: `${collection.collection_id}:${sourceWorkId}`,
        databaseId: existing?.id ?? null,
        workId: existing?.work_id ?? null,
        creatorId: collection.creator_id,
        creatorName: collection.creator_name,
        collectionId: collection.collection_id,
        sourceCollectionId: collection.source_collection_id,
        sourceWorkId,
        numberingKey,
        scheme,
        order: work.order ?? numbering?.order ?? null,
        sourceOrderLabel: work.sourceOrder,
        title: work.label,
        rawTitle: work.rawTitle ?? null,
        mediaSummary: work.mediaSummary ?? null,
        metadataJson: JSON.stringify(work)
      };
    }
    return null;
  }
}
