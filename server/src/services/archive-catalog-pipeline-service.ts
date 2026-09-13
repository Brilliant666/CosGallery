import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { appConfig } from '../config/env.js';
import {
  ARCHIVE_CATALOG_INBOX_ROOT_SETTING_KEY,
  ARCHIVE_CATALOG_LAST_REFRESH_AT_SETTING_KEY
} from '../constants/app-setting-keys.js';
import { databaseManager } from '../db/database.js';
import {
  ArchiveCatalogService,
  type ArchiveCatalogReport,
  type LocalReconciliationResult
} from './archive-catalog-service.js';
import {
  ArchiveDownloadTaskService,
  type ArchiveDownloadPlanResult,
  type ArchiveDownloadTaskSummary
} from './archive-download-task-service.js';
import {
  ArchiveMetadataTaskService,
  validateArchiveIds,
  type ArchiveMetadataPlanResult
} from './archive-metadata-task-service.js';

export type ArchiveCatalogPipelineResult = {
  refreshedAt: string;
  local: LocalReconciliationResult;
  report: ArchiveCatalogReport['summary'];
  reportPath: string;
  plan: ArchiveDownloadPlanResult;
  tasks: ArchiveDownloadTaskSummary;
  metadata: ArchiveMetadataPlanResult;
};

export type ArchiveCatalogCreatorPipelineResult = {
  refreshedAt: string;
  creatorId: number;
  creatorFolderName: string;
  local: LocalReconciliationResult;
  plan: ArchiveDownloadPlanResult;
  tasks: ArchiveDownloadTaskSummary;
};

type ArchiveCatalogPipelineOptions = {
  galleryRoot?: string;
  reportPath?: string;
  defaultInboxRoot?: string;
  onProgress?: (message: string) => void;
};

type ArchiveCatalogCreatorPipelineOptions = {
  galleryRoot: string;
  creatorId: number;
  creatorFolderName: string;
  workFolderName?: string;
  defaultInboxRoot?: string;
  onProgress?: (message: string) => void;
};

export class ArchiveCatalogPipelineService {
  constructor(private readonly database: DatabaseSync = databaseManager.connection) {}

  /** Source handoff is not a gallery scan. Only reconcile known local folders for this exact batch. */
  async refreshAfterMetadataTasks(options: {creatorIds:number[];galleryRoot?:string;defaultInboxRoot?:string}) {
    const creatorIds=validateArchiveIds(options.creatorIds);
    const galleryRoot=path.resolve(options.galleryRoot ?? appConfig.galleryRoot);
    const rows=this.database.prepare(`SELECT id FROM archive_catalog_creators WHERE is_active=1 AND id IN (${creatorIds.map(()=>'?').join(',')})`).all(...creatorIds);
    if(rows.length!==creatorIds.length) throw new Error('来源收尾包含不存在或停用的博主。');
    await this.assertMetadataHandoffLocalState(galleryRoot, creatorIds);
    const folders=this.database.prepare(`SELECT DISTINCT creator_id AS creatorId, relative_path AS folderName
      FROM archive_catalog_local_creator_folders WHERE is_active=1 AND creator_id IN (${creatorIds.map(()=>'?').join(',')})`)
      .all(...creatorIds) as Array<{creatorId:number;folderName:string}>;
    const local=folders.length ? await new ArchiveCatalogService(this.database).reconcileLocalCreators({rootPath:galleryRoot,creators:folders}) : null;
    const download=new ArchiveDownloadTaskService(this.database);
    const targetRoot=this.getSetting(ARCHIVE_CATALOG_INBOX_ROOT_SETTING_KEY) ?? download.getLatestTargetRoot()
      ?? options.defaultInboxRoot ?? path.join(path.dirname(galleryRoot),'cos待入库');
    const plan=download.planMissing({targetRoot,creatorIds,provider:'baidu'});
    return {creatorIds,local,plan};
  }

  /** Unknown/offline local state must not become an empty set. This does not gate source collection. */
  private async assertMetadataHandoffLocalState(galleryRoot: string, creatorIds: number[]): Promise<void> {
    const entries = await (async () => {
      try {
        const root = await fs.lstat(galleryRoot);
        if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('不是安全的直接目录');
        return await fs.readdir(galleryRoot, { withFileTypes: true });
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        throw new Error(`图库根目录不可用或无法读取${code ? `（${code}）` : ''}，已保留来源；尚未计算缺失作品。`, {cause});
      }
    })();
    const placeholders = creatorIds.map(() => '?').join(',');
    const bridges = this.database.prepare(`SELECT creator_id, root_path, relative_path, is_active
      FROM archive_catalog_local_creator_folders WHERE creator_id IN (${placeholders})`)
      .all(...creatorIds) as Array<{creator_id:number;root_path:string;relative_path:string;is_active:number}>;
    if (bridges.some(bridge => !bridge.is_active || path.resolve(bridge.root_path).toLocaleLowerCase() !== galleryRoot.toLocaleLowerCase())) {
      throw new Error('选中博主存在失效或其他图库根的目录关系，本地状态待确认；已保留来源，尚未计算缺失作品。');
    }
    const names = this.database.prepare(`SELECT id AS creator_id, canonical_name AS name FROM archive_catalog_creators
      WHERE id IN (${placeholders}) UNION SELECT creator_id, alias AS name FROM archive_catalog_creator_aliases
      WHERE creator_id IN (${placeholders})`).all(...creatorIds, ...creatorIds) as Array<{creator_id:number;name:string}>;
    for (const entry of entries) {
      const matches = names.filter(row => row.name.localeCompare(entry.name, undefined, {sensitivity:'accent'}) === 0);
      if (!matches.length || matches.every(match => bridges.some(bridge => bridge.creator_id === match.creator_id
        && bridge.relative_path.localeCompare(entry.name, undefined, {sensitivity:'accent'}) === 0))) continue;
      // An unindexed empty directory is genuinely zero works; populated or unsafe paths need an existing identity bridge.
      if (!entry.isDirectory() || entry.isSymbolicLink() || (await fs.readdir(path.join(galleryRoot, entry.name))).length) {
        throw new Error(`目录“${entry.name}”尚未确认本地归属或内容，不能按零作品计算缺失；已保留来源。`);
      }
    }
  }

  private getSetting(key: string): string | null {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setSettings(entries: Array<{ key: string; value: string }>): void {
    const statement = this.database.prepare(
      `INSERT INTO app_settings (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    this.database.exec('BEGIN');
    try {
      for (const entry of entries) statement.run(entry.key, entry.value);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async refreshAfterGalleryScan(options: ArchiveCatalogPipelineOptions = {}): Promise<ArchiveCatalogPipelineResult> {
    const galleryRoot = path.resolve(options.galleryRoot ?? appConfig.galleryRoot);
    const reportPath = path.resolve(
      options.reportPath ?? path.join(appConfig.dataRoot, 'catalog', 'archive-catalog-report.json')
    );
    const catalogService = new ArchiveCatalogService(this.database);
    const downloadService = new ArchiveDownloadTaskService(this.database);
    const metadataService = new ArchiveMetadataTaskService(this.database);

    options.onProgress?.('正在只读核对图库账本……');
    const local = await catalogService.reconcileLocalRoot(galleryRoot, options.onProgress);
    const report = catalogService.buildReconciliationReport(galleryRoot);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    const configuredInboxRoot = this.getSetting(ARCHIVE_CATALOG_INBOX_ROOT_SETTING_KEY);
    const targetRoot = configuredInboxRoot
      ?? downloadService.getLatestTargetRoot()
      ?? options.defaultInboxRoot
      ?? path.join(path.dirname(galleryRoot), 'cos待入库');

    options.onProgress?.('正在根据平台作品与本地收录差集生成缺失任务……');
    const plan = downloadService.planMissing({ targetRoot, provider: 'baidu' });
    options.onProgress?.('正在生成本地博主元数据采集任务……');
    const metadata = metadataService.planLocalOnly({ source: 'costuan' });
    const refreshedAt = new Date().toISOString();
    this.setSettings([
      { key: ARCHIVE_CATALOG_INBOX_ROOT_SETTING_KEY, value: plan.targetRoot },
      { key: ARCHIVE_CATALOG_LAST_REFRESH_AT_SETTING_KEY, value: refreshedAt }
    ]);

    return {
      refreshedAt,
      local,
      report: report.summary,
      reportPath,
      plan,
      tasks: downloadService.list({ limit: 1 }).summary,
      metadata
    };
  }

  async refreshAfterCreatorGalleryScan(
    options: ArchiveCatalogCreatorPipelineOptions
  ): Promise<ArchiveCatalogCreatorPipelineResult> {
    if (!Number.isSafeInteger(options.creatorId) || options.creatorId <= 0) {
      throw new Error('博主定向刷新需要有效的 creatorId。');
    }
    const creatorFolderName = options.creatorFolderName.trim();
    if (!creatorFolderName) throw new Error('博主定向刷新需要 creatorFolderName。');

    const galleryRoot = path.resolve(options.galleryRoot);
    const catalogService = new ArchiveCatalogService(this.database);
    const downloadService = new ArchiveDownloadTaskService(this.database);
    options.onProgress?.(`正在只读核对博主账本：${creatorFolderName}……`);
    const local = await catalogService.reconcileLocalCreators({
      rootPath: galleryRoot,
      creators: [{ creatorId: options.creatorId, folderName: creatorFolderName }],
      workFolderName: options.workFolderName,
      onProgress: options.onProgress
    });
    const configuredInboxRoot = this.getSetting(ARCHIVE_CATALOG_INBOX_ROOT_SETTING_KEY);
    const targetRoot = configuredInboxRoot
      ?? downloadService.getLatestTargetRoot()
      ?? options.defaultInboxRoot
      ?? path.join(path.dirname(galleryRoot), 'cos待入库');
    options.onProgress?.(`正在更新博主缺失任务：${creatorFolderName}……`);
    const plan = downloadService.planMissing({
      targetRoot,
      provider: 'baidu',
      creatorIds: [options.creatorId]
    });

    return {
      refreshedAt: new Date().toISOString(),
      creatorId: options.creatorId,
      creatorFolderName,
      local,
      plan,
      tasks: downloadService.list({ limit: 1 }).summary
    };
  }
}
