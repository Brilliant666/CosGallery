import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { accessSync, constants, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import { databaseManager } from '../db/database.js';
import { LocalCreatorFolderBridgeService, normalizedAbsoluteCreatorPath } from './local-creator-folder-bridge-service.js';
import { normalizeCreatorIdentity } from '../utils/creator-identity.js';
import {
  areCostuanTitlesCompatible,
  mergeCostuanDirectoryWorks,
  normalizeCostuanTitle,
  parseCostuanCollectionCreator,
  splitCostuanCheckDirectory,
  type PendingCostuanSupplement,
  parseCostuanNumbering
} from './costuan-numbering-service.js';

const costuanWorkSchema = z.object({
  order: z.number().int().min(0).optional(),
  sourceOrder: z.string().trim().min(1),
  sourceOrderRaw: z.string().optional(),
  sourceOrderScheme: z.enum(['NO', 'VOL', 'SPECIAL']).optional(),
  sourceOrderKey: z.string().optional(),
  label: z.string().trim().min(1),
  rawTitle: z.string().optional(),
  mediaSummary: z.string().optional(),
  declaredImageCount: z.number().int().min(0).nullable().optional(),
  declaredVideoCount: z.number().int().min(0).nullable().optional(),
  declaredSize: z.string().nullable().optional()
}).passthrough();

const costuanRecordSchema = z.object({
  creatorId: z.string().optional(),
  creatorName: z.string().trim().min(1),
  aliases: z.array(z.string()).default([]),
  preference: z.string().optional(),
  rating: z.string().optional(),
  costuan: z.object({
    postId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    url: z.string().optional(),
    collectionCount: z.number().int().min(0).nullable().optional(),
    resourceDirectoryText: z.string().optional(),
    checkedAt: z.string().optional(),
    works: z.array(costuanWorkSchema).default([])
  }).passthrough(),
  baidu: z.object({
    sourceFolderName: z.string().optional(),
    destinationPath: z.string().optional(),
    status: z.string().optional(),
    transferredAt: z.string().optional()
  }).passthrough().nullable().optional(),
  local: z.object({ folderName: z.string().optional() }).passthrough().nullable().optional()
}).passthrough();

const costuanArchiveSchema = z.object({
  format: z.literal('costuan-archive-metadata'),
  version: z.number().int().positive(),
  exportedAt: z.string().optional(),
  records: z.record(costuanRecordSchema)
});

export type CostuanArchiveRecord = z.infer<typeof costuanRecordSchema>;

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
const ADVERTISEMENT_EXTENSIONS = new Set(['.html', '.htm', '.txt']);

type MatchStatus = 'matched' | 'unmatched' | 'ambiguous';

type LocalWorkSnapshot = {
  relativePath: string;
  absolutePath: string;
  folderName: string;
  parsedSourceOrder: number | null;
  numberingKey: string | null;
  imageCount: number;
  videoCount: number;
  advertisementFileCount: number;
  otherFileCount: number;
  totalBytes: number;
};

type LocalCreatorSnapshot = {
  relativePath: string;
  absolutePath: string;
  folderName: string;
  works: LocalWorkSnapshot[];
};

export type LocalCreatorReconciliationScope = {
  creatorId: number;
  folderName: string;
};

type ExistingLocalWorkLink = {
  relative_path: string;
  work_id: number | null;
  parsed_source_order: number | null;
  match_status: MatchStatus;
  match_method: string | null;
  work_creator_id: number | null;
  has_active_source: number;
};

type RemoteWorkRow = {
  work_id: number;
  source_work_id: string;
  source_order: number | null;
  source_order_label: string | null;
  source_title: string;
  metadata_json: string | null;
};

export type CostuanCatalogImportResult = {
  source: 'costuan';
  records: number;
  matchedCreators: number;
  unmatchedCreators: string[];
  importedWorks: number;
  addedWorks: number;
  updatedWorks: number;
  deliveries: number;
};

export type LocalReconciliationResult = {
  bridgeReview: Array<{ catalogFolderId:number; status:string; candidates:number[] }>;
  rootPath: string;
  creatorFolders: number;
  matchedCreatorFolders: number;
  unmatchedCreatorFolders: string[];
  ambiguousCreatorFolders: string[];
  localWorks: number;
  matchedWorks: number;
  unmatchedWorks: number;
  ambiguousWorks: number;
};

export type CreatorReconciliationReport = {
  creatorId: number;
  creatorName: string;
  preference: 'liked' | 'kept' | null;
  rating: 'R15' | 'R18' | null;
  remoteWorks: number;
  localWorks: number;
  matchedWorks: number;
  missingWorks: Array<{
    workId: number;
    source: string;
    collectionId: string;
    sourceOrder: number | null;
    sourceOrderLabel: string | null;
    title: string;
  }>;
  unresolvedLocalWorks: Array<{
    folderName: string;
    relativePath: string;
    parsedSourceOrder: number | null;
    status: MatchStatus;
  }>;
};

export type ArchiveCatalogReport = {
  generatedAt: string;
  rootPath: string | null;
  summary: {
    creators: number;
    creatorsWithRemoteWorks: number;
    creatorsWithLocalWorks: number;
    remoteWorks: number;
    localWorks: number;
    matchedWorks: number;
    missingWorks: number;
    unresolvedCreatorFolders: number;
    unresolvedLocalWorks: number;
  };
  unresolvedCreatorFolders: Array<{
    folderName: string;
    relativePath: string;
    status: 'unmatched' | 'ambiguous';
  }>;
  creators: CreatorReconciliationReport[];
};

function asNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

function withTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('SAVEPOINT archive_catalog_import');
  try {
    const result = operation();
    database.exec('RELEASE archive_catalog_import');
    return result;
  } catch (error) {
    database.exec('ROLLBACK TO archive_catalog_import; RELEASE archive_catalog_import');
    throw error;
  }
}

function toPosixRelative(value: string): string {
  return value.split(path.sep).join('/');
}

function collectionCreatorAlias(title: string): string | null {
  return parseCostuanCollectionCreator(title);
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function parseArchiveSourceOrder(value: string): number | null {
  const leaf = path.basename(value.replace(/\\/g, '/'));
  return parseCostuanNumbering(leaf)?.order ?? null;
}

function normalizeWorkTitle(value: string): string {
  return normalizeCostuanTitle(value);
}

function creatorPrefixedWorkTitleCandidates(value: string, creatorNames: string[]): string[] {
  const normalizedTitle = normalizeWorkTitle(value);
  if (!normalizedTitle) return [];

  const candidates = new Set<string>();
  const normalizedCreatorNames = [...new Set(
    creatorNames
      .map(normalizeWorkTitle)
      .filter((name) => name.length > 0)
  )].sort((left, right) => right.length - left.length);

  for (const creatorName of normalizedCreatorNames) {
    if (!normalizedTitle.startsWith(creatorName)) continue;
    const titleWithoutCreator = normalizedTitle.slice(creatorName.length);
    if (titleWithoutCreator) candidates.add(titleWithoutCreator);
  }
  return [...candidates];
}

function remoteWorkNumberingKey(work: RemoteWorkRow): string | null {
  if (work.metadata_json) {
    try {
      const metadata = JSON.parse(work.metadata_json) as { sourceOrderKey?: unknown };
      if (typeof metadata.sourceOrderKey === 'string' && metadata.sourceOrderKey.trim()) {
        return metadata.sourceOrderKey.trim();
      }
    } catch {
      // Legacy metadata remains usable through source_order_label/source_work_id.
    }
  }
  return parseCostuanNumbering(work.source_order_label ?? work.source_work_id)?.key ?? null;
}

async function inspectWorkDirectory(rootPath: string, workPath: string): Promise<LocalWorkSnapshot> {
  let imageCount = 0;
  let videoCount = 0;
  let advertisementFileCount = 0;
  let otherFileCount = 0;
  let totalBytes = 0;
  const pending = [workPath];

  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const extension = path.extname(entry.name).toLocaleLowerCase();
      const stat = await fs.stat(absolutePath);
      totalBytes += stat.size;
      if (IMAGE_EXTENSIONS.has(extension)) imageCount += 1;
      else if (VIDEO_EXTENSIONS.has(extension)) videoCount += 1;
      else if (ADVERTISEMENT_EXTENSIONS.has(extension)) advertisementFileCount += 1;
      else otherFileCount += 1;
    }
  }

  const numbering = parseCostuanNumbering(path.basename(workPath));
  return {
    relativePath: toPosixRelative(path.relative(rootPath, workPath)),
    absolutePath: workPath,
    folderName: path.basename(workPath),
    parsedSourceOrder: numbering?.order ?? null,
    numberingKey: numbering?.key ?? null,
    imageCount,
    videoCount,
    advertisementFileCount,
    otherFileCount,
    totalBytes
  };
}

async function scanLocalRoot(
  rootPath: string,
  onProgress?: (message: string) => void
): Promise<LocalCreatorSnapshot[]> {
  const resolvedRoot = path.resolve(rootPath);
  const rootStat = await fs.stat(resolvedRoot);
  if (!rootStat.isDirectory()) throw new Error(`图库根目录不是文件夹：${resolvedRoot}`);

  const creatorEntries = (await fs.readdir(resolvedRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }));
  const snapshots: LocalCreatorSnapshot[] = [];

  for (const [index, creatorEntry] of creatorEntries.entries()) {
    onProgress?.(`[${index + 1}/${creatorEntries.length}] 只读扫描 ${creatorEntry.name}`);
    snapshots.push(await scanLocalCreatorDirectory(resolvedRoot, creatorEntry.name));
  }

  return snapshots;
}

function assertDirectCreatorFolderName(folderName: string): string {
  const trimmed = folderName.trim();
  if (
    !trimmed
    || trimmed === '.'
    || trimmed === '..'
    || /[\\/]/u.test(trimmed)
    || path.basename(trimmed) !== trimmed
  ) {
    throw new Error('博主文件夹必须是图库根目录下的单个直接子目录。');
  }
  return trimmed;
}

async function resolveDirectCreatorFolder(rootPath: string, folderName: string): Promise<string> {
  const checkedName = assertDirectCreatorFolderName(folderName);
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const matches = entries.filter((entry) =>
    entry.name.localeCompare(checkedName, undefined, { sensitivity: 'accent' }) === 0
  );
  if (matches.length !== 1 || !matches[0].isDirectory() || matches[0].isSymbolicLink()) {
    throw new Error(`图库根目录下找不到唯一的直接博主目录：${checkedName}`);
  }
  return matches[0].name;
}

async function scanLocalCreatorDirectory(rootPath: string, folderName: string): Promise<LocalCreatorSnapshot> {
  const resolvedRoot = path.resolve(rootPath);
  const creatorPath = path.join(resolvedRoot, folderName);
  const relativeCreatorPath = path.relative(resolvedRoot, creatorPath);
  if (
    !relativeCreatorPath
    || relativeCreatorPath.startsWith(`..${path.sep}`)
    || relativeCreatorPath === '..'
    || path.isAbsolute(relativeCreatorPath)
  ) {
    throw new Error(`博主目录超出图库根目录：${folderName}`);
  }
  const creatorStat = await fs.lstat(creatorPath);
  if (!creatorStat.isDirectory() || creatorStat.isSymbolicLink()) {
    throw new Error(`博主路径不是可扫描的直接文件夹：${folderName}`);
  }
  const workEntries = (await fs.readdir(creatorPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }));
  const works: LocalWorkSnapshot[] = [];
  for (const workEntry of workEntries) {
    works.push(await inspectWorkDirectory(resolvedRoot, path.join(creatorPath, workEntry.name)));
  }
  return {
    relativePath: toPosixRelative(relativeCreatorPath),
    absolutePath: creatorPath,
    folderName,
    works
  };
}

export class ArchiveCatalogService {
  constructor(private readonly database: DatabaseSync = databaseManager.connection) {}

  async importCostuanArchive(filePath: string): Promise<CostuanCatalogImportResult> {
    const resolvedPath = path.resolve(filePath);
    const sourceBuffer = await fs.readFile(resolvedPath);
    const document = costuanArchiveSchema.parse(JSON.parse(sourceBuffer.toString('utf8')));
    return this.importCostuanRecords(Object.values(document.records), {
      observedAt: document.exportedAt ?? new Date().toISOString(),
      sourcePath: resolvedPath,
      sourceVersion: String(document.version),
      checksum: sha256(sourceBuffer)
    });
  }

  importCostuanRecord(
    recordInput: unknown,
    options: { observedAt?: string; sourcePath?: string; expectedCreatorId?: number; completeCheckRoundId?:string } = {}
  ): CostuanCatalogImportResult {
    if (options.completeCheckRoundId && options.expectedCreatorId===undefined) throw new Error('完整来源检查缺少规范博主身份。');
    const record = options.completeCheckRoundId
      ? this.validateCompleteCostuanCheck(recordInput,options.expectedCreatorId!,options.completeCheckRoundId)
      : costuanRecordSchema.parse(recordInput);
    const serialized = Buffer.from(JSON.stringify(record));
    return this.importCostuanRecords([record], {
      observedAt: options.observedAt ?? record.costuan.checkedAt ?? new Date().toISOString(),
      sourcePath: options.sourcePath ?? `bridge:costuan:${record.costuan.postId}`,
      sourceVersion: 'bridge-v1',
      checksum: sha256(serialized),
      expectedCreatorId: options.expectedCreatorId,
      validatedCompleteCheck:!!options.completeCheckRoundId
    });
  }

  validateCompleteCostuanDirectory(recordInput:unknown, creatorId:number): {record:CostuanArchiveRecord;requiredFilenames:string[];sourceFilenames:string[];supplementalContents:PendingCostuanSupplement[]} {
    const record=costuanRecordSchema.parse(recordInput);
    this.validateCostuanIdentity(creatorId,record.costuan.postId,record.costuan.title);
    const proof=z.object({complete:z.literal(true),checkedAt:z.string().datetime({offset:true}),parsedWorkCount:z.number().int().positive()})
      .safeParse(record.costuan.directoryVerification);
    const {works,supplementalContents}=splitCostuanCheckDirectory(record.costuan.title,record.costuan.works,record.costuan.resourceDirectoryText);
    const titleCount=record.costuan.title.match(/[\[【](\d+)\s*套[^\]】]*[\]】]/u);
    const declared=record.costuan.collectionCount ?? (titleCount ? Number(titleCount[1]) : null);
    if (!proof.success || !works.length || declared===null || declared!==works.length || proof.data.parsedWorkCount!==works.length
      || (titleCount && Number(titleCount[1])!==declared)) {
      throw new Error('本轮 Costuan 来源目录未完整核验或声明数量不符；保留上次有效来源，需人工检查。');
    }
    const keyOf=(work:{sourceOrder:string;sourceOrderKey?:string})=>parseCostuanNumbering(work.sourceOrder)?.key ?? null;
    const rawKeys=record.costuan.works.map(keyOf);
    if (rawKeys.some(key=>!key) || new Set(rawKeys).size!==rawKeys.length) throw new Error('本轮来源编号重复或不能明确解析；未覆盖历史来源。');
    const byKey=new Map<string,typeof works[number]>();
    const filenames=new Set<string>();
    for (const work of works) {
      const numbering=parseCostuanNumbering(work.sourceOrder);
      if (!numbering || numbering.order===null || (work.sourceOrderKey && work.sourceOrderKey!==numbering.key)
        || (work.order!==undefined && work.order!==numbering.order) || byKey.has(numbering.key)) {
        throw new Error('本轮来源编号身份不明确或重复；未覆盖历史来源。');
      }
      const filename=`${String(numbering.order).padStart(3,'0')}.7z`;
      if (filenames.has(filename)) throw new Error('NO/VOL 等不同编号身份对应相同网盘文件名，待人工确认，不能自动暂存。');
      filenames.add(filename); byKey.set(numbering.key,work);
    }
    const previous=this.database.prepare(`SELECT sw.work_id,sw.source_work_id,sw.source_order_label,sw.source_title,sw.media_summary
      FROM archive_catalog_source_works sw JOIN archive_catalog_collections c ON c.id=sw.collection_id
      WHERE c.source='costuan' AND c.source_collection_id=? AND c.creator_id=? AND sw.is_active=1`)
      .all(record.costuan.postId,creatorId) as Array<{work_id:number;source_work_id:string;source_order_label:string|null;source_title:string;media_summary:string|null}>;
    const previousCollection=this.database.prepare(`SELECT metadata_json FROM archive_catalog_collections
      WHERE source='costuan' AND source_collection_id=? AND creator_id=?`).get(record.costuan.postId,creatorId) as {metadata_json:string|null}|undefined;
    const oldSupplements=previousCollection?.metadata_json ? JSON.parse(previousCollection.metadata_json).supplementalContents : [];
    if (Array.isArray(oldSupplements) && oldSupplements.some(old=>!supplementalContents.some(current=>
      current.sourceOrderKey===old.sourceOrderKey && current.rawTitle===old.rawTitle))) {
      throw new Error('此前待人工处理的附加内容缺失或发生变化；保留原记录，需人工确认。');
    }
    // Source refresh is not fuzzy local-title matching. Even a bracketed title
    // suffix can identify different content and must not be silently discarded.
    const stableSourceTitle=(value:string)=>value.normalize('NFKC').replace(/\s+/g,' ').trim();
    const confirmedLocalWorks=this.confirmedLocalWorksForSourceCheck(creatorId);
    const localFilenames=new Set<string>();
    for (const old of previous) {
      const key=parseCostuanNumbering(old.source_order_label ?? old.source_work_id)?.key;
      const work=key ? byKey.get(key) : null;
      if (!work || stableSourceTitle(old.source_title)!==stableSourceTitle(work.label)
        || (old.media_summary && work.mediaSummary && old.media_summary.replace(/\s/g,'')!==work.mediaSummary.replace(/\s/g,''))) {
        throw new Error('已有来源编号缺失、重排或内容声明发生变化；保留原收录并等待人工确认。');
      }
      // Equivalent label formatting must reuse the existing Source Work ID.
      work.sourceOrder=old.source_work_id;
      if (confirmedLocalWorks.has(old.work_id)) {
        const order=parseCostuanNumbering(old.source_order_label ?? old.source_work_id)?.order;
        if (order!==null && order!==undefined) localFilenames.add(`${String(order).padStart(3,'0')}.7z`);
      }
    }
    // Validate the complete source above, but only replenish cloud packages needed
    // by the local difference. Never restore missing cloud archives for ingested works.
    return {record:{...record,costuan:{...record.costuan,works,supplementalContents}},supplementalContents,sourceFilenames:[...filenames],
      requiredFilenames:[...filenames].filter(filename=>!localFilenames.has(filename))};
  }

  private confirmedLocalWorksForSourceCheck(creatorId:number):Set<number> {
    const bridges=this.database.prepare(`SELECT id,root_path,relative_path,absolute_path,is_active,match_status
      FROM archive_catalog_local_creator_folders WHERE creator_id=?`).all(creatorId) as Array<{
      id:number;root_path:string;relative_path:string;absolute_path:string;is_active:number;match_status:string}>;
    const roots=new Set(bridges.map(bridge=>path.resolve(bridge.root_path).toLocaleLowerCase()));
    if (roots.size>1 || bridges.some(bridge=>!bridge.is_active || bridge.match_status!=='matched')) {
      throw new Error('本地目录关系失效或未确认，不能按零本地作品补充云端文件。');
    }
    const ensureReadableDirectory=(directory:string)=>{
      const stat=lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('不是安全的本地目录');
      accessSync(directory,constants.R_OK);readdirSync(directory);
    };
    const confirmed=new Set<number>();
    try {
      for (const bridge of bridges) {
        const root=path.resolve(bridge.root_path),directory=path.resolve(root,bridge.relative_path);
        if (path.dirname(directory)!==root || directory.toLocaleLowerCase()!==path.resolve(bridge.absolute_path).toLocaleLowerCase()) {
          throw new Error('本地博主目录路径与桥接不一致');
        }
        ensureReadableDirectory(root);ensureReadableDirectory(directory);
        const rows=this.database.prepare(`SELECT l.work_id,l.relative_path,l.absolute_path,l.match_status,w.creator_id
          FROM archive_catalog_local_works l LEFT JOIN archive_catalog_works w ON w.id=l.work_id
          WHERE l.local_creator_folder_id=? AND l.is_active=1`).all(bridge.id) as Array<{
          work_id:number|null;relative_path:string;absolute_path:string;match_status:string;creator_id:number|null}>;
        for (const row of rows) {
          // An unresolved registered local work is unknown, not permission to
          // assume an empty local set or infer its source from title/NO alone.
          if (row.work_id===null || row.match_status!=='matched') throw new Error('已登记本地作品的来源身份尚未确认');
          const absolute=path.resolve(directory,row.relative_path),relative=path.relative(directory,absolute);
          if (!relative || relative==='..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
            || absolute.toLocaleLowerCase()!==path.resolve(row.absolute_path).toLocaleLowerCase()
            || row.creator_id!==creatorId || confirmed.has(row.work_id)) throw new Error('本地作品身份、唯一关系或安全路径不明确');
          let current=directory;
          for (const segment of relative.split(path.sep)) {current=path.join(current,segment);ensureReadableDirectory(current);}
          if (!readdirSync(absolute).length) throw new Error('已关联作品目录为空，当前本地状态需重新确认');
          confirmed.add(row.work_id);
        }
      }
    } catch (cause) {
      throw new Error('本地目录离线、不可读或关系有歧义；保留来源，不把未知状态当成本地缺失。',{cause});
    }
    return confirmed;
  }

  validateCompleteCostuanCheck(recordInput:unknown, creatorId:number, checkRoundId:string): CostuanArchiveRecord {
    const {record,requiredFilenames}=this.validateCompleteCostuanDirectory(recordInput,creatorId);
    const verification=z.object({method:z.enum(['saved','reused']),checkedAt:z.string().datetime({offset:true}),
      sourceDirectory:z.string().min(1),checkRoundId:z.literal(checkRoundId),files:z.array(z.string().min(1))})
      .safeParse(record.baidu?.verification);
    const expectedDirectory=`${record.baidu?.destinationPath?.replace(/[\\/]+$/u,'')}/${record.baidu?.sourceFolderName}`;
    if (!record.baidu || !['saved','already-saved'].includes(record.baidu.status ?? '') || !record.baidu.sourceFolderName?.trim()
      || !record.baidu.destinationPath?.trim() || !verification.success
      || verification.data.sourceDirectory.replace(/\\/g,'/').replace(/\/+$/u,'')!==expectedDirectory.replace(/\\/g,'/')) {
      throw new Error('缺少本轮自有网盘来源目录核验凭据；历史 alreadySaved 不能代表新增文件可用。');
    }
    const files=new Set(verification.data.files);
    if (requiredFilenames.some(filename=>!files.has(filename))) throw new Error('本轮网盘来源文件尚未全部确认可用；保留上次有效来源，不规划未核验文件。');
    return record;
  }

  validateCostuanIdentity(expectedCreatorId: number, postId: string, title: string): void {
    const active = this.database.prepare('SELECT is_active FROM archive_catalog_creators WHERE id=?').get(expectedCreatorId) as {is_active:number}|undefined;
    if (!active?.is_active) throw new Error('指定规范博主不存在或已停用。');
    const owners = this.database.prepare(`SELECT creator_id FROM archive_catalog_creator_sources
      WHERE source='costuan' AND source_creator_id=? UNION SELECT creator_id FROM archive_catalog_collections
      WHERE source='costuan' AND source_collection_id=?`).all(`collection:${postId}`,postId) as Array<{creator_id:number}>;
    const alias=collectionCreatorAlias(title), matches=alias ? this.findCreatorIdsByAliases([alias]) : [];
    if (owners.length ? owners.length !== 1 || owners[0].creator_id !== expectedCreatorId
      : matches.length !== 1 || matches[0] !== expectedCreatorId) {
      throw new Error('Costuan 合集身份与指定规范博主不一致或存在歧义，未写入来源。');
    }
  }

  private importCostuanRecords(
    records: CostuanArchiveRecord[],
    importMetadata: {
      observedAt: string;
      sourcePath: string;
      sourceVersion: string;
      checksum: string;
      expectedCreatorId?: number;
      validatedCompleteCheck?: boolean;
    }
  ): CostuanCatalogImportResult {
    const observedAt = importMetadata.observedAt;
    const result: CostuanCatalogImportResult = {
      source: 'costuan',
      records: records.length,
      matchedCreators: 0,
      unmatchedCreators: [],
      importedWorks: 0,
      addedWorks: 0,
      updatedWorks: 0,
      deliveries: 0
    };

    withTransaction(this.database, () => {
      for (const record of records) {
        const titleAlias = collectionCreatorAlias(record.costuan.title);
        const candidateNames = [
          record.creatorName,
          record.creatorId ?? '',
          ...record.aliases,
          record.local?.folderName ?? '',
          titleAlias ?? ''
        ].filter(Boolean);
        // Persistent platform identity wins over later display-name changes.
        // A disagreement between existing identities is quarantined as unmatched.
        const owners = this.database.prepare(`SELECT creator_id FROM archive_catalog_creator_sources
          WHERE source='costuan' AND source_creator_id=? UNION
          SELECT creator_id FROM archive_catalog_collections WHERE source='costuan' AND source_collection_id=?`)
          .all(`collection:${record.costuan.postId}`, record.costuan.postId) as Array<{creator_id:number}>;
        const creatorMatches = owners.length ? owners.map(owner => owner.creator_id) : this.findCreatorIdsByAliases(candidateNames);
        if (importMetadata.expectedCreatorId !== undefined) {
          const expected = importMetadata.expectedCreatorId;
          // The task name in a submitted record is not independent source evidence.
          // A first collection must identify this creator through its own title.
          this.validateCostuanIdentity(expected, record.costuan.postId, record.costuan.title);
          creatorMatches.splice(0, creatorMatches.length, expected);
        }
        if (creatorMatches.length !== 1) {
          result.unmatchedCreators.push(record.creatorName);
          continue;
        }

        const creatorId = creatorMatches[0];
        result.matchedCreators += 1;
        if (importMetadata.expectedCreatorId === undefined) {
          for (const alias of candidateNames) this.upsertAlias(creatorId, alias, 'costuan');
        }
        this.upsertCreatorSource({
          creatorId,
          source: 'costuan',
          sourceCreatorId: `collection:${record.costuan.postId}`,
          sourceDisplayName: record.creatorName,
          sourceUrl: record.costuan.url ?? null,
          observedAt,
          metadata: { identityKind: 'collection-derived', creatorId: record.creatorId ?? null }
        });

        const mergedCostuanWorks = importMetadata.validatedCompleteCheck ? record.costuan.works : mergeCostuanDirectoryWorks(
          record.costuan.works,
          record.costuan.resourceDirectoryText
        );
        const collectionId = this.upsertCollection({
          creatorId,
          sourceCollectionId: record.costuan.postId,
          title: record.costuan.title,
          sourceUrl: record.costuan.url ?? null,
          declaredWorkCount: record.costuan.collectionCount ?? null,
          rawDirectoryText: record.costuan.resourceDirectoryText ?? null,
          observedAt,
          metadata: { ...record.costuan, works: mergedCostuanWorks }
        });

        this.database.prepare(
          `UPDATE archive_catalog_source_works
           SET is_active = 0
           WHERE collection_id = ? AND source = 'costuan'`
        ).run(collectionId);

        for (const work of mergedCostuanWorks) {
          const sourceOrder = work.order ?? parseArchiveSourceOrder(work.sourceOrder);
          const sourceWorkId = work.sourceOrder || (sourceOrder === null ? work.label : `NO.${String(sourceOrder).padStart(3, '0')}`);
          const existing = this.database.prepare(
            `SELECT id, work_id FROM archive_catalog_source_works
             WHERE collection_id = ? AND source_work_id = ?`
          ).get(collectionId, sourceWorkId) as { id: number; work_id: number } | undefined;
          let workId: number;
          if (existing) {
            workId = existing.work_id;
            this.database.prepare(
              `UPDATE archive_catalog_works
               SET display_title = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            ).run(work.label, workId);
            this.database.prepare(
              `UPDATE archive_catalog_source_works SET
                 source_order = ?, source_order_label = ?, source_title = ?, raw_title = ?,
                 media_summary = ?, metadata_json = ?, is_active = 1, last_seen_at = ?
               WHERE id = ?`
            ).run(
              sourceOrder,
              work.sourceOrder,
              work.label,
              work.rawTitle ?? null,
              work.mediaSummary ?? null,
              JSON.stringify(work),
              observedAt,
              existing.id
            );
            result.updatedWorks += 1;
          } else {
            const insertedWork = this.database.prepare(
              `INSERT INTO archive_catalog_works (creator_id, display_title)
               VALUES (?, ?)`
            ).run(creatorId, work.label);
            workId = asNumber(insertedWork.lastInsertRowid);
            this.database.prepare(
              `INSERT INTO archive_catalog_source_works (
                 work_id, collection_id, source, source_work_id, source_order,
                 source_order_label, source_title, raw_title, media_summary,
                 metadata_json, first_seen_at, last_seen_at
               ) VALUES (?, ?, 'costuan', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              workId,
              collectionId,
              sourceWorkId,
              sourceOrder,
              work.sourceOrder,
              work.label,
              work.rawTitle ?? null,
              work.mediaSummary ?? null,
              JSON.stringify(work),
              observedAt,
              observedAt
            );
            result.addedWorks += 1;
          }
          result.importedWorks += 1;
        }

        if (record.baidu) {
          const deliveryKey = record.baidu.sourceFolderName || 'primary';
          this.database.prepare(
            `INSERT INTO archive_catalog_deliveries (
               collection_id, provider, delivery_key, delivery_type, status,
               source_folder_name, destination_path, transferred_at, metadata_json,
               first_seen_at, last_seen_at
             ) VALUES (?, 'baidu', ?, 'share-folder', ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(collection_id, provider, delivery_key) DO UPDATE SET
               status = excluded.status,
               source_folder_name = excluded.source_folder_name,
               destination_path = excluded.destination_path,
               transferred_at = excluded.transferred_at,
               metadata_json = excluded.metadata_json,
               last_seen_at = excluded.last_seen_at`
          ).run(
            collectionId,
            deliveryKey,
            record.baidu.status ?? null,
            record.baidu.sourceFolderName ?? null,
            record.baidu.destinationPath ?? null,
            record.baidu.transferredAt ?? null,
            JSON.stringify(record.baidu),
            observedAt,
            observedAt
          );
          result.deliveries += 1;
        }
      }

      this.recordImportRun({
        source: 'costuan',
        format: 'costuan-archive-metadata',
        version: importMetadata.sourceVersion,
        sourcePath: importMetadata.sourcePath,
        checksum: importMetadata.checksum,
        importedAt: new Date().toISOString(),
        stats: result
      });
    });

    return result;
  }

  async reconcileLocalRoot(
    rootPath: string,
    onProgress?: (message: string) => void
  ): Promise<LocalReconciliationResult> {
    const resolvedRoot = path.resolve(rootPath);
    const snapshots = await scanLocalRoot(resolvedRoot, onProgress);
    return this.reconcileLocalSnapshots({
      resolvedRoot,
      snapshots,
      explicitCreatorIds: null,
      deactivateMissingCreatorFolders: true
    });
  }

  async reconcileLocalCreators(options: {
    rootPath: string;
    creators: LocalCreatorReconciliationScope[];
    onProgress?: (message: string) => void;
  }): Promise<LocalReconciliationResult> {
    const resolvedRoot = path.resolve(options.rootPath);
    const rootStat = await fs.stat(resolvedRoot);
    if (!rootStat.isDirectory()) throw new Error(`图库根目录不是文件夹：${resolvedRoot}`);
    if (options.creators.length === 0) {
      throw new Error('博主定向对账至少需要一个明确的博主范围。');
    }

    const explicitCreatorIds = new Map<string, number>();
    const snapshots: LocalCreatorSnapshot[] = [];
    for (const [index, scope] of options.creators.entries()) {
      if (!Number.isSafeInteger(scope.creatorId) || scope.creatorId <= 0) {
        throw new Error(`无效的博主 ID：${String(scope.creatorId)}`);
      }
      const actualFolderName = await resolveDirectCreatorFolder(resolvedRoot, scope.folderName);
      const creator = this.database.prepare(
        'SELECT id FROM archive_catalog_creators WHERE id = ?'
      ).get(scope.creatorId) as { id: number } | undefined;
      if (!creator) throw new Error(`博主 ID 不存在：${scope.creatorId}`);
      const persistent = this.findPersistentLocalFolder(path.join(resolvedRoot, actualFolderName), resolvedRoot);
      if (persistent && normalizedAbsoluteCreatorPath(persistent.absolute_path) !== normalizedAbsoluteCreatorPath(path.join(resolvedRoot, actualFolderName))) {
        throw new Error('LOCAL_FOLDER_LINK_CONFLICT: persistent path changed; review required before scoped reconciliation');
      }
      const creatorMatches = persistent?.match_method === 'manual-unlinked' ? []
        : persistent?.creator_id != null ? [persistent.creator_id] : this.findCreatorIdsByAliases([actualFolderName]);
      if (creatorMatches.length !== 1 || creatorMatches[0] !== scope.creatorId) {
        throw new Error(`博主 ID ${scope.creatorId} 与文件夹“${actualFolderName}”无法唯一对应。`);
      }
      options.onProgress?.(`[${index + 1}/${options.creators.length}] 只读扫描 ${actualFolderName}`);
      const snapshot = await scanLocalCreatorDirectory(resolvedRoot, actualFolderName);
      if (explicitCreatorIds.has(snapshot.relativePath)) {
        throw new Error(`博主定向对账中出现重复文件夹：${actualFolderName}`);
      }
      explicitCreatorIds.set(snapshot.relativePath, scope.creatorId);
      snapshots.push(snapshot);
    }

    return this.reconcileLocalSnapshots({
      resolvedRoot,
      snapshots,
      explicitCreatorIds,
      deactivateMissingCreatorFolders: false
    });
  }

  private reconcileLocalSnapshots(input: {
    resolvedRoot: string;
    snapshots: LocalCreatorSnapshot[];
    explicitCreatorIds: Map<string, number> | null;
    deactivateMissingCreatorFolders: boolean;
  }): LocalReconciliationResult {
    const scannedAt = new Date().toISOString();
    const result: LocalReconciliationResult = {
      bridgeReview: [],
      rootPath: input.resolvedRoot,
      creatorFolders: input.snapshots.length,
      matchedCreatorFolders: 0,
      unmatchedCreatorFolders: [],
      ambiguousCreatorFolders: [],
      localWorks: 0,
      matchedWorks: 0,
      unmatchedWorks: 0,
      ambiguousWorks: 0
    };

    withTransaction(this.database, () => {
      const activeCreatorPaths = new Set<string>();
      for (const creatorSnapshot of input.snapshots) {
        activeCreatorPaths.add(creatorSnapshot.relativePath);
        const explicitCreatorId = input.explicitCreatorIds?.get(creatorSnapshot.relativePath);
        const persistent = this.findPersistentLocalFolder(creatorSnapshot.absolutePath, input.resolvedRoot);
        if (persistent) activeCreatorPaths.add(persistent.relative_path);
        if (persistent && normalizedAbsoluteCreatorPath(persistent.absolute_path) !== normalizedAbsoluteCreatorPath(creatorSnapshot.absolutePath)) {
          result.bridgeReview.push({catalogFolderId:persistent.id,status:'path-changed',candidates:persistent.gallery_folder_id === null ? [] : [persistent.gallery_folder_id]});
          continue;
        }
        // Explicit manual unlink is sticky. Preserve child Work relationships for
        // recovery; scanning may not silently relink or clear them.
        if (persistent?.match_method === 'manual-unlinked') {
          result.unmatchedCreatorFolders.push(creatorSnapshot.folderName);
          const existing = this.listExistingLocalWorkLinks(input.resolvedRoot, creatorSnapshot.relativePath);
          result.localWorks += existing.length;
          result.matchedWorks += existing.filter(row => row.match_status === 'matched').length;
          result.unmatchedWorks += existing.filter(row => row.match_status === 'unmatched').length;
          result.ambiguousWorks += existing.filter(row => row.match_status === 'ambiguous').length;
          continue;
        }
        const creatorMatches = persistent?.creator_id != null ? [persistent.creator_id] : explicitCreatorId === undefined
          ? this.findCreatorIdsByAliases([creatorSnapshot.folderName])
          : [explicitCreatorId];
        const creatorId = creatorMatches.length === 1 ? creatorMatches[0] : null;
        const creatorStatus: MatchStatus = creatorMatches.length === 1
          ? 'matched'
          : creatorMatches.length > 1 ? 'ambiguous' : 'unmatched';
        if (creatorStatus === 'matched') result.matchedCreatorFolders += 1;
        else if (creatorStatus === 'ambiguous') result.ambiguousCreatorFolders.push(creatorSnapshot.folderName);
        else result.unmatchedCreatorFolders.push(creatorSnapshot.folderName);

        const existingLinks = this.listExistingLocalWorkLinks(
          input.resolvedRoot,
          creatorSnapshot.relativePath
        );

        const localFolderId = this.upsertLocalCreatorFolder({
          creatorId,
          rootPath: input.resolvedRoot,
          snapshot: creatorSnapshot,
          status: creatorStatus,
          method: persistent?.match_method ?? (creatorStatus === 'matched' ? 'normalized-alias' : null),
          scannedAt
        });
        result.bridgeReview.push(...new LocalCreatorFolderBridgeService(this.database).backfill(input.resolvedRoot, [localFolderId])
          .filter(row => row.status !== 'exact'));
        const remoteWorks = creatorId === null ? [] : this.listRemoteWorks(creatorId);
        const creatorNames = creatorId === null
          ? []
          : [creatorSnapshot.folderName, ...this.listCreatorNames(creatorId)];
        const byNumberingKey = new Map<string, RemoteWorkRow[]>();
        const byTitle = new Map<string, RemoteWorkRow[]>();
        for (const remoteWork of remoteWorks) {
          const numberingKey = remoteWorkNumberingKey(remoteWork);
          if (numberingKey) {
            const values = byNumberingKey.get(numberingKey) ?? [];
            values.push(remoteWork);
            byNumberingKey.set(numberingKey, values);
          }
          const normalizedTitle = normalizeWorkTitle(remoteWork.source_title);
          const values = byTitle.get(normalizedTitle) ?? [];
          values.push(remoteWork);
          byTitle.set(normalizedTitle, values);
        }
        const existingByRelativePath = new Map(existingLinks.map((row) => [row.relative_path, row]));
        const preservedByRelativePath = new Map<string, ExistingLocalWorkLink>();
        const claimedWorkIds = new Set<number>();
        if (creatorId !== null) {
          for (const workSnapshot of creatorSnapshot.works) {
            const relativePath = this.localWorkRelativePath(workSnapshot);
            const existing = existingByRelativePath.get(relativePath);
            if (
              existing
              && existing.work_id !== null
              && existing.match_status === 'matched'
              && existing.work_creator_id === creatorId
              && existing.has_active_source === 1
              && !claimedWorkIds.has(existing.work_id)
            ) {
              preservedByRelativePath.set(relativePath, existing);
              claimedWorkIds.add(existing.work_id);
            }
          }
        }

        const activeWorkPaths = new Set<string>();

        for (const workSnapshot of creatorSnapshot.works) {
          result.localWorks += 1;
          const relativePath = this.localWorkRelativePath(workSnapshot);
          activeWorkPaths.add(relativePath);
          const preserved = preservedByRelativePath.get(relativePath);
          if (preserved?.work_id !== null && preserved?.work_id !== undefined) {
            result.matchedWorks += 1;
            this.upsertLocalWork({
              localFolderId,
              workId: preserved.work_id,
              snapshot: workSnapshot.parsedSourceOrder === null && preserved.parsed_source_order !== null
                ? { ...workSnapshot, parsedSourceOrder: preserved.parsed_source_order }
                : workSnapshot,
              status: 'matched',
              method: preserved.match_method,
              scannedAt
            });
            continue;
          }

          let matches: RemoteWorkRow[] = [];
          let matchMethod: string | null = null;
          let numberingTitleConflict = false;
          if (creatorId !== null && workSnapshot.numberingKey !== null) {
            matches = byNumberingKey.get(workSnapshot.numberingKey) ?? [];
            if (matches.length > 0) {
              const compatible = matches.filter((remoteWork) => areCostuanTitlesCompatible(
                workSnapshot.folderName,
                remoteWork.source_title,
                creatorNames
              ));
              if (compatible.length > 0) {
                matches = compatible;
                matchMethod = 'costuan-numbering-key';
              } else {
                numberingTitleConflict = true;
                matchMethod = 'costuan-numbering-title-conflict';
              }
            }
          }
          if (creatorId !== null && workSnapshot.numberingKey === null && matches.length === 0) {
            const normalizedLocalTitle = normalizeWorkTitle(workSnapshot.folderName);
            matches = byTitle.get(normalizedLocalTitle) ?? [];
            if (matches.length > 0) matchMethod = 'normalized-title';
          }
          if (creatorId !== null && workSnapshot.numberingKey === null && matches.length === 0) {
            const prefixedTitleMatches = new Map<number, RemoteWorkRow>();
            for (const candidate of creatorPrefixedWorkTitleCandidates(workSnapshot.folderName, creatorNames)) {
              for (const remoteWork of byTitle.get(candidate) ?? []) {
                prefixedTitleMatches.set(remoteWork.work_id, remoteWork);
              }
            }
            matches = [...prefixedTitleMatches.values()];
            if (matches.length > 0) matchMethod = 'normalized-title-with-creator-prefix';
          }

          let status: MatchStatus;
          let workId: number | null = null;
          if (numberingTitleConflict) {
            status = 'ambiguous';
            result.ambiguousWorks += 1;
          } else if (matches.length === 1 && !claimedWorkIds.has(matches[0].work_id)) {
            status = 'matched';
            workId = matches[0].work_id;
            claimedWorkIds.add(workId);
            result.matchedWorks += 1;
          } else if (matches.length > 1 || (matches.length === 1 && claimedWorkIds.has(matches[0].work_id))) {
            status = 'ambiguous';
            result.ambiguousWorks += 1;
          } else {
            status = 'unmatched';
            result.unmatchedWorks += 1;
          }

          this.upsertLocalWork({
            localFolderId,
            workId,
            snapshot: workSnapshot,
            status,
            method: status === 'unmatched' ? null : matchMethod,
            scannedAt
          });
        }

        this.deactivateMissingLocalWorks(localFolderId, activeWorkPaths);
      }

      if (input.deactivateMissingCreatorFolders) {
        this.deactivateMissingLocalCreatorFolders(input.resolvedRoot, activeCreatorPaths);
      }
    });

    return result;
  }

  buildReconciliationReport(rootPath?: string): ArchiveCatalogReport {
    const resolvedRoot = rootPath ? path.resolve(rootPath) : null;
    const creators = this.database.prepare(
      `SELECT id, canonical_name, preference, effective_rating
       FROM archive_catalog_creators
       ORDER BY canonical_name COLLATE NOCASE`
    ).all() as Array<{
      id: number;
      canonical_name: string;
      preference: 'liked' | 'kept' | null;
      effective_rating: 'R15' | 'R18' | null;
    }>;
    const remoteRows = this.database.prepare(
      `SELECT
         works.creator_id,
         works.id AS work_id,
         source_works.source,
         collections.source_collection_id,
         source_works.source_order,
         source_works.source_order_label,
         source_works.source_title
       FROM archive_catalog_source_works source_works
       JOIN archive_catalog_works works ON works.id = source_works.work_id
       JOIN archive_catalog_collections collections ON collections.id = source_works.collection_id
       WHERE source_works.is_active = 1 AND collections.is_active = 1`
    ).all() as Array<{
      creator_id: number;
      work_id: number;
      source: string;
      source_collection_id: string;
      source_order: number | null;
      source_order_label: string | null;
      source_title: string;
    }>;
    const localRows = this.database.prepare(
      `SELECT
         local_folders.creator_id,
         local_works.work_id,
         local_works.folder_name,
         local_works.relative_path,
         local_works.parsed_source_order,
         local_works.match_status
       FROM archive_catalog_local_works local_works
       JOIN archive_catalog_local_creator_folders local_folders
         ON local_folders.id = local_works.local_creator_folder_id
       WHERE local_works.is_active = 1
         AND local_folders.is_active = 1
         AND (? IS NULL OR local_folders.root_path = ?)`
    ).all(resolvedRoot, resolvedRoot) as Array<{
      creator_id: number | null;
      work_id: number | null;
      folder_name: string;
      relative_path: string;
      parsed_source_order: number | null;
      match_status: MatchStatus;
    }>;
    const unresolvedCreatorFolders = this.database.prepare(
      `SELECT folder_name, relative_path, match_status
       FROM archive_catalog_local_creator_folders
       WHERE is_active = 1
         AND match_status <> 'matched'
         AND (? IS NULL OR root_path = ?)
       ORDER BY folder_name COLLATE NOCASE`
    ).all(resolvedRoot, resolvedRoot) as Array<{
      folder_name: string;
      relative_path: string;
      match_status: 'unmatched' | 'ambiguous';
    }>;

    const remoteByCreator = new Map<number, typeof remoteRows>();
    const localByCreator = new Map<number, typeof localRows>();
    for (const row of remoteRows) {
      const rows = remoteByCreator.get(row.creator_id) ?? [];
      rows.push(row);
      remoteByCreator.set(row.creator_id, rows);
    }
    for (const row of localRows) {
      if (row.creator_id === null) continue;
      const rows = localByCreator.get(row.creator_id) ?? [];
      rows.push(row);
      localByCreator.set(row.creator_id, rows);
    }

    const reports: CreatorReconciliationReport[] = [];
    for (const creator of creators) {
      const remote = remoteByCreator.get(creator.id) ?? [];
      const local = localByCreator.get(creator.id) ?? [];
      if (remote.length === 0 && local.length === 0) continue;
      const matchedWorkIds = new Set(local.flatMap((row) => row.work_id === null ? [] : [row.work_id]));
      reports.push({
        creatorId: creator.id,
        creatorName: creator.canonical_name,
        preference: creator.preference,
        rating: creator.effective_rating,
        remoteWorks: remote.length,
        localWorks: local.length,
        matchedWorks: matchedWorkIds.size,
        missingWorks: remote
          .filter((row) => !matchedWorkIds.has(row.work_id))
          .sort((left, right) => (left.source_order ?? Number.MAX_SAFE_INTEGER) - (right.source_order ?? Number.MAX_SAFE_INTEGER))
          .map((row) => ({
            workId: row.work_id,
            source: row.source,
            collectionId: row.source_collection_id,
            sourceOrder: row.source_order,
            sourceOrderLabel: row.source_order_label,
            title: row.source_title
          })),
        unresolvedLocalWorks: local
          .filter((row) => row.work_id === null)
          .map((row) => ({
            folderName: row.folder_name,
            relativePath: row.relative_path,
            parsedSourceOrder: row.parsed_source_order,
            status: row.match_status
          }))
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      rootPath: resolvedRoot,
      summary: {
        creators: creators.length,
        creatorsWithRemoteWorks: reports.filter((report) => report.remoteWorks > 0).length,
        creatorsWithLocalWorks: reports.filter((report) => report.localWorks > 0).length,
        remoteWorks: reports.reduce((sum, report) => sum + report.remoteWorks, 0),
        localWorks: reports.reduce((sum, report) => sum + report.localWorks, 0),
        matchedWorks: reports.reduce((sum, report) => sum + report.matchedWorks, 0),
        missingWorks: reports.reduce((sum, report) => sum + report.missingWorks.length, 0),
        unresolvedCreatorFolders: unresolvedCreatorFolders.length,
        unresolvedLocalWorks: reports.reduce((sum, report) => sum + report.unresolvedLocalWorks.length, 0)
      },
      unresolvedCreatorFolders: unresolvedCreatorFolders.map((folder) => ({
        folderName: folder.folder_name,
        relativePath: folder.relative_path,
        status: folder.match_status
      })),
      creators: reports.sort((left, right) =>
        right.missingWorks.length - left.missingWorks.length
        || left.creatorName.localeCompare(right.creatorName, 'zh-CN')
      )
    };
  }

  private findPersistentLocalFolder(absolutePath: string, galleryRoot: string) {
    const normalized = normalizedAbsoluteCreatorPath(absolutePath);
    const matches = (this.database.prepare(`SELECT local.id,local.creator_id,local.absolute_path,local.relative_path,local.match_method,local.gallery_folder_id,folders.folder_path
      FROM archive_catalog_local_creator_folders local LEFT JOIN folders ON folders.id=local.gallery_folder_id WHERE local.is_active=1`).all() as Array<{
        id:number;creator_id:number|null;absolute_path:string;relative_path:string;match_method:string|null;gallery_folder_id:number|null;folder_path:string|null
      }>).filter(row => normalized !== null && (normalizedAbsoluteCreatorPath(row.absolute_path) === normalized
        || (row.folder_path !== null && normalizedAbsoluteCreatorPath(row.folder_path, galleryRoot) === normalized)));
    if (matches.length > 1) throw new Error('LOCAL_FOLDER_LINK_CONFLICT: multiple exact persistent paths');
    return matches[0];
  }

  private findCreatorIdsByAliases(names: string[]): number[] {
    const ids = new Set<number>();
    const findAlias = this.database.prepare(
      `SELECT creator_id FROM archive_catalog_creator_aliases WHERE normalized_alias = ?`
    );
    const findName = this.database.prepare(
      `SELECT id FROM archive_catalog_creators WHERE normalized_name = ?`
    );
    for (const normalized of new Set(names.map(normalizeCreatorIdentity).filter(Boolean))) {
      for (const row of findAlias.all(normalized) as Array<{ creator_id: number }>) ids.add(row.creator_id);
      for (const row of findName.all(normalized) as Array<{ id: number }>) ids.add(row.id);
    }
    return [...ids];
  }

  private listCreatorNames(creatorId: number): string[] {
    const rows = this.database.prepare(
      `SELECT canonical_name AS name
       FROM archive_catalog_creators
       WHERE id = ?
       UNION
       SELECT alias AS name
       FROM archive_catalog_creator_aliases
       WHERE creator_id = ?`
    ).all(creatorId, creatorId) as Array<{ name: string }>;
    return [...new Set(rows.map((row) => row.name.trim()).filter(Boolean))];
  }

  private upsertAlias(creatorId: number, alias: string, source: string): void {
    const normalized = normalizeCreatorIdentity(alias);
    if (!normalized) return;
    this.database.prepare(
      `INSERT INTO archive_catalog_creator_aliases (
         creator_id, alias, normalized_alias, source
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(creator_id, source, normalized_alias) DO UPDATE SET
         alias = excluded.alias, updated_at = CURRENT_TIMESTAMP`
    ).run(creatorId, alias.trim(), normalized, source);
  }

  private upsertCreatorSource(input: {
    creatorId: number;
    source: string;
    sourceCreatorId: string;
    sourceDisplayName: string;
    sourceUrl: string | null;
    observedAt: string;
    metadata: unknown;
  }): void {
    this.database.prepare(
      `INSERT INTO archive_catalog_creator_sources (
         creator_id, source, source_creator_id, source_display_name, source_url,
         metadata_json, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, source_creator_id) DO UPDATE SET
         source_display_name = excluded.source_display_name,
         source_url = excluded.source_url,
         metadata_json = excluded.metadata_json,
         last_seen_at = excluded.last_seen_at`
    ).run(
      input.creatorId,
      input.source,
      input.sourceCreatorId,
      input.sourceDisplayName,
      input.sourceUrl,
      JSON.stringify(input.metadata),
      input.observedAt,
      input.observedAt
    );
  }

  private upsertCollection(input: {
    creatorId: number;
    sourceCollectionId: string;
    title: string;
    sourceUrl: string | null;
    declaredWorkCount: number | null;
    rawDirectoryText: string | null;
    observedAt: string;
    metadata: unknown;
  }): number {
    this.database.prepare(
      `INSERT INTO archive_catalog_collections (
         creator_id, source, source_collection_id, title, source_url,
         declared_work_count, raw_directory_text, metadata_json, observed_at
       ) VALUES (?, 'costuan', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, source_collection_id) DO UPDATE SET
         title = excluded.title,
         source_url = excluded.source_url,
         declared_work_count = excluded.declared_work_count,
         raw_directory_text = excluded.raw_directory_text,
         metadata_json = excluded.metadata_json,
         observed_at = excluded.observed_at,
         is_active = 1,
         updated_at = CURRENT_TIMESTAMP`
    ).run(
      input.creatorId,
      input.sourceCollectionId,
      input.title,
      input.sourceUrl,
      input.declaredWorkCount,
      input.rawDirectoryText,
      JSON.stringify(input.metadata),
      input.observedAt
    );
    const row = this.database.prepare(
      `SELECT id FROM archive_catalog_collections
       WHERE source = 'costuan' AND source_collection_id = ?`
    ).get(input.sourceCollectionId) as { id: number };
    return row.id;
  }

  private listRemoteWorks(creatorId: number): RemoteWorkRow[] {
    return this.database.prepare(
       `SELECT
          source_works.work_id,
          source_works.source_work_id,
          source_works.source_order,
          source_works.source_order_label,
          source_works.source_title,
          source_works.metadata_json
       FROM archive_catalog_source_works source_works
       JOIN archive_catalog_collections collections ON collections.id = source_works.collection_id
       WHERE collections.creator_id = ?
         AND collections.source = 'costuan'
         AND collections.is_active = 1
         AND source_works.source = 'costuan'
         AND source_works.is_active = 1`
    ).all(creatorId) as RemoteWorkRow[];
  }

  private listExistingLocalWorkLinks(rootPath: string, creatorRelativePath: string): ExistingLocalWorkLink[] {
    return this.database.prepare(
      `SELECT
         local_works.relative_path,
         local_works.work_id,
         local_works.parsed_source_order,
         local_works.match_status,
         local_works.match_method,
         works.creator_id AS work_creator_id,
         CASE WHEN EXISTS (
           SELECT 1
           FROM archive_catalog_source_works source_works
           JOIN archive_catalog_collections collections
             ON collections.id = source_works.collection_id
           WHERE source_works.work_id = local_works.work_id
             AND source_works.is_active = 1
             AND collections.is_active = 1
             AND collections.creator_id = works.creator_id
         ) THEN 1 ELSE 0 END AS has_active_source
       FROM archive_catalog_local_creator_folders local_folders
       JOIN archive_catalog_local_works local_works
         ON local_works.local_creator_folder_id = local_folders.id
       LEFT JOIN archive_catalog_works works ON works.id = local_works.work_id
       WHERE local_folders.root_path = ?
         AND local_folders.relative_path = ?
       ORDER BY local_works.relative_path`
    ).all(rootPath, creatorRelativePath) as ExistingLocalWorkLink[];
  }

  private localWorkRelativePath(snapshot: LocalWorkSnapshot): string {
    return snapshot.relativePath.split('/').slice(1).join('/');
  }

  private deactivateMissingLocalWorks(localFolderId: number, activePaths: Set<string>): void {
    if (activePaths.size === 0) {
      this.database.prepare(
        `UPDATE archive_catalog_local_works
         SET is_active = 0
         WHERE local_creator_folder_id = ? AND is_active = 1`
      ).run(localFolderId);
      return;
    }
    const placeholders = [...activePaths].map(() => '?').join(', ');
    this.database.prepare(
      `UPDATE archive_catalog_local_works
       SET is_active = 0
       WHERE local_creator_folder_id = ?
         AND is_active = 1
         AND relative_path NOT IN (${placeholders})`
    ).run(localFolderId, ...activePaths);
  }

  private deactivateMissingLocalCreatorFolders(rootPath: string, activePaths: Set<string>): void {
    const parameters: Array<string | number> = [rootPath];
    const activeFilter = activePaths.size === 0
      ? ''
      : `AND relative_path NOT IN (${[...activePaths].map(() => '?').join(', ')})`;
    parameters.push(...activePaths);
    const staleFolders = this.database.prepare(
      `SELECT id
       FROM archive_catalog_local_creator_folders
       WHERE root_path = ?
         AND is_active = 1
         ${activeFilter}`
    ).all(...parameters) as Array<{ id: number }>;
    const deactivateWorks = this.database.prepare(
      `UPDATE archive_catalog_local_works
       SET is_active = 0
       WHERE local_creator_folder_id = ? AND is_active = 1`
    );
    for (const folder of staleFolders) deactivateWorks.run(folder.id);
    if (staleFolders.length === 0) return;
    const placeholders = staleFolders.map(() => '?').join(', ');
    this.database.prepare(
      `UPDATE archive_catalog_local_creator_folders
       SET is_active = 0
       WHERE id IN (${placeholders}) AND is_active = 1`
    ).run(...staleFolders.map((folder) => folder.id));
  }

  private upsertLocalCreatorFolder(input: {
    creatorId: number | null;
    rootPath: string;
    snapshot: LocalCreatorSnapshot;
    status: MatchStatus;
    method: string | null;
    scannedAt: string;
  }): number {
    this.database.prepare(
      `INSERT INTO archive_catalog_local_creator_folders (
         creator_id, root_path, relative_path, absolute_path, folder_name,
         match_status, match_method, scanned_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(root_path, relative_path) DO UPDATE SET
          creator_id = excluded.creator_id,
         absolute_path = excluded.absolute_path,
         folder_name = excluded.folder_name,
         match_status = excluded.match_status,
         match_method = excluded.match_method,
          is_active = 1,
          scanned_at = excluded.scanned_at,
          updated_at = CURRENT_TIMESTAMP
        WHERE archive_catalog_local_creator_folders.creator_id IS NOT excluded.creator_id
           OR archive_catalog_local_creator_folders.absolute_path IS NOT excluded.absolute_path
           OR archive_catalog_local_creator_folders.folder_name IS NOT excluded.folder_name
           OR archive_catalog_local_creator_folders.match_status IS NOT excluded.match_status
           OR archive_catalog_local_creator_folders.match_method IS NOT excluded.match_method
           OR archive_catalog_local_creator_folders.is_active <> 1`
    ).run(
      input.creatorId,
      input.rootPath,
      input.snapshot.relativePath,
      input.snapshot.absolutePath,
      input.snapshot.folderName,
      input.status,
      input.method,
      input.scannedAt
    );
    const row = this.database.prepare(
      `SELECT id FROM archive_catalog_local_creator_folders
       WHERE root_path = ? AND relative_path = ?`
    ).get(input.rootPath, input.snapshot.relativePath) as { id: number };
    return row.id;
  }

  private upsertLocalWork(input: {
    localFolderId: number;
    workId: number | null;
    snapshot: LocalWorkSnapshot;
    status: MatchStatus;
    method: string | null;
    scannedAt: string;
  }): void {
    const workRelativePath = this.localWorkRelativePath(input.snapshot);
    this.database.prepare(
      `INSERT INTO archive_catalog_local_works (
         local_creator_folder_id, work_id, relative_path, absolute_path, folder_name,
         parsed_source_order, image_count, video_count, advertisement_file_count,
         other_file_count, total_bytes, match_status, match_method, scanned_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(local_creator_folder_id, relative_path) DO UPDATE SET
         work_id = excluded.work_id,
         absolute_path = excluded.absolute_path,
         folder_name = excluded.folder_name,
         parsed_source_order = excluded.parsed_source_order,
         image_count = excluded.image_count,
         video_count = excluded.video_count,
         advertisement_file_count = excluded.advertisement_file_count,
         other_file_count = excluded.other_file_count,
         total_bytes = excluded.total_bytes,
         match_status = excluded.match_status,
         match_method = excluded.match_method,
          is_active = 1,
          scanned_at = excluded.scanned_at,
          updated_at = CURRENT_TIMESTAMP
        WHERE archive_catalog_local_works.work_id IS NOT excluded.work_id
           OR archive_catalog_local_works.absolute_path IS NOT excluded.absolute_path
           OR archive_catalog_local_works.folder_name IS NOT excluded.folder_name
           OR archive_catalog_local_works.parsed_source_order IS NOT excluded.parsed_source_order
           OR archive_catalog_local_works.image_count IS NOT excluded.image_count
           OR archive_catalog_local_works.video_count IS NOT excluded.video_count
           OR archive_catalog_local_works.advertisement_file_count IS NOT excluded.advertisement_file_count
           OR archive_catalog_local_works.other_file_count IS NOT excluded.other_file_count
           OR archive_catalog_local_works.total_bytes IS NOT excluded.total_bytes
           OR archive_catalog_local_works.match_status IS NOT excluded.match_status
           OR archive_catalog_local_works.match_method IS NOT excluded.match_method
           OR archive_catalog_local_works.is_active <> 1`
    ).run(
      input.localFolderId,
      input.workId,
      workRelativePath,
      input.snapshot.absolutePath,
      input.snapshot.folderName,
      input.snapshot.parsedSourceOrder,
      input.snapshot.imageCount,
      input.snapshot.videoCount,
      input.snapshot.advertisementFileCount,
      input.snapshot.otherFileCount,
      input.snapshot.totalBytes,
      input.status,
      input.method,
      input.scannedAt
    );
  }

  private recordImportRun(input: {
    source: string;
    format: string;
    version: string;
    sourcePath: string;
    checksum: string;
    importedAt: string;
    stats: unknown;
  }): void {
    this.database.prepare(
      `INSERT INTO archive_catalog_import_runs (
         source, source_format, source_version, source_path,
         source_sha256, imported_at, stats_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.source,
      input.format,
      input.version,
      input.sourcePath,
      input.checksum,
      input.importedAt,
      JSON.stringify(input.stats)
    );
  }
}
