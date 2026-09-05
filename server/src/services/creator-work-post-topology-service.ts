import { createHash } from 'node:crypto';

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { databaseManager } from '../db/database.js';
import type { PostType, TakenAtSource } from '../types/models.js';
import { normalizePath } from '../utils/path-utils.js';

export type CreatorWorkPostTopologyErrorCode =
  | 'POST_ITEM_ACTIVE_OWNER_CONFLICT'
  | 'LEGACY_POST_SPLIT_AMBIGUOUS'
  | 'LEGACY_POST_SPLIT_UNMAPPED_ITEM'
  | 'LEGACY_POST_SPLIT_CROSS_CREATOR'
  | 'LEGACY_POST_SPLIT_REQUIRES_REVIEW'
  | 'LEGACY_POST_SPLIT_CONCURRENT_CHANGE';

export interface CreatorWorkPostTopologyItem {
  imageId: number;
  position: number;
}

export interface CreatorWorkPostTopologyEntry {
  ownerFolderId: number;
  workFolderId: number;
  sourcePath: string;
  items: CreatorWorkPostTopologyItem[];
  postType: PostType;
  sortTimestamp: number;
  takenAt: number | null;
  takenAtSource: TakenAtSource | null;
  placeId: number | null;
}

export interface CreatorWorkPostTopologyConflict {
  code: CreatorWorkPostTopologyErrorCode;
  message: string;
  legacyPostId?: number;
  legacySourcePath?: string;
  targetSourcePath?: string;
  imageIds?: number[];
  currentOwnerPostId?: number;
  expectedDestinationPostId?: number | null;
  references?: string[];
}

export interface CreatorWorkPostTopologySummary {
  creatorFolderId: number;
  creatorPath: string;
  revision: string;
  canApply: boolean;
  destinationWorks: number;
  destinationExistingPosts: number;
  postsToCreate: number;
  itemsToTransfer: number;
  postsToRetire: number;
  affectedLegacyPosts: Array<{ id: number; sourcePath: string; itemCount: number }>;
  affectedImages: number[];
  userStateConflicts: CreatorWorkPostTopologyConflict[];
  unmappedItems: CreatorWorkPostTopologyConflict[];
  activeOwnerConflicts: CreatorWorkPostTopologyConflict[];
  conflicts: CreatorWorkPostTopologyConflict[];
  createdPosts: number;
  updatedPosts: number;
  transferredItems: number;
  retiredPosts: number;
  destinationPostIds: Array<{ sourcePath: string; postId: number }>;
}

export interface ReconcileCreatorWorkPostTopologyInput {
  ownerFolderId: number;
  creatorPath: string;
  entries: CreatorWorkPostTopologyEntry[];
  pathExists: (relativePath: string) => boolean;
}

export interface ReconcileCreatorWorkPostTopologyOptions {
  dryRun: boolean;
  expectedRevision?: string;
}

interface PostRow {
  id: number;
  folder_id: number;
  place_id: number | null;
  source_path: string;
  post_type: PostType;
  caption: string | null;
  sort_timestamp: number;
  taken_at: number | null;
  taken_at_source: TakenAtSource | null;
  is_deleted: number;
  deleted_at: string | null;
  is_trashed: number;
  trashed_at: string | null;
  content_rating: 'R15' | 'R18';
  created_at: string;
  updated_at: string;
}

interface ImageRow {
  id: number;
  folder_id: number;
  relative_path: string;
  absolute_path: string;
  is_deleted: number;
  is_trashed: number;
}

interface FolderRow {
  id: number;
  folder_path: string;
  role: string;
  carousel_owner_folder_id: number | null;
}

interface DestinationPlan {
  entry: CreatorWorkPostTopologyEntry;
  post: PostRow | null;
  currentItems: CreatorWorkPostTopologyItem[];
  needsMetadataUpdate: boolean;
  needsItemsRebuild: boolean;
}

interface InternalPlan {
  summary: CreatorWorkPostTopologySummary;
  destinations: DestinationPlan[];
  legacyPosts: PostRow[];
}

export class CreatorWorkPostTopologyError extends Error {
  readonly code: CreatorWorkPostTopologyErrorCode;
  readonly conflict: CreatorWorkPostTopologyConflict;

  constructor(conflict: CreatorWorkPostTopologyConflict, summary: CreatorWorkPostTopologySummary) {
    const evidence = {
      code: conflict.code,
      creatorFolderId: summary.creatorFolderId,
      creatorPath: summary.creatorPath,
      destinationWorks: summary.destinationWorks,
      itemsToTransfer: summary.itemsToTransfer,
      conflictCount: summary.conflicts.length,
      legacyPostId: conflict.legacyPostId ?? null,
      legacySourcePath: conflict.legacySourcePath ?? null,
      targetSourcePath: conflict.targetSourcePath ?? null,
      imageIds: conflict.imageIds ?? [],
      currentOwnerPostId: conflict.currentOwnerPostId ?? null,
      expectedDestinationPostId: conflict.expectedDestinationPostId ?? null,
      rolledBack: true
    };
    super(`${conflict.code}: ${conflict.message}; evidence=${JSON.stringify(evidence)}`);
    this.name = 'CreatorWorkPostTopologyError';
    this.code = conflict.code;
    this.conflict = conflict;
  }
}

function all<T>(database: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  return database.prepare(sql).all(...params) as unknown as T[];
}

function get<T>(database: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | undefined {
  return database.prepare(sql).get(...params) as T | undefined;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function chunked<T>(values: T[], size = 500): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function listByIds<T>(database: DatabaseSync, table: string, ids: number[]): T[] {
  const rows: T[] = [];
  for (const chunk of chunked([...new Set(ids)])) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(',');
    rows.push(...all<T>(database, `SELECT * FROM ${quoteIdentifier(table)} WHERE id IN (${placeholders}) ORDER BY id`, ...chunk));
  }
  return rows;
}

function listOwnersByImageIds(
  database: DatabaseSync,
  imageIds: number[]
): Array<{ image_id: number; post_id: number }> {
  const rows: Array<{ image_id: number; post_id: number }> = [];
  for (const chunk of chunked([...new Set(imageIds)])) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(',');
    rows.push(...all<{ image_id: number; post_id: number }>(
      database,
      `SELECT image_id, post_id FROM post_items WHERE image_id IN (${placeholders}) ORDER BY image_id`,
      ...chunk
    ));
  }
  return rows;
}

function canonicalItems(items: CreatorWorkPostTopologyItem[]): CreatorWorkPostTopologyItem[] {
  return [...items]
    .map((item) => ({ imageId: Number(item.imageId), position: Number(item.position) }))
    .sort((left, right) => left.position - right.position || left.imageId - right.imageId);
}

function itemSetsEqual(left: CreatorWorkPostTopologyItem[], right: CreatorWorkPostTopologyItem[]): boolean {
  if (left.length !== right.length) return false;
  const leftIds = [...left].map((item) => item.imageId).sort((a, b) => a - b);
  const rightIds = [...right].map((item) => item.imageId).sort((a, b) => a - b);
  return leftIds.every((imageId, index) => imageId === rightIds[index]);
}

function orderedItemsEqual(left: CreatorWorkPostTopologyItem[], right: CreatorWorkPostTopologyItem[]): boolean {
  if (left.length !== right.length) return false;
  const orderedLeft = canonicalItems(left);
  const orderedRight = canonicalItems(right);
  return orderedLeft.every((item, index) => (
    item.imageId === orderedRight[index]?.imageId && item.position === orderedRight[index]?.position
  ));
}

function addConflict(
  conflicts: CreatorWorkPostTopologyConflict[],
  conflict: CreatorWorkPostTopologyConflict
): void {
  const key = JSON.stringify({
    code: conflict.code,
    legacyPostId: conflict.legacyPostId ?? null,
    targetSourcePath: conflict.targetSourcePath ?? null,
    imageIds: conflict.imageIds ?? [],
    currentOwnerPostId: conflict.currentOwnerPostId ?? null,
    references: conflict.references ?? []
  });
  if (!conflicts.some((candidate) => JSON.stringify({
    code: candidate.code,
    legacyPostId: candidate.legacyPostId ?? null,
    targetSourcePath: candidate.targetSourcePath ?? null,
    imageIds: candidate.imageIds ?? [],
    currentOwnerPostId: candidate.currentOwnerPostId ?? null,
    references: candidate.references ?? []
  }) === key)) {
    conflicts.push(conflict);
  }
}

function listExternalPostReferences(database: DatabaseSync, postId: number): string[] {
  const ignored = new Set(['post_items', 'likes', 'collection_items']);
  const references: string[] = [];
  const tables = all<{ name: string }>(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );

  for (const { name } of tables) {
    if (ignored.has(name)) continue;
    const foreignKeys = all<{ table: string; from: string }>(
      database,
      `PRAGMA foreign_key_list(${quoteIdentifier(name)})`
    );
    for (const foreignKey of foreignKeys) {
      if (foreignKey.table !== 'posts') continue;
      const count = Number((get<{ count: number }>(
        database,
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)} WHERE ${quoteIdentifier(foreignKey.from)} = ?`,
        postId
      )?.count) ?? 0);
      if (count > 0) references.push(`${name}.${foreignKey.from}:${count}`);
    }
  }

  return references;
}

function listUserStateReferences(database: DatabaseSync, post: PostRow): string[] {
  const references: string[] = [];
  if (post.caption?.trim()) references.push('caption');
  if (post.is_trashed === 1 || post.trashed_at !== null) references.push('trash');
  if (post.place_id !== null) references.push('place');
  // R15 is the schema default. A non-default R18 value can only be retained safely by review.
  if (post.content_rating !== 'R15') references.push('content_rating');
  const likeCount = Number(get<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM likes WHERE post_id = ?', post.id)?.count ?? 0);
  if (likeCount > 0) references.push(`likes:${likeCount}`);
  const collectionCount = Number(get<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM collection_items WHERE post_id = ?', post.id)?.count ?? 0);
  if (collectionCount > 0) references.push(`collection_items:${collectionCount}`);
  references.push(...listExternalPostReferences(database, post.id));
  return references;
}

function computeRevision(database: DatabaseSync, ownerFolderId: number, desiredImageIds: number[]): string {
  const ownerPosts = all<PostRow>(database, 'SELECT * FROM posts WHERE folder_id = ? ORDER BY id', ownerFolderId);
  const ownerPostIds = ownerPosts.map((post) => post.id);
  const relatedOwnerRows = listOwnersByImageIds(database, desiredImageIds);
  const relatedPostIds = [...new Set([...ownerPostIds, ...relatedOwnerRows.map((row) => row.post_id)])];
  const relatedPosts = listByIds<PostRow>(database, 'posts', relatedPostIds);
  const folders = all<FolderRow>(
    database,
    'SELECT * FROM folders WHERE id = ? OR carousel_owner_folder_id = ? ORDER BY id',
    ownerFolderId,
    ownerFolderId
  );
  const folderIds = folders.map((folder) => folder.id);
  const images: unknown[] = [];
  for (const chunk of chunked(folderIds)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(',');
    images.push(...all(database, `SELECT * FROM images WHERE folder_id IN (${placeholders}) ORDER BY id`, ...chunk));
  }
  const postItems: unknown[] = [];
  const likes: unknown[] = [];
  const collections: unknown[] = [];
  for (const chunk of chunked(relatedPostIds)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(',');
    postItems.push(...all(database, `SELECT * FROM post_items WHERE post_id IN (${placeholders}) ORDER BY post_id, position`, ...chunk));
    likes.push(...all(database, `SELECT * FROM likes WHERE post_id IN (${placeholders}) ORDER BY post_id`, ...chunk));
    collections.push(...all(database, `SELECT * FROM collection_items WHERE post_id IN (${placeholders}) ORDER BY collection_id, post_id`, ...chunk));
  }
  return createHash('sha256').update(JSON.stringify({ folders, images, posts: relatedPosts, postItems, likes, collections })).digest('hex');
}

function normalizeAndValidateEntries(
  input: ReconcileCreatorWorkPostTopologyInput,
  conflicts: CreatorWorkPostTopologyConflict[]
): CreatorWorkPostTopologyEntry[] {
  const entries = input.entries.map((entry) => ({
    ...entry,
    sourcePath: normalizePath(entry.sourcePath),
    items: canonicalItems(entry.items)
  }));
  const sourcePaths = new Map<string, number>();
  const imageTargets = new Map<number, string>();

  for (const entry of entries) {
    if (entry.ownerFolderId !== input.ownerFolderId) {
      addConflict(conflicts, {
        code: 'LEGACY_POST_SPLIT_CROSS_CREATOR',
        message: `Topology entry ${entry.sourcePath} belongs to owner ${entry.ownerFolderId}, expected ${input.ownerFolderId}`,
        targetSourcePath: entry.sourcePath,
        imageIds: entry.items.map((item) => item.imageId)
      });
    }
    const sourceCount = (sourcePaths.get(entry.sourcePath) ?? 0) + 1;
    sourcePaths.set(entry.sourcePath, sourceCount);
    if (sourceCount > 1) {
      addConflict(conflicts, {
        code: 'LEGACY_POST_SPLIT_AMBIGUOUS',
        message: `Source path ${entry.sourcePath} appears more than once in the expected topology`,
        targetSourcePath: entry.sourcePath
      });
    }
    if (entry.items.length === 0) {
      addConflict(conflicts, {
        code: 'LEGACY_POST_SPLIT_AMBIGUOUS',
        message: `Target ${entry.sourcePath} has no media items`,
        targetSourcePath: entry.sourcePath
      });
    }
    for (let index = 0; index < entry.items.length; index += 1) {
      const item = entry.items[index]!;
      if (item.position !== index + 1) {
        addConflict(conflicts, {
          code: 'LEGACY_POST_SPLIT_AMBIGUOUS',
          message: `Target ${entry.sourcePath} has a non-contiguous item position`,
          targetSourcePath: entry.sourcePath,
          imageIds: [item.imageId]
        });
      }
      const existingTarget = imageTargets.get(item.imageId);
      if (existingTarget && existingTarget !== entry.sourcePath) {
        addConflict(conflicts, {
          code: 'LEGACY_POST_SPLIT_AMBIGUOUS',
          message: `Image ${item.imageId} appears in multiple expected works`,
          targetSourcePath: entry.sourcePath,
          imageIds: [item.imageId]
        });
      } else {
        imageTargets.set(item.imageId, entry.sourcePath);
      }
    }
  }

  return entries;
}

function buildPlan(database: DatabaseSync, input: ReconcileCreatorWorkPostTopologyInput): InternalPlan {
  const conflicts: CreatorWorkPostTopologyConflict[] = [];
  const entries = normalizeAndValidateEntries(input, conflicts);
  const desiredImageIds = entries.flatMap((entry) => entry.items.map((item) => item.imageId));
  const desiredImageIdSet = new Set(desiredImageIds);
  const activeSourcePaths = new Set(entries.map((entry) => entry.sourcePath));
  const ownerFolder = get<FolderRow>(database, 'SELECT id, folder_path, role, carousel_owner_folder_id FROM folders WHERE id = ?', input.ownerFolderId);
  if (!ownerFolder || ownerFolder.role !== 'normal' || normalizePath(ownerFolder.folder_path) !== normalizePath(input.creatorPath)) {
    addConflict(conflicts, {
      code: 'LEGACY_POST_SPLIT_CROSS_CREATOR',
      message: `Creator owner folder ${input.ownerFolderId} does not match ${normalizePath(input.creatorPath)}`
    });
  }

  const workFolders = listByIds<FolderRow>(database, 'folders', entries.map((entry) => entry.workFolderId));
  const workFolderById = new Map(workFolders.map((folder) => [folder.id, folder]));
  const images = listByIds<ImageRow>(database, 'images', desiredImageIds);
  const imageById = new Map(images.map((image) => [image.id, image]));
  const expectedEntryByImageId = new Map<number, CreatorWorkPostTopologyEntry>();
  for (const entry of entries) {
    const folder = workFolderById.get(entry.workFolderId);
    if (!folder || folder.role !== 'carousel_source' || folder.carousel_owner_folder_id !== input.ownerFolderId || normalizePath(folder.folder_path) !== entry.sourcePath) {
      addConflict(conflicts, {
        code: 'LEGACY_POST_SPLIT_CROSS_CREATOR',
        message: `Work folder ${entry.workFolderId} is not an active work of creator ${input.ownerFolderId}`,
        targetSourcePath: entry.sourcePath,
        imageIds: entry.items.map((item) => item.imageId)
      });
    }
    for (const item of entry.items) {
      expectedEntryByImageId.set(item.imageId, entry);
      const image = imageById.get(item.imageId);
      if (!image) {
        addConflict(conflicts, {
          code: 'LEGACY_POST_SPLIT_UNMAPPED_ITEM',
          message: `Expected image ${item.imageId} no longer exists`,
          targetSourcePath: entry.sourcePath,
          imageIds: [item.imageId]
        });
        continue;
      }
      if (image.folder_id !== entry.workFolderId) {
        const actualFolder = get<FolderRow>(database, 'SELECT id, folder_path, role, carousel_owner_folder_id FROM folders WHERE id = ?', image.folder_id);
        addConflict(conflicts, {
          code: actualFolder?.carousel_owner_folder_id !== input.ownerFolderId
            ? 'LEGACY_POST_SPLIT_CROSS_CREATOR'
            : 'LEGACY_POST_SPLIT_UNMAPPED_ITEM',
          message: `Image ${item.imageId} is indexed under folder ${image.folder_id}, expected ${entry.workFolderId}`,
          targetSourcePath: entry.sourcePath,
          imageIds: [item.imageId]
        });
      }
      const normalizedImagePath = normalizePath(image.relative_path);
      if (!normalizedImagePath.startsWith(`${entry.sourcePath}/`) || image.is_deleted === 1 || image.is_trashed === 1 || !input.pathExists(normalizedImagePath)) {
        addConflict(conflicts, {
          code: 'LEGACY_POST_SPLIT_UNMAPPED_ITEM',
          message: `Image ${item.imageId} does not have a present, active path inside ${entry.sourcePath}`,
          targetSourcePath: entry.sourcePath,
          imageIds: [item.imageId]
        });
      }
    }
  }

  const ownerPosts = all<PostRow>(database, 'SELECT * FROM posts WHERE folder_id = ? ORDER BY id', input.ownerFolderId);
  const itemsByPost = new Map<number, CreatorWorkPostTopologyItem[]>();
  for (const row of all<{ post_id: number; image_id: number; position: number }>(
    database,
    'SELECT pi.post_id, pi.image_id, pi.position FROM post_items pi INNER JOIN posts p ON p.id = pi.post_id WHERE p.folder_id = ? ORDER BY pi.post_id, pi.position',
    input.ownerFolderId
  )) {
    const items = itemsByPost.get(row.post_id) ?? [];
    items.push({ imageId: row.image_id, position: row.position });
    itemsByPost.set(row.post_id, items);
  }
  const postsBySource = new Map<string, PostRow[]>();
  for (const post of ownerPosts) {
    const sourcePath = normalizePath(post.source_path);
    const posts = postsBySource.get(sourcePath) ?? [];
    posts.push(post);
    postsBySource.set(sourcePath, posts);
  }

  const destinations: DestinationPlan[] = [];
  const selectedDestinationIds = new Set<number>();
  for (const entry of entries) {
    const sourceMatches = postsBySource.get(entry.sourcePath) ?? [];
    if (sourceMatches.length > 1) {
      addConflict(conflicts, {
        code: 'LEGACY_POST_SPLIT_AMBIGUOUS',
        message: `Multiple Posts use source path ${entry.sourcePath}`,
        targetSourcePath: entry.sourcePath
      });
    }
    const exactMatches = ownerPosts.filter((post) => itemSetsEqual(itemsByPost.get(post.id) ?? [], entry.items));
    if (exactMatches.length > 1) {
      addConflict(conflicts, {
        code: 'LEGACY_POST_SPLIT_AMBIGUOUS',
        message: `Multiple Posts have the exact media set for ${entry.sourcePath}`,
        targetSourcePath: entry.sourcePath,
        imageIds: entry.items.map((item) => item.imageId)
      });
    }
    const sourcePost = sourceMatches[0] ?? null;
    const exactPost = exactMatches[0] ?? null;
    if (sourcePost && exactPost && sourcePost.id !== exactPost.id) {
      addConflict(conflicts, {
        code: 'LEGACY_POST_SPLIT_AMBIGUOUS',
        message: `Source-path and exact-membership matching disagree for ${entry.sourcePath}`,
        targetSourcePath: entry.sourcePath,
        currentOwnerPostId: exactPost.id,
        expectedDestinationPostId: sourcePost.id,
        imageIds: entry.items.map((item) => item.imageId)
      });
    }
    const post = sourcePost ?? exactPost;
    if (
      post
      && sourcePost === null
      && normalizePath(post.source_path) !== entry.sourcePath
      && input.pathExists(normalizePath(post.source_path))
    ) {
      addConflict(conflicts, {
        code: 'POST_ITEM_ACTIVE_OWNER_CONFLICT',
        message: `Exact-media Post ${post.id} still represents the present source path ${normalizePath(post.source_path)}`,
        legacyPostId: post.id,
        legacySourcePath: post.source_path,
        targetSourcePath: entry.sourcePath,
        imageIds: entry.items.map((item) => item.imageId),
        currentOwnerPostId: post.id,
        expectedDestinationPostId: null
      });
    }
    if (post && post.folder_id !== input.ownerFolderId) {
      addConflict(conflicts, {
        code: 'LEGACY_POST_SPLIT_CROSS_CREATOR',
        message: `Destination Post ${post.id} belongs to another creator`,
        targetSourcePath: entry.sourcePath,
        currentOwnerPostId: post.id,
        imageIds: entry.items.map((item) => item.imageId)
      });
    }
    if (post && selectedDestinationIds.has(post.id)) {
      addConflict(conflicts, {
        code: 'LEGACY_POST_SPLIT_AMBIGUOUS',
        message: `Post ${post.id} was selected for multiple destination works`,
        targetSourcePath: entry.sourcePath,
        currentOwnerPostId: post.id
      });
    }
    if (post) selectedDestinationIds.add(post.id);
    const currentItems = post ? canonicalItems(itemsByPost.get(post.id) ?? []) : [];
    const desiredIds = new Set(entry.items.map((item) => item.imageId));
    const extraItems = currentItems.filter((item) => !desiredIds.has(item.imageId));
    if (extraItems.length > 0) {
      addConflict(conflicts, {
        code: 'POST_ITEM_ACTIVE_OWNER_CONFLICT',
        message: `Active destination Post ${post!.id} contains media outside ${entry.sourcePath}`,
        targetSourcePath: entry.sourcePath,
        currentOwnerPostId: post!.id,
        expectedDestinationPostId: post!.id,
        imageIds: extraItems.map((item) => item.imageId)
      });
    }
    const needsMetadataUpdate = Boolean(post && (
      post.folder_id !== input.ownerFolderId
      || normalizePath(post.source_path) !== entry.sourcePath
      || post.post_type !== entry.postType
      || post.sort_timestamp !== entry.sortTimestamp
      || post.taken_at !== entry.takenAt
      || post.taken_at_source !== entry.takenAtSource
      || post.is_deleted !== 0
    ));
    destinations.push({
      entry,
      post,
      currentItems,
      needsMetadataUpdate,
      needsItemsRebuild: !orderedItemsEqual(currentItems, entry.items)
    });
  }

  const destinationByImageId = new Map<number, DestinationPlan>();
  for (const destination of destinations) {
    for (const item of destination.entry.items) destinationByImageId.set(item.imageId, destination);
  }
  const owners = listOwnersByImageIds(database, desiredImageIds);
  const ownerByImageId = new Map(owners.map((row) => [row.image_id, row.post_id]));
  const legacyPostIds = new Set<number>();
  for (const imageId of desiredImageIds) {
    const ownerPostId = ownerByImageId.get(imageId);
    if (!ownerPostId) continue;
    const destination = destinationByImageId.get(imageId)!;
    if (destination.post?.id === ownerPostId) continue;
    if (selectedDestinationIds.has(ownerPostId)) {
      addConflict(conflicts, {
        code: 'POST_ITEM_ACTIVE_OWNER_CONFLICT',
        message: `Image ${imageId} is owned by another active destination Post ${ownerPostId}`,
        targetSourcePath: destination.entry.sourcePath,
        imageIds: [imageId],
        currentOwnerPostId: ownerPostId,
        expectedDestinationPostId: destination.post?.id ?? null
      });
      continue;
    }
    legacyPostIds.add(ownerPostId);
  }

  const legacyPosts = listByIds<PostRow>(database, 'posts', [...legacyPostIds]);
  const legacyPostById = new Map(legacyPosts.map((post) => [post.id, post]));
  for (const legacyPostId of legacyPostIds) {
    const legacyPost = legacyPostById.get(legacyPostId);
    if (!legacyPost) {
      addConflict(conflicts, {
        code: 'LEGACY_POST_SPLIT_CONCURRENT_CHANGE',
        message: `Current owner Post ${legacyPostId} disappeared during topology inspection`,
        legacyPostId
      });
      continue;
    }
    const legacyItems = all<{ image_id: number; position: number }>(
      database,
      'SELECT image_id, position FROM post_items WHERE post_id = ? ORDER BY position',
      legacyPost.id
    );
    if (legacyPost.folder_id !== input.ownerFolderId) {
      addConflict(conflicts, {
        code: 'LEGACY_POST_SPLIT_CROSS_CREATOR',
        message: `Legacy owner Post ${legacyPost.id} belongs to creator folder ${legacyPost.folder_id}`,
        legacyPostId: legacyPost.id,
        legacySourcePath: legacyPost.source_path,
        imageIds: legacyItems.map((item) => item.image_id)
      });
      continue;
    }
    if (activeSourcePaths.has(normalizePath(legacyPost.source_path)) || input.pathExists(normalizePath(legacyPost.source_path))) {
      addConflict(conflicts, {
        code: 'POST_ITEM_ACTIVE_OWNER_CONFLICT',
        message: `Current owner Post ${legacyPost.id} still represents an active source path`,
        legacyPostId: legacyPost.id,
        legacySourcePath: legacyPost.source_path,
        imageIds: legacyItems.map((item) => item.image_id),
        currentOwnerPostId: legacyPost.id
      });
    }
    const unmapped = legacyItems.filter((item) => !desiredImageIdSet.has(item.image_id));
    if (unmapped.length > 0) {
      addConflict(conflicts, {
        code: 'LEGACY_POST_SPLIT_UNMAPPED_ITEM',
        message: `Legacy Post ${legacyPost.id} has media that cannot be assigned to a current work`,
        legacyPostId: legacyPost.id,
        legacySourcePath: legacyPost.source_path,
        imageIds: unmapped.map((item) => item.image_id)
      });
    }
    const references = listUserStateReferences(database, legacyPost);
    if (references.length > 0) {
      addConflict(conflicts, {
        code: 'LEGACY_POST_SPLIT_REQUIRES_REVIEW',
        message: `Legacy Post ${legacyPost.id} has Post-level user state that cannot be distributed automatically`,
        legacyPostId: legacyPost.id,
        legacySourcePath: legacyPost.source_path,
        imageIds: legacyItems.map((item) => item.image_id),
        references
      });
    }
    for (const item of legacyItems) {
      const destination = expectedEntryByImageId.get(item.image_id);
      const image = imageById.get(item.image_id);
      if (!destination || !image) continue;
      if (image.folder_id !== destination.workFolderId || !normalizePath(image.relative_path).startsWith(`${destination.sourcePath}/`)) {
        addConflict(conflicts, {
          code: 'LEGACY_POST_SPLIT_UNMAPPED_ITEM',
          message: `Legacy Post ${legacyPost.id} image ${item.image_id} is not indexed at its expected current work path`,
          legacyPostId: legacyPost.id,
          legacySourcePath: legacyPost.source_path,
          targetSourcePath: destination.sourcePath,
          imageIds: [item.image_id]
        });
      }
    }
  }

  const revision = computeRevision(database, input.ownerFolderId, desiredImageIds);
  const affectedImages = owners
    .filter((owner) => destinationByImageId.get(owner.image_id)?.post?.id !== owner.post_id)
    .map((owner) => owner.image_id)
    .sort((left, right) => left - right);
  const userStateConflicts = conflicts.filter((conflict) => conflict.code === 'LEGACY_POST_SPLIT_REQUIRES_REVIEW');
  const unmappedItems = conflicts.filter((conflict) => conflict.code === 'LEGACY_POST_SPLIT_UNMAPPED_ITEM');
  const activeOwnerConflicts = conflicts.filter((conflict) => conflict.code === 'POST_ITEM_ACTIVE_OWNER_CONFLICT');
  const summary: CreatorWorkPostTopologySummary = {
    creatorFolderId: input.ownerFolderId,
    creatorPath: normalizePath(input.creatorPath),
    revision,
    canApply: conflicts.length === 0,
    destinationWorks: entries.length,
    destinationExistingPosts: destinations.filter((destination) => destination.post !== null).length,
    postsToCreate: destinations.filter((destination) => destination.post === null).length,
    itemsToTransfer: affectedImages.length,
    postsToRetire: legacyPosts.length,
    affectedLegacyPosts: legacyPosts.map((post) => ({
      id: post.id,
      sourcePath: post.source_path,
      itemCount: Number(get<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM post_items WHERE post_id = ?', post.id)?.count ?? 0)
    })),
    affectedImages,
    userStateConflicts,
    unmappedItems,
    activeOwnerConflicts,
    conflicts,
    createdPosts: 0,
    updatedPosts: 0,
    transferredItems: 0,
    retiredPosts: 0,
    destinationPostIds: destinations
      .filter((destination): destination is DestinationPlan & { post: PostRow } => destination.post !== null)
      .map((destination) => ({ sourcePath: destination.entry.sourcePath, postId: destination.post.id }))
  };
  return { summary, destinations, legacyPosts };
}

function insertDestinationPost(database: DatabaseSync, destination: DestinationPlan, timestamp: string): number {
  const { entry } = destination;
  const preferredId = entry.items.length === 1 ? entry.items[0]!.imageId : null;
  const preferredAvailable = preferredId !== null
    && !get<{ id: number }>(database, 'SELECT id FROM posts WHERE id = ?', preferredId);
  if (preferredAvailable) {
    database.prepare(
      `INSERT INTO posts (
         id, folder_id, place_id, source_path, post_type, caption, sort_timestamp, taken_at, taken_at_source,
         is_deleted, deleted_at, is_trashed, trashed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, NULL, 0, NULL, ?)`
    ).run(
      preferredId,
      entry.ownerFolderId,
      entry.placeId,
      entry.sourcePath,
      entry.postType,
      entry.sortTimestamp,
      entry.takenAt,
      entry.takenAtSource,
      timestamp
    );
    return preferredId;
  }
  const result = database.prepare(
    `INSERT INTO posts (
       folder_id, place_id, source_path, post_type, caption, sort_timestamp, taken_at, taken_at_source,
       is_deleted, deleted_at, is_trashed, trashed_at, updated_at
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, NULL, 0, NULL, ?)`
  ).run(
    entry.ownerFolderId,
    entry.placeId,
    entry.sourcePath,
    entry.postType,
    entry.sortTimestamp,
    entry.takenAt,
    entry.takenAtSource,
    timestamp
  );
  return Number(result.lastInsertRowid);
}

function applyPlan(database: DatabaseSync, plan: InternalPlan): CreatorWorkPostTopologySummary {
  const timestamp = new Date().toISOString();
  const destinationPostIds = new Map<string, number>();
  let createdPosts = 0;
  let updatedPosts = 0;
  for (const destination of plan.destinations) {
    if (!destination.post) {
      destinationPostIds.set(destination.entry.sourcePath, insertDestinationPost(database, destination, timestamp));
      createdPosts += 1;
      continue;
    }
    destinationPostIds.set(destination.entry.sourcePath, destination.post.id);
    if (!destination.needsMetadataUpdate) continue;
    database.prepare(
      `UPDATE posts
       SET folder_id = ?,
           place_id = COALESCE(place_id, ?),
           source_path = ?,
           post_type = ?,
           sort_timestamp = ?,
           taken_at = ?,
           taken_at_source = ?,
           is_deleted = 0,
           deleted_at = NULL,
           updated_at = ?
       WHERE id = ?`
    ).run(
      destination.entry.ownerFolderId,
      destination.entry.placeId,
      destination.entry.sourcePath,
      destination.entry.postType,
      destination.entry.sortTimestamp,
      destination.entry.takenAt,
      destination.entry.takenAtSource,
      timestamp,
      destination.post.id
    );
    updatedPosts += 1;
  }

  const rebuiltDestinations = plan.destinations.filter((destination) => destination.needsItemsRebuild || destination.post === null);
  for (const destination of rebuiltDestinations) {
    const postId = destinationPostIds.get(destination.entry.sourcePath)!;
    database.prepare('DELETE FROM post_items WHERE post_id = ?').run(postId);
  }
  for (const legacyPost of plan.legacyPosts) {
    database.prepare('DELETE FROM post_items WHERE post_id = ?').run(legacyPost.id);
  }
  const insertItem = database.prepare('INSERT INTO post_items (post_id, image_id, position) VALUES (?, ?, ?)');
  for (const destination of rebuiltDestinations) {
    const postId = destinationPostIds.get(destination.entry.sourcePath)!;
    for (const item of destination.entry.items) insertItem.run(postId, item.imageId, item.position);
  }
  for (const legacyPost of plan.legacyPosts) {
    database.prepare(
      `UPDATE posts
       SET is_deleted = 1,
           deleted_at = COALESCE(deleted_at, ?),
           updated_at = ?
       WHERE id = ?`
    ).run(timestamp, timestamp, legacyPost.id);
  }

  for (const destination of plan.destinations) {
    const postId = destinationPostIds.get(destination.entry.sourcePath)!;
    const actualItems = all<{ image_id: number; position: number }>(
      database,
      'SELECT image_id, position FROM post_items WHERE post_id = ? ORDER BY position',
      postId
    ).map((item) => ({ imageId: item.image_id, position: item.position }));
    if (!orderedItemsEqual(actualItems, destination.entry.items)) {
      throw new Error(`Topology verification failed for destination Post ${postId}`);
    }
  }
  const desiredImageIds = plan.destinations.flatMap((destination) => (
    destination.entry.items.map((item) => item.imageId)
  ));
  const finalOwnerByImageId = new Map(
    listOwnersByImageIds(database, desiredImageIds).map((owner) => [owner.image_id, owner.post_id])
  );
  for (const destination of plan.destinations) {
    const expectedPostId = destinationPostIds.get(destination.entry.sourcePath)!;
    for (const item of destination.entry.items) {
      const actualPostId = finalOwnerByImageId.get(item.imageId);
      if (actualPostId !== expectedPostId) {
        throw new Error(
          `Topology ownership verification failed for Image ${item.imageId}: expected Post ${expectedPostId}, got ${actualPostId ?? 'none'}`
        );
      }
    }
  }
  for (const legacyPost of plan.legacyPosts) {
    const remaining = Number(get<{ count: number }>(database, 'SELECT COUNT(*) AS count FROM post_items WHERE post_id = ?', legacyPost.id)?.count ?? 0);
    if (remaining !== 0) throw new Error(`Legacy Post ${legacyPost.id} still owns ${remaining} media items`);
  }

  return {
    ...plan.summary,
    createdPosts,
    updatedPosts,
    transferredItems: plan.summary.itemsToTransfer,
    retiredPosts: plan.legacyPosts.length,
    destinationPostIds: [...destinationPostIds.entries()]
      .map(([sourcePath, postId]) => ({ sourcePath, postId }))
      .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))
  };
}

export function reconcileCreatorWorkPostTopology(
  input: ReconcileCreatorWorkPostTopologyInput,
  options: ReconcileCreatorWorkPostTopologyOptions,
  database: DatabaseSync = databaseManager.connection
): CreatorWorkPostTopologySummary {
  if (options.dryRun) return buildPlan(database, input).summary;

  try {
    database.exec('BEGIN IMMEDIATE');
  } catch (error) {
    const summary = buildPlan(database, input).summary;
    const detail = error instanceof Error ? error.message : String(error);
    throw new CreatorWorkPostTopologyError({
      code: 'LEGACY_POST_SPLIT_CONCURRENT_CHANGE',
      message: `Could not acquire an immediate transaction for creator work Post reconciliation: ${detail}`
    }, summary);
  }
  try {
    const plan = buildPlan(database, input);
    if (options.expectedRevision && plan.summary.revision !== options.expectedRevision) {
      const conflict: CreatorWorkPostTopologyConflict = {
        code: 'LEGACY_POST_SPLIT_CONCURRENT_CHANGE',
        message: `Creator work Post topology changed after dry-run (${options.expectedRevision} -> ${plan.summary.revision})`
      };
      throw new CreatorWorkPostTopologyError(conflict, plan.summary);
    }
    if (!plan.summary.canApply) {
      throw new CreatorWorkPostTopologyError(plan.summary.conflicts[0]!, plan.summary);
    }
    const result = applyPlan(database, plan);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original failure. SQLite may already have rolled back an
      // aborted transaction, and a second rollback must not hide its cause.
    }
    throw error;
  }
}
