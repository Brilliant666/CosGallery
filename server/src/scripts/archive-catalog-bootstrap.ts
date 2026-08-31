import fs from 'node:fs/promises';
import path from 'node:path';

import { runStartupMigrations } from '../db/migration.js';
import { ArchiveCatalogService } from '../services/archive-catalog-service.js';

type Options = {
  hcfPath: string;
  costuanPath: string;
  galleryRoot: string;
  reportPath: string;
};

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--') continue;
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数 ${key} 缺少值。`);
    values.set(key, value);
    index += 1;
  }
  const hcfPath = values.get('--hcf');
  const costuanPath = values.get('--costuan');
  const galleryRoot = values.get('--gallery-root');
  const reportPath = values.get('--report') ?? path.resolve('data/catalog/archive-catalog-report.json');
  if (!hcfPath || !costuanPath || !galleryRoot) {
    throw new Error(
      '用法：archive-catalog-bootstrap --hcf <HentaiClub JSON> --costuan <Costuan JSON> '
      + '--gallery-root <只读图库目录> [--report <报告路径>]'
    );
  }
  return {
    hcfPath: path.resolve(hcfPath),
    costuanPath: path.resolve(costuanPath),
    galleryRoot: path.resolve(galleryRoot),
    reportPath: path.resolve(reportPath)
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  runStartupMigrations();
  const archiveCatalogService = new ArchiveCatalogService();

  console.log('1/3 导入 HentaiClub 首批博主种子……');
  const hcf = await archiveCatalogService.importHentaiclubSeed(options.hcfPath);
  console.log(`已导入 ${hcf.total} 位博主：喜欢 ${hcf.liked}，保留 ${hcf.kept}。`);

  console.log('2/3 导入 Costuan 资源平台目录……');
  const costuan = await archiveCatalogService.importCostuanArchive(options.costuanPath);
  console.log(
    `已匹配 ${costuan.matchedCreators}/${costuan.records} 位博主，`
    + `读取 ${costuan.importedWorks} 条平台作品。`
  );
  if (costuan.unmatchedCreators.length > 0) {
    console.log(`未匹配 Costuan 博主：${costuan.unmatchedCreators.join('、')}`);
  }

  console.log('3/3 只读扫描本地图库并对账……');
  const local = await archiveCatalogService.reconcileLocalRoot(
    options.galleryRoot,
    (message) => console.log(message)
  );
  const report = archiveCatalogService.buildReconciliationReport(options.galleryRoot);
  await fs.mkdir(path.dirname(options.reportPath), { recursive: true });
  await fs.writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({ hcf, costuan, local, report: report.summary, reportPath: options.reportPath }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
