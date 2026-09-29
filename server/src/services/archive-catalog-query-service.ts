import type { DatabaseSync } from 'node:sqlite';
import { sourceNeedsAcquisitionSql } from './archive-local-fulfillment-service.js';

import { databaseManager } from '../db/database.js';

export type ArchiveCatalogPreference = 'liked' | 'kept';
export type ArchiveCatalogRating = 'R15' | 'R18';
export type ArchiveCatalogState = 'missing' | 'complete' | 'no-local' | 'no-source' | 'unresolved';

export type ArchiveCatalogListOptions = {
  page: number;
  limit: number;
  preference?: ArchiveCatalogPreference | 'unset';
  rating?: ArchiveCatalogRating | 'unclassified';
  active?: 'active' | 'inactive' | 'all';
  hasLocal?: 'yes' | 'no';
  hasSource?: 'yes' | 'no' | 'no-unchecked' | 'no-not-found';
  state?: ArchiveCatalogState;
  query?: string;
};

export type ArchiveCatalogCreatorListItem = {
  id: number;
  name: string;
  isActive: boolean;
  seedSource: string;
  seedSourceCreatorId: string;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
  aliasCount: number;
  sourceCount: number;
  localFolderCount: number;
  preference: ArchiveCatalogPreference | null;
  rating: ArchiveCatalogRating | null;
  sourceCollections: number;
  remoteWorks: number;
  localWorks: number;
  matchedWorks: number;
  missingWorks: number;
  unresolvedLocalWorks: number;
  latestSourceObservation: string | null;
};

export type ArchiveCatalogSummary = {
  creators: number;
  activeCreators: number;
  inactiveCreators: number;
  unsetPreference: number;
  unclassified: number;
  creatorsWithoutLocalWorks: number;
  unlinkedLocalFolders: number;
  liked: number;
  kept: number;
  r15: number;
  r18: number;
  creatorsWithSources: number;
  creatorsWithLocalWorks: number;
  sourceCollections: number;
  remoteWorks: number;
  localWorks: number;
  matchedWorks: number;
  missingWorks: number;
  unresolvedCreatorFolders: number;
  unresolvedLocalWorks: number;
};

export type ArchiveCatalogCreatorsPayload = {
  summary: ArchiveCatalogSummary;
  items: ArchiveCatalogCreatorListItem[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
};

export type ArchiveCatalogCreatorDetail = ArchiveCatalogCreatorListItem & {
  localFolders: ManagedLocalFolder[];
  unlinkedLocalFolders: ManagedLocalFolder[];
  impact: { sources:number; collections:number; remoteWorks:number; localWorks:number; unfinishedDownloadTasks:number; localFolders:number };
  aliases: Array<{
    id: string;
    alias: string;
    source: string;
    editable: boolean;
  }>;
  sources: Array<{
    source: string;
    sourceCreatorId: string;
    displayName: string;
    url: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
  }>;
  collections: Array<{
    id: number;
    source: string;
    sourceCollectionId: string;
    title: string;
    url: string | null;
    declaredWorkCount: number | null;
    observedAt: string;
    deliveries: Array<{
      provider: string;
      type: string;
      status: string | null;
      sourceFolderName: string | null;
      destinationPath: string | null;
      transferredAt: string | null;
    }>;
  }>;
  missing: Array<{
    workId: number;
    source: string;
    sourceCollectionId: string;
    sourceOrder: number | null;
    sourceOrderLabel: string | null;
    title: string;
  }>;
  unresolved: Array<{
    folderName: string;
    relativePath: string;
    parsedSourceOrder: number | null;
    status: 'unmatched' | 'ambiguous';
  }>;
};

export type ManagedLocalFolder = {
  id:number; catalogFolderId:number|null; name:string; folderPath:string; creatorId:number|null;
  matchStatus:string; matchMethod:string|null; workCount:number;
};
type CreatorRow = {
  id: number;
  canonical_name: string;
  is_active: number;
  seed_source: string;
  seed_source_creator_id: string;
  created_at: string;
  updated_at: string;
  deactivated_at: string|null;
  alias_count:number;
  source_count:number;
  local_folder_count:number;
  preference: ArchiveCatalogPreference | null;
  effective_rating: ArchiveCatalogRating | null;
};

type CollectionRow = {
  id: number;
  creator_id: number;
  observed_at: string;
};

type RemoteWorkRow = {
  creator_id: number;
  work_id: number;
};

type LocalWorkRow = {
  creator_id: number | null;
  work_id: number | null;
  match_status: 'matched' | 'unmatched' | 'ambiguous';
};

function addToSetMap(map: Map<number, Set<number>>, key: number, value: number): void {
  const values = map.get(key) ?? new Set<number>();
  values.add(value);
  map.set(key, values);
}

function increment(map: Map<number, number>, key: number): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '');
}

export class ArchiveCatalogQueryService {
  constructor(private readonly database: DatabaseSync = databaseManager.connection) {}

  listCreators(options: ArchiveCatalogListOptions): ArchiveCatalogCreatorsPayload {
    const allItems = this.buildCreatorItems();
    const checkStates = new Map<number, string>();
    if (options.hasSource === 'no-unchecked' || options.hasSource === 'no-not-found') {
      const tasks = this.database.prepare(`SELECT creator_id, status FROM archive_catalog_metadata_tasks WHERE source='costuan'`).all() as Array<{creator_id:number;status:string}>;
      for (const task of tasks) checkStates.set(task.creator_id, task.status);
    }
    const normalizedQuery = normalizeSearch(options.query ?? '');
    const aliasMatches = new Set<number>();
    if (normalizedQuery) {
      const aliases = this.database.prepare(
        `SELECT creator_id, alias FROM archive_catalog_creator_aliases`
      ).all() as Array<{ creator_id: number; alias: string }>;
      for (const alias of aliases) {
        if (normalizeSearch(alias.alias).includes(normalizedQuery)) aliasMatches.add(alias.creator_id);
      }
    }
    const filtered = allItems.filter((item) => {
      const active = options.active ?? 'active';
      if (active !== 'all' && item.isActive !== (active === 'active')) return false;
      if (options.preference && item.preference !== (options.preference === 'unset' ? null : options.preference)) return false;
      if (options.rating && item.rating !== (options.rating === 'unclassified' ? null : options.rating)) return false;
      if (options.hasLocal && (item.localWorks > 0) !== (options.hasLocal === 'yes')) return false;
      if (options.hasSource && (item.sourceCount > 0) !== (options.hasSource === 'yes')) return false;
      if (options.hasSource === 'no-unchecked' && checkStates.has(item.id)) return false;
      if (options.hasSource === 'no-not-found' && checkStates.get(item.id) !== 'not_found') return false;
      if (
        normalizedQuery
        && !normalizeSearch(item.name).includes(normalizedQuery)
        && !aliasMatches.has(item.id)
      ) return false;
      if (options.state === 'missing' && item.missingWorks === 0) return false;
      if (options.state === 'complete' && (
        item.remoteWorks === 0
        || item.missingWorks > 0
        || item.unresolvedLocalWorks > 0
      )) return false;
      if (options.state === 'no-local' && (item.remoteWorks === 0 || item.localWorks > 0)) return false;
      if (options.state === 'no-source' && item.remoteWorks > 0) return false;
      if (options.state === 'unresolved' && item.unresolvedLocalWorks === 0) return false;
      return true;
    });
    const offset = (options.page - 1) * options.limit;

    return {
      summary: this.buildSummary(allItems),
      items: filtered.slice(offset, offset + options.limit),
      page: options.page,
      limit: options.limit,
      total: filtered.length,
      hasMore: offset + options.limit < filtered.length
    };
  }

  getCreatorDetail(creatorId: number): ArchiveCatalogCreatorDetail | null {
    const item = this.buildCreatorItems().find((creator) => creator.id === creatorId);
    if (!item) return null;

    const aliases = this.database.prepare(
      `SELECT alias, source, normalized_alias
       FROM archive_catalog_creator_aliases
       WHERE creator_id = ?
       ORDER BY source COLLATE NOCASE, alias COLLATE NOCASE`
    ).all(creatorId) as Array<{ alias: string; source: string; normalized_alias: string }>;
    const sources = this.database.prepare(
      `SELECT source, source_creator_id, source_display_name, source_url, first_seen_at, last_seen_at
       FROM archive_catalog_creator_sources
       WHERE creator_id = ?
       ORDER BY source COLLATE NOCASE, source_display_name COLLATE NOCASE`
    ).all(creatorId) as Array<{
      source: string;
      source_creator_id: string;
      source_display_name: string;
      source_url: string | null;
      first_seen_at: string;
      last_seen_at: string;
    }>;
    const collectionRows = this.database.prepare(
      `SELECT id, source, source_collection_id, title, source_url, declared_work_count, observed_at
       FROM archive_catalog_collections
       WHERE creator_id = ? AND is_active = 1
       ORDER BY observed_at DESC, id DESC`
    ).all(creatorId) as Array<{
      id: number;
      source: string;
      source_collection_id: string;
      title: string;
      source_url: string | null;
      declared_work_count: number | null;
      observed_at: string;
    }>;
    const deliveryRows = this.database.prepare(
      `SELECT collection_id, provider, delivery_type, status, source_folder_name,
              destination_path, transferred_at
       FROM archive_catalog_deliveries
       WHERE collection_id IN (
         SELECT id FROM archive_catalog_collections WHERE creator_id = ? AND is_active = 1
       )
       ORDER BY provider COLLATE NOCASE, id`
    ).all(creatorId) as Array<{
      collection_id: number;
      provider: string;
      delivery_type: string;
      status: string | null;
      source_folder_name: string | null;
      destination_path: string | null;
      transferred_at: string | null;
    }>;
    const deliveriesByCollection = new Map<number, typeof deliveryRows>();
    for (const delivery of deliveryRows) {
      const values = deliveriesByCollection.get(delivery.collection_id) ?? [];
      values.push(delivery);
      deliveriesByCollection.set(delivery.collection_id, values);
    }
    const missing = this.database.prepare(
      `SELECT works.id AS work_id, source_works.source, collections.source_collection_id,
              source_works.source_order, source_works.source_order_label, source_works.source_title
       FROM archive_catalog_source_works source_works
       JOIN archive_catalog_works works ON works.id = source_works.work_id
       JOIN archive_catalog_collections collections ON collections.id = source_works.collection_id
       WHERE works.creator_id = ?
         AND source_works.is_active = 1
         AND collections.is_active = 1
         AND ${sourceNeedsAcquisitionSql('source_works')}
       ORDER BY source_works.source COLLATE NOCASE,
                collections.source_collection_id COLLATE NOCASE,
                source_works.source_order IS NULL,
                source_works.source_order,
                source_works.source_title COLLATE NOCASE`
    ).all(creatorId) as Array<{
      work_id: number;
      source: string;
      source_collection_id: string;
      source_order: number | null;
      source_order_label: string | null;
      source_title: string;
    }>;
    const unresolved = this.database.prepare(
      `SELECT local_works.folder_name, local_works.relative_path,
              local_works.parsed_source_order, local_works.match_status
       FROM archive_catalog_local_works local_works
       JOIN archive_catalog_local_creator_folders local_folders
         ON local_folders.id = local_works.local_creator_folder_id
       WHERE local_folders.creator_id = ?
         AND local_folders.is_active = 1
         AND local_works.is_active = 1
         AND local_works.match_status <> 'matched'
       ORDER BY local_works.folder_name COLLATE NOCASE`
    ).all(creatorId) as Array<{
      folder_name: string;
      relative_path: string;
      parsed_source_order: number | null;
      match_status: 'unmatched' | 'ambiguous';
    }>;

    return {
      ...item,
      localFolders: this.listLocalFolders().filter(folder => folder.creatorId === creatorId),
      unlinkedLocalFolders: this.listLocalFolders().filter(folder => folder.creatorId === null),
      impact: {
        sources:item.sourceCount,collections:item.sourceCollections,remoteWorks:item.remoteWorks,localWorks:item.localWorks,localFolders:item.localFolderCount,
        unfinishedDownloadTasks: (this.database.prepare(`SELECT count(*) AS count FROM archive_catalog_download_tasks tasks
          JOIN archive_catalog_source_works sw ON sw.id=tasks.source_work_id JOIN archive_catalog_works works ON works.id=sw.work_id
          WHERE works.creator_id=? AND tasks.status NOT IN ('ingested','cancelled')`).get(creatorId) as {count:number}).count
      },
      // Same-name source/history rows are evidence. Only redundant manual rows
      // are omitted from the editor while older databases await migration.
      aliases: aliases.filter(alias => alias.source !== 'manual' || alias.alias !== item.name).map((alias) => ({
        id:Buffer.from(JSON.stringify([alias.source,alias.normalized_alias])).toString('base64url'),
        alias:alias.alias,source:alias.source,editable:alias.source==='manual'
      })),
      sources: sources.map((source) => ({
        source: source.source,
        sourceCreatorId: source.source_creator_id,
        displayName: source.source_display_name,
        url: source.source_url,
        firstSeenAt: source.first_seen_at,
        lastSeenAt: source.last_seen_at
      })),
      collections: collectionRows.map((collection) => ({
        id: collection.id,
        source: collection.source,
        sourceCollectionId: collection.source_collection_id,
        title: collection.title,
        url: collection.source_url,
        declaredWorkCount: collection.declared_work_count,
        observedAt: collection.observed_at,
        deliveries: (deliveriesByCollection.get(collection.id) ?? []).map((delivery) => ({
          provider: delivery.provider,
          type: delivery.delivery_type,
          status: delivery.status,
          sourceFolderName: delivery.source_folder_name,
          destinationPath: delivery.destination_path,
          transferredAt: delivery.transferred_at
        }))
      })),
      missing: missing.map((work) => ({
        workId: work.work_id,
        source: work.source,
        sourceCollectionId: work.source_collection_id,
        sourceOrder: work.source_order,
        sourceOrderLabel: work.source_order_label,
        title: work.source_title
      })),
      unresolved: unresolved.map((work) => ({
        folderName: work.folder_name,
        relativePath: work.relative_path,
        parsedSourceOrder: work.parsed_source_order,
        status: work.match_status
      }))
    };
  }

  listLocalFolders(): ManagedLocalFolder[] {
    const rows=this.database.prepare(`SELECT folders.id, folders.name, folders.folder_path, local.id AS catalog_id,
      local.creator_id, local.match_status, local.match_method,
      (SELECT count(*) FROM posts WHERE folder_id=folders.id AND is_deleted=0 AND is_trashed=0) AS work_count
      FROM folders LEFT JOIN archive_catalog_local_creator_folders local
      ON local.gallery_folder_id=folders.id AND local.is_active=1
      WHERE folders.role='normal' ORDER BY folders.name COLLATE NOCASE, folders.id`).all() as Array<{
        id:number;name:string;folder_path:string;catalog_id:number|null;creator_id:number|null;
        match_status:string|null;match_method:string|null;work_count:number
      }>;
    return rows.map(row=>({id:row.id,catalogFolderId:row.catalog_id,name:row.name,folderPath:row.folder_path,
      creatorId:row.creator_id,matchStatus:row.match_status??'unmatched',matchMethod:row.match_method,workCount:row.work_count}));
  }

  private buildCreatorItems(): ArchiveCatalogCreatorListItem[] {
    const creators = this.database.prepare(
       `SELECT creators.*,
       (SELECT count(*) FROM archive_catalog_creator_aliases WHERE creator_id=creators.id AND alias COLLATE BINARY<>creators.canonical_name COLLATE BINARY) AS alias_count,
       (SELECT count(*) FROM archive_catalog_creator_sources WHERE creator_id=creators.id AND source NOT IN ('hentaiclub','manual-history')) AS source_count,
       (SELECT count(*) FROM archive_catalog_local_creator_folders WHERE creator_id=creators.id AND is_active=1 AND gallery_folder_id IS NOT NULL) AS local_folder_count
       FROM archive_catalog_creators creators`
    ).all() as CreatorRow[];
    const collections = this.database.prepare(
      `SELECT id, creator_id, observed_at
       FROM archive_catalog_collections
       WHERE is_active = 1`
    ).all() as CollectionRow[];
    const remoteWorks = this.database.prepare(
      `SELECT works.creator_id, works.id AS work_id
       FROM archive_catalog_source_works source_works
       JOIN archive_catalog_works works ON works.id = source_works.work_id
       JOIN archive_catalog_collections collections ON collections.id = source_works.collection_id
       WHERE source_works.is_active = 1 AND collections.is_active = 1`
    ).all() as RemoteWorkRow[];
    const missingRows=this.database.prepare(`SELECT DISTINCT works.creator_id,works.id AS work_id FROM archive_catalog_source_works source_works JOIN archive_catalog_works works ON works.id=source_works.work_id JOIN archive_catalog_collections c ON c.id=source_works.collection_id WHERE source_works.is_active=1 AND c.is_active=1 AND ${sourceNeedsAcquisitionSql('source_works')}`).all() as RemoteWorkRow[];
    const localWorks = this.database.prepare(
      `SELECT local_folders.creator_id, local_works.work_id, local_works.match_status
       FROM archive_catalog_local_works local_works
       JOIN archive_catalog_local_creator_folders local_folders
         ON local_folders.id = local_works.local_creator_folder_id
       WHERE local_works.is_active = 1 AND local_folders.is_active = 1`
    ).all() as LocalWorkRow[];

    const collectionsByCreator = new Map<number, Set<number>>();
    const latestObservationByCreator = new Map<number, string>();
    const remoteByCreator = new Map<number, Set<number>>();
    const matchedByCreator = new Map<number, Set<number>>();
    const localCountByCreator = new Map<number, number>();
    const unresolvedCountByCreator = new Map<number, number>();
    for (const collection of collections) {
      addToSetMap(collectionsByCreator, collection.creator_id, collection.id);
      const current = latestObservationByCreator.get(collection.creator_id);
      if (!current || collection.observed_at > current) {
        latestObservationByCreator.set(collection.creator_id, collection.observed_at);
      }
    }
    for (const work of remoteWorks) addToSetMap(remoteByCreator, work.creator_id, work.work_id);
    for (const work of localWorks) {
      if (work.creator_id === null) continue;
      increment(localCountByCreator, work.creator_id);
      if (work.work_id !== null && work.match_status === 'matched') {
        addToSetMap(matchedByCreator, work.creator_id, work.work_id);
      }
      if (work.match_status !== 'matched') increment(unresolvedCountByCreator, work.creator_id);
    }

    return creators.map((creator) => {
      const remote = remoteByCreator.get(creator.id) ?? new Set<number>();
      const matched = matchedByCreator.get(creator.id) ?? new Set<number>();
      const missingWorks = missingRows.filter(row=>row.creator_id===creator.id).length;
      return {
        id: creator.id,
        name: creator.canonical_name,
        isActive: creator.is_active === 1,
        seedSource:creator.seed_source,
        seedSourceCreatorId:creator.seed_source_creator_id,
        createdAt:creator.created_at,
        updatedAt:creator.updated_at,
        deactivatedAt:creator.deactivated_at,
        aliasCount:creator.alias_count,
        sourceCount:creator.source_count,
        localFolderCount:creator.local_folder_count,
        preference: creator.preference,
        rating: creator.effective_rating,
        sourceCollections: collectionsByCreator.get(creator.id)?.size ?? 0,
        remoteWorks: remote.size,
        localWorks: localCountByCreator.get(creator.id) ?? 0,
        matchedWorks: matched.size,
        missingWorks,
        unresolvedLocalWorks: unresolvedCountByCreator.get(creator.id) ?? 0,
        latestSourceObservation: latestObservationByCreator.get(creator.id) ?? null
      };
    }).sort((left, right) => (
      right.missingWorks - left.missingWorks
      || right.unresolvedLocalWorks - left.unresolvedLocalWorks
      || left.name.localeCompare(right.name, 'zh-CN')
    ));
  }

  private buildSummary(items: ArchiveCatalogCreatorListItem[]): ArchiveCatalogSummary {
    const scalar = this.database.prepare(
      `SELECT
         (SELECT COUNT(*) FROM archive_catalog_collections WHERE is_active = 1) AS source_collections,
         (SELECT COUNT(*) FROM archive_catalog_local_creator_folders
          WHERE is_active = 1 AND match_status <> 'matched') AS unresolved_creator_folders`
    ).get() as { source_collections: number; unresolved_creator_folders: number };

    return {
      creators: items.length,
      activeCreators:items.filter(item=>item.isActive).length,
      inactiveCreators:items.filter(item=>!item.isActive).length,
      unsetPreference:items.filter(item=>item.preference===null).length,
      unclassified:items.filter(item=>item.rating===null).length,
      creatorsWithoutLocalWorks:items.filter(item=>item.localWorks===0).length,
      unlinkedLocalFolders:this.listLocalFolders().filter(folder=>folder.workCount>0&&folder.creatorId===null).length,
      liked: items.filter((item) => item.preference === 'liked').length,
      kept: items.filter((item) => item.preference === 'kept').length,
      r15: items.filter((item) => item.rating === 'R15').length,
      r18: items.filter((item) => item.rating === 'R18').length,
      creatorsWithSources: items.filter((item) => item.sourceCollections > 0).length,
      creatorsWithLocalWorks: items.filter((item) => item.localWorks > 0).length,
      sourceCollections: scalar.source_collections,
      remoteWorks: items.reduce((sum, item) => sum + item.remoteWorks, 0),
      localWorks: items.reduce((sum, item) => sum + item.localWorks, 0),
      matchedWorks: items.reduce((sum, item) => sum + item.matchedWorks, 0),
      missingWorks: items.reduce((sum, item) => sum + item.missingWorks, 0),
      unresolvedCreatorFolders: scalar.unresolved_creator_folders,
      unresolvedLocalWorks: items.reduce((sum, item) => sum + item.unresolvedLocalWorks, 0)
    };
  }
}
