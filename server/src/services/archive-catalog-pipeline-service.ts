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
  defaultInboxRoot?: string;
  onProgress?: (message: string) => void;
};

export class ArchiveCatalogPipelineService {
  constructor(private readonly database: DatabaseSync = databaseManager.connection) {}

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
