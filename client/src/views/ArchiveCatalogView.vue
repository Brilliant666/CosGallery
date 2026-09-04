<template>
  <section class="mx-auto w-full max-w-[92rem] px-1 pb-12 sm:px-4 lg:px-7">
    <header class="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-muted">CosGallery Catalog</p>
        <h1 class="m-0 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">图库账本</h1>
        <p class="mt-2 mb-0 max-w-2xl text-sm leading-6 text-muted">
          汇总博主名单、资源平台收录和本地归档差异。在此管理博主元数据，不会修改图库文件。
        </p>
      </div>
      <span class="rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-muted">
        {{ total }} 位符合条件
      </span>
    </header>

    <ManagedCreatorRoster @changed="loadCatalog({ refreshExpanded: true })" />

    <div v-if="summary" class="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6" aria-label="账本概览">
      <article v-for="card in summaryCards" :key="card.label" class="rounded-2xl border border-border bg-surface p-4 shadow-sm">
        <p class="m-0 text-xs font-semibold text-muted">{{ card.label }}</p>
        <strong class="mt-2 block text-2xl tracking-[-0.04em]">{{ formatCount(card.value) }}</strong>
        <small class="mt-1 block text-xs leading-5 text-muted">{{ card.note }}</small>
      </article>
    </div>

    <section class="mb-6 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-5" aria-label="博主元数据采集队列">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p class="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted">Stage 1</p>
          <h2 class="mt-1 mb-0 text-lg font-semibold">本地博主来源关联</h2>
          <p class="mt-1.5 mb-0 max-w-3xl text-sm leading-6 text-muted">
            找出 G:\cos图集 中已经有作品、但尚无 Costuan 合集元数据的博主。CostuanArchiveManager 领取后复用现有搜索与百度转存流程，整批完成时会把元数据直接写回账本，再统一核对本地作品并生成真正缺失的作品任务。
          </p>
        </div>
        <div v-if="metadataTasks" class="grid grid-cols-3 gap-2 text-center sm:grid-cols-5">
          <span class="rounded-xl bg-bg px-3 py-2 text-xs"><strong class="block text-base">{{ metadataTasks.summary.total }}</strong>全部</span>
          <span class="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800"><strong class="block text-base">{{ metadataTasks.summary.actionable }}</strong>待采集</span>
          <span class="rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-700"><strong class="block text-base">{{ metadataTasks.summary.claimed }}</strong>采集中</span>
          <span class="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700"><strong class="block text-base">{{ metadataTasks.summary.completed }}</strong>已接入</span>
          <span class="rounded-xl bg-surface-alt px-3 py-2 text-xs text-muted"><strong class="block text-base">{{ metadataTasks.summary.not_found }}</strong>未收录</span>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" data-test="plan-metadata" class="h-11 rounded-xl bg-accent px-5 text-sm font-semibold text-white disabled:opacity-50" :disabled="planningMetadata" @click="planMetadata">
          {{ planningMetadata ? '正在生成…' : '生成/刷新待关联博主任务' }}
        </button>
        <p class="m-0 text-sm text-muted">运行一次“图库扫描”也会自动刷新这组任务。</p>
      </div>
      <p v-if="metadataNotice" data-test="metadata-notice" class="mt-3 mb-0 rounded-xl border border-border bg-bg px-3.5 py-3 text-sm text-text">{{ metadataNotice }}</p>

      <div v-if="metadataTasks?.items.length" class="mt-4 overflow-x-auto rounded-xl border border-border">
        <table class="w-full min-w-[42rem] border-collapse text-left text-sm">
          <thead class="bg-bg text-xs text-muted"><tr><th class="p-3">博主</th><th class="p-3">偏好</th><th class="p-3">本地作品</th><th class="p-3">来源</th><th class="p-3">采集状态</th></tr></thead>
          <tbody>
            <tr v-for="task in metadataTasks.items.slice(0, 20)" :key="task.id" class="border-t border-border">
              <td class="p-3 font-semibold">{{ task.creatorName }}</td>
              <td class="p-3">{{ task.preference === 'liked' ? '喜欢' : task.preference === 'kept' ? '保留' : '未分类' }}</td>
              <td class="p-3">{{ task.localWorks }} 套</td>
              <td class="p-3 uppercase">{{ task.source }}</td>
              <td class="p-3">{{ metadataStatusLabel(task.status) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="metadataTasks.total > 20" class="m-0 border-t border-border p-3 text-center text-xs text-muted">管理页预览前 20 位；插件领取完整队列。</p>
      </div>
    </section>

    <section class="mb-6 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-5" aria-label="缺失作品下载队列">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p class="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted">Stage 2</p>
          <h2 class="mt-1 mb-0 text-lg font-semibold">缺失作品下载队列</h2>
          <p class="mt-1.5 mb-0 max-w-3xl text-sm leading-6 text-muted">
            仅检查 G:\cos图集 中已存在并匹配到博主 ID 的目录；为这些博主已转存到百度网盘、但本地尚未关联的 Costuan 作品生成任务。插件会按博主批量复制缺失压缩包到“我的网盘/cos待入库/博主 ID”，供你随后整目录下载。
          </p>
        </div>
        <div v-if="downloadTasks" class="grid grid-cols-2 gap-2 text-center sm:grid-cols-4 xl:grid-cols-7">
          <span class="rounded-xl bg-bg px-3 py-2 text-xs"><strong class="block text-base">{{ downloadTasks.summary.total }}</strong>全部</span>
          <span class="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800"><strong class="block text-base">{{ downloadTasks.summary.pending }}</strong>待转存</span>
          <span class="rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-700"><strong class="block text-base">{{ downloadTasks.summary.downloading + downloadTasks.summary.claimed }}</strong>插件处理中</span>
          <span class="rounded-xl bg-violet-50 px-3 py-2 text-xs text-violet-700"><strong class="block text-base">{{ downloadTasks.summary.staged }}</strong>网盘已暂存</span>
          <span class="rounded-xl bg-cyan-50 px-3 py-2 text-xs text-cyan-700"><strong class="block text-base">{{ downloadTasks.summary.downloaded }}</strong>本地待入库</span>
          <span class="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700"><strong class="block text-base">{{ downloadTasks.summary.ingested }}</strong>已入库</span>
          <span class="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700"><strong class="block text-base">{{ downloadTasks.summary.failed }}</strong>失败</span>
        </div>
      </div>

      <div class="mt-4 grid gap-3 lg:grid-cols-[minmax(18rem,1fr)_auto_auto]">
        <label class="grid gap-1.5 text-xs font-semibold text-muted">
          本地待入库根目录（账本）
          <input v-model="inboxRoot" class="h-11 rounded-xl border border-border bg-bg px-3.5 text-sm text-text outline-none focus:border-accent" autocomplete="off" />
        </label>
        <button type="button" data-test="plan-downloads" class="h-11 self-end rounded-xl bg-accent px-5 text-sm font-semibold text-white disabled:opacity-50" :disabled="planningDownloads" @click="planDownloads()">
          {{ planningDownloads ? '正在生成…' : '生成全部缺失任务' }}
        </button>
        <button type="button" class="h-11 self-end rounded-xl border border-border bg-bg px-5 text-sm font-semibold text-text disabled:opacity-50" :disabled="rotatingBridgeToken" @click="rotateBridgeToken">
          {{ bridgeConfigured ? '重新生成插件密钥' : '生成插件连接密钥' }}
        </button>
      </div>

      <div class="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <p class="m-0">百度客户端完成下载 → 点击 Stage 3“扫描待入库” → 稳定文件确认后显示“本地已下载，待入库”。</p>
        <button type="button" data-test="refresh-stage2" class="h-9 rounded-xl border border-border bg-bg px-3.5 text-xs font-semibold text-text disabled:opacity-50" :disabled="stage2Refreshing" @click="refreshStage2Only">
          {{ stage2Refreshing ? '刷新中…' : '刷新状态' }}
        </button>
      </div>

      <p v-if="downloadNotice" data-test="download-notice" class="mt-3 mb-0 rounded-xl border border-border bg-bg px-3.5 py-3 text-sm text-text">{{ downloadNotice }}</p>
      <div v-if="bridgeToken" class="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-sm text-amber-900">
        <strong>请立即复制到 CostuanArchiveManager；页面刷新后不再显示。</strong>
        <div class="mt-2 flex gap-2">
          <input :value="bridgeToken" readonly class="h-10 min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-3 font-mono text-xs" />
          <button type="button" class="rounded-lg border border-amber-300 bg-white px-4 text-xs font-semibold" @click="copyBridgeToken">复制</button>
        </div>
      </div>

      <div v-if="downloadTasks?.items.length" class="mt-4 overflow-x-auto rounded-xl border border-border">
        <table class="w-full min-w-[52rem] border-collapse text-left text-sm">
          <thead class="bg-bg text-xs text-muted"><tr><th class="p-3">博主</th><th class="p-3">作品</th><th class="p-3">网盘目录</th><th class="p-3">本地目标</th><th class="p-3">状态</th></tr></thead>
          <tbody>
            <tr v-for="task in downloadTasks.items.slice(0, 20)" :key="task.id" class="border-t border-border">
              <td class="p-3 font-semibold">{{ task.creatorName }}</td>
              <td class="p-3"><span class="font-semibold">{{ task.sourceOrderLabel ?? task.targetFilename }}</span><small class="mt-0.5 block text-muted">{{ task.title }}</small></td>
              <td class="p-3 font-mono text-xs">{{ task.destinationPath }}/{{ task.sourceFolderName }}</td>
              <td class="p-3 font-mono text-xs">{{ task.targetRelativeDirectory }}\{{ task.targetFilename }}</td>
              <td class="p-3">{{ downloadStatusLabel(task.status) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="downloadTasks.total > 20" class="m-0 border-t border-border p-3 text-center text-xs text-muted">管理页预览前 20 条；插件按完整队列领取。</p>
      </div>
    </section>

    <section class="mb-6 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-5" aria-label="本地入库">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p class="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted">Stage 3</p>
          <h2 class="mt-1 mb-0 text-lg font-semibold">本地入库闭环</h2>
          <p class="mt-1.5 mb-0 max-w-3xl text-sm leading-6 text-muted">
            “扫描待入库”只确认稳定文件并建立任务；“运行可处理任务”只消费已经存在的任务。密码只从服务端本机环境读取。
          </p>
        </div>
        <span v-if="localIngestSettings" class="rounded-full px-3 py-1.5 text-xs font-semibold" :class="localIngestSettings.archivePasswordConfigured ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'">
          解压密码：{{ localIngestSettings.archivePasswordConfigured ? '已配置' : '未配置' }}
        </span>
      </div>

      <div data-test="stage3-operation-card" class="mt-4 rounded-2xl border p-4" :class="stage3OperationActive ? 'border-blue-200 bg-blue-50' : 'border-border bg-bg'">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <strong class="text-sm">{{ stage3OperationTitle }}</strong>
            <p class="mt-1 mb-0 text-xs leading-5 text-muted">{{ stage3OperationDescription }}</p>
          </div>
          <div class="flex items-center gap-3">
            <span v-if="stage3OperationActive" class="text-xs font-semibold text-blue-700">已耗时 {{ formatElapsed(stage3ElapsedMs) }}</span>
            <button type="button" data-test="refresh-stage3" class="h-9 rounded-xl border border-border bg-surface px-3.5 text-xs font-semibold text-text disabled:opacity-50" :disabled="refreshingStage3State" @click="refreshStage3State">
              {{ refreshingStage3State ? '刷新中…' : '刷新状态' }}
            </button>
          </div>
        </div>
        <div v-if="localIngestOperation?.run" class="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-7">
          <span><strong class="block text-base">{{ localIngestOperation.run.processed }} / {{ localIngestOperation.run.total }}</strong>已处理 / 总数</span>
          <span><strong class="block text-base">{{ localIngestOperation.run.ingested }}</strong>已入库</span>
          <span><strong class="block text-base">{{ localIngestOperation.run.failed }}</strong>失败</span>
          <span><strong class="block text-base">{{ localIngestOperation.run.awaitingReview }}</strong>待核查</span>
          <span><strong class="block text-base">{{ localIngestOperation.run.remaining }}</strong>剩余</span>
          <span class="col-span-2"><strong class="block text-sm">{{ localIngestOperation.run.currentJob?.creatorName ?? '—' }}</strong>{{ localIngestOperation.run.currentJob?.archiveName ?? '等待下一项' }} · {{ localIngestPhaseLabel(localIngestOperation.run.currentJob?.phase) }}</span>
        </div>
        <p v-if="localIngestOperationLastChecked" class="mt-2 mb-0 text-[0.68rem] text-muted">状态读取：{{ localIngestOperationLastChecked }}</p>
      </div>

      <div v-if="localIngestSettings" class="mt-4 grid gap-3 lg:grid-cols-2">
        <label class="grid gap-1.5 text-xs font-semibold text-muted">正式图库
          <input v-model="localIngestSettings.libraryRoot" readonly aria-readonly="true" class="h-11 rounded-xl border border-border bg-bg px-3.5 text-sm text-muted" />
          <small class="font-normal leading-5 text-muted">V1 正式图库根目录由 GALLERY_ROOT 启动配置决定，修改后需要重启服务。</small>
        </label>
        <label class="grid gap-1.5 text-xs font-semibold text-muted">本地待入库
          <input v-model="localIngestSettings.inboxRoot" data-test="local-ingest-inbox-root" :disabled="stage3WriteLocked" :title="stage3LockReason" class="h-11 rounded-xl border border-border bg-bg px-3.5 text-sm text-text disabled:cursor-not-allowed disabled:opacity-60" />
        </label>
        <label class="grid gap-1.5 text-xs font-semibold text-muted">处理中目录
          <input v-model="localIngestSettings.processingRoot" data-test="local-ingest-processing-root" :disabled="stage3WriteLocked" :title="stage3LockReason" class="h-11 rounded-xl border border-border bg-bg px-3.5 text-sm text-text disabled:cursor-not-allowed disabled:opacity-60" />
        </label>
        <label class="grid gap-1.5 text-xs font-semibold text-muted">7-Zip 路径
          <input v-model="localIngestSettings.sevenZipPath" data-test="local-ingest-sevenzip" :disabled="stage3WriteLocked" :title="stage3LockReason" class="h-11 rounded-xl border border-border bg-bg px-3.5 text-sm text-text disabled:cursor-not-allowed disabled:opacity-60" />
        </label>
        <div class="grid gap-2">
          <label class="grid gap-1.5 text-xs font-semibold text-muted">允许处理的博主（每行一位）
            <textarea data-test="local-ingest-allowlist" v-model="localIngestAllowlistText" :disabled="stage3WriteLocked" :title="stage3LockReason" rows="3" class="rounded-xl border border-border bg-bg px-3.5 py-3 text-sm text-text disabled:cursor-not-allowed disabled:opacity-60" />
          </label>
          <div>
            <button type="button" data-test="discover-inbox-creators" class="h-9 rounded-xl border border-border bg-bg px-3.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked || !localIngestSettings" :title="stage3LockReason" @click="discoverLocalIngestInboxCreators">读取待入库博主</button>
          </div>
          <div v-if="localIngestInboxCreators" data-test="inbox-creators-result" class="rounded-xl border border-border bg-bg p-3 text-xs leading-5 text-text">
            <p class="m-0 font-semibold">待入库：{{ localIngestInboxCreators.summary.matchedCreatorCount }} 位博主 / {{ localIngestInboxCreators.summary.archiveCount }} 个压缩包 / {{ inboxExistingJobCount }} 个已有任务</p>
            <p v-if="localIngestInboxCreators.unmapped.length" class="mt-1 mb-0 text-amber-700">{{ localIngestInboxCreators.unmapped.length }} 个目录无法唯一映射，未加入名单。</p>
            <div class="mt-2 flex flex-wrap gap-2">
              <button type="button" data-test="append-inbox-creators" class="rounded-lg border border-border bg-surface px-3 py-1.5 font-semibold disabled:opacity-50" :disabled="stage3WriteLocked || localIngestInboxCreators.detected.length === 0" :title="stage3LockReason" @click="applyDiscoveredInboxCreators('append')">追加到当前名单</button>
              <button type="button" data-test="replace-inbox-creators" class="rounded-lg border border-border bg-surface px-3 py-1.5 font-semibold disabled:opacity-50" :disabled="stage3WriteLocked || localIngestInboxCreators.detected.length === 0" :title="stage3LockReason" @click="applyDiscoveredInboxCreators('replace')">替换当前名单</button>
              <button type="button" data-test="cancel-inbox-creators" class="rounded-lg border border-border bg-surface px-3 py-1.5 font-semibold disabled:opacity-50" :disabled="stage3WriteLocked" :title="stage3LockReason" @click="cancelInboxCreatorDiscovery">取消</button>
            </div>
            <details v-if="localIngestInboxCreators.unmapped.length" class="mt-2"><summary class="cursor-pointer font-semibold">查看详情</summary><ul class="mt-1 mb-0 grid gap-1 pl-5"><li v-for="entry in localIngestInboxCreators.unmapped" :key="entry.folderName">{{ entry.folderName }} · {{ entry.archiveCount }} 个压缩包 · {{ entry.mappingReason }}</li></ul></details>
          </div>
        </div>
        <label class="grid gap-1.5 text-xs font-semibold text-muted">文件稳定秒数
          <input v-model.number="localIngestSettings.fileStableSeconds" data-test="local-ingest-stable-seconds" :disabled="stage3WriteLocked" :title="stage3LockReason" type="number" min="1" max="3600" class="h-11 rounded-xl border border-border bg-bg px-3.5 text-sm text-text disabled:cursor-not-allowed disabled:opacity-60" />
        </label>
        <div class="flex items-end gap-3 pb-2 text-sm">
          <label class="flex items-center gap-2"><input v-model="localIngestSettings.recycleAfterIngest" data-test="local-ingest-recycle" :disabled="stage3WriteLocked" :title="stage3LockReason" type="checkbox" />确认入库后移入回收站</label>
          <span class="text-muted">最大解压深度固定为 2</span>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap gap-2">
        <button type="button" data-test="save-local-ingest" class="h-10 rounded-xl border border-border bg-bg px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked || !localIngestSettings" :title="stage3LockReason" @click="saveLocalIngestConfig">保存配置</button>
        <button type="button" data-test="validate-local-ingest" class="h-10 rounded-xl border border-border bg-bg px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked || !localIngestSettings" :title="stage3LockReason" @click="validateLocalIngestConfig">验证环境</button>
        <button type="button" data-test="smoke-local-ingest-recycle" class="h-10 rounded-xl border border-border bg-bg px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked || !localIngestSettings" :title="stage3LockReason" @click="smokeTestRecycleBin">回收站测试</button>
        <button type="button" data-test="scan-local-ingest" class="h-10 rounded-xl bg-accent px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked || !localIngestSettings || localIngestAllowlistDirty" :title="stage3ActionTitle" @click="scanLocalInbox">扫描待入库</button>
        <button type="button" data-test="run-local-ingest-batch" class="h-10 rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked || !localIngestSettings || localIngestAllowlistDirty" :title="stage3ActionTitle" @click="runLocalBatch">运行可处理任务</button>
      </div>
      <p v-if="localIngestNotice" data-test="local-ingest-notice" class="mt-3 mb-0 rounded-xl border border-border bg-bg px-3.5 py-3 text-sm text-text">{{ localIngestNotice }}</p>

      <div v-if="localIngestDashboard" class="mt-4 grid grid-cols-2 gap-2 text-center sm:grid-cols-3 lg:grid-cols-6">
        <span class="rounded-xl bg-bg px-3 py-2 text-xs"><strong class="block text-base">{{ localIngestDashboard.summary.total }}</strong>全部任务</span>
        <span class="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800"><strong class="block text-base">{{ localIngestDashboard.summary.pending }}</strong>待处理</span>
        <span class="rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-700"><strong class="block text-base">{{ localIngestDashboard.summary.running }}</strong>处理中</span>
        <span class="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700"><strong class="block text-base">{{ localIngestDashboard.summary.ingested }}</strong>已入库</span>
        <span class="rounded-xl bg-violet-50 px-3 py-2 text-xs text-violet-700"><strong class="block text-base">{{ localIngestDashboard.summary.awaitingReview }}</strong>待核查</span>
        <span class="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700"><strong class="block text-base">{{ localIngestDashboard.summary.failed }}</strong>失败</span>
      </div>

      <div v-if="localIngestDashboard?.creators.length" data-test="local-ingest-creators" class="mt-4 grid gap-2">
        <article v-for="creator in localIngestDashboard.creators" :key="creator.creatorId" class="overflow-hidden rounded-xl border border-border bg-bg" :data-current="creator.isCurrent ? 'true' : undefined">
          <button type="button" class="grid w-full grid-cols-[minmax(10rem,1fr)_repeat(5,minmax(4rem,auto))] items-center gap-3 p-3 text-left text-xs" :aria-expanded="localIngestCreatorId === creator.creatorId" @click="toggleLocalIngestCreator(creator.creatorId)">
            <span><strong class="block text-sm">{{ creator.creatorName }} <em v-if="creator.isCurrent" class="not-italic text-blue-700">· 当前处理</em></strong><small class="text-muted">{{ creator.ingested }} / {{ creator.total }} · {{ creator.progressPercent }}%</small></span>
            <span><strong class="block">{{ creator.pending }}</strong>待处理</span><span><strong class="block">{{ creator.running }}</strong>处理中</span><span><strong class="block">{{ creator.ingested }}</strong>已入库</span><span><strong class="block">{{ creator.awaitingReview }}</strong>待核查</span><span><strong class="block">{{ creator.failed }}</strong>失败</span>
          </button>
          <div v-if="localIngestCreatorId === creator.creatorId" class="border-t border-border bg-surface p-3">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
              <label class="flex items-center gap-2 text-xs font-semibold text-muted">任务状态
                <select v-model="localIngestJobStatus" data-test="local-ingest-status-filter" class="h-9 rounded-lg border border-border bg-bg px-3 text-xs text-text" @change="changeLocalIngestJobFilter">
                  <option value="">全部</option><option value="pending">待处理</option><option value="running">处理中</option><option value="awaiting_review">待核查</option><option value="failed">失败</option><option value="completed">已完成</option>
                </select>
              </label>
              <span class="text-xs text-muted">共 {{ localIngestDashboard.total }} 条 · 第 {{ localIngestDashboard.page }} / {{ localIngestJobTotalPages }} 页</span>
            </div>
            <div v-if="localIngestJobs.length" class="overflow-x-auto rounded-xl border border-border">
              <table class="w-full min-w-[70rem] border-collapse text-left text-sm">
                <thead class="bg-bg text-xs text-muted"><tr><th class="p-3">博主 / 压缩包</th><th class="p-3">映射</th><th class="p-3">状态</th><th class="p-3">校验 / 清理</th><th class="p-3">预览</th><th class="p-3">操作</th></tr></thead>
                <tbody><tr v-for="job in localIngestJobs" :key="job.id" class="border-t border-border align-top">
                  <td class="p-3"><strong>{{ job.creatorName }}</strong><small class="mt-1 block font-mono text-muted">{{ job.sourceArchiveName }} · {{ formatBytes(job.sourceArchiveSize) }}</small></td>
                  <td class="p-3"><span class="font-mono text-xs">source {{ job.sourceWorkId ?? '—' }}</span><small class="mt-1 block text-muted">task {{ job.archiveDownloadTaskId ?? '—' }}</small></td>
                  <td class="p-3"><strong>{{ localIngestStatusLabel(job.status) }}</strong><small class="mt-1 block text-muted">{{ localIngestPhaseLabel(job.phase) }}</small><small v-if="job.errorCode" class="mt-1 block text-red-700">{{ localIngestErrorLabel(job) }}</small></td>
                  <td class="p-3">{{ job.validationStatus }}<small class="mt-1 block text-muted">cleanup: {{ job.cleanupStatus }}</small></td>
                  <td class="p-3 text-xs"><template v-if="job.summary">图片 {{ jobSummaryValue(job, 'imageCount') }} · 视频 {{ jobSummaryValue(job, 'videoCount') }} · 广告 {{ jobSummaryValue(job, 'advertisementFileCount') }}<small class="mt-1 block break-all text-muted">{{ jobSummaryValue(job, 'plannedTargetPath') }}</small><details class="mt-2 max-w-[30rem]"><summary class="cursor-pointer font-semibold text-accent">完整入库预览</summary><dl class="mt-2 grid grid-cols-[6rem_minmax(12rem,1fr)] gap-x-2 gap-y-1 break-all leading-5 text-muted"><dt>原始标题</dt><dd>{{ jobSummaryValue(job, 'rawTitle') }}</dd><dt>源压缩包</dt><dd>{{ job.sourceArchivePath }}</dd><dt>SHA-256</dt><dd class="font-mono">{{ job.sourceArchiveSha256 }}</dd><dt>外层格式</dt><dd>{{ jobSummaryValue(job, 'outerFormat') }}</dd><dt>第一层输出</dt><dd>{{ jobSummaryList(job, 'levelOneOutput') }}</dd><dt>内层原名</dt><dd>{{ jobSummaryValue(job, 'innerOriginalName') }}</dd><dt>内层工作名</dt><dd>{{ jobSummaryValue(job, 'innerWorkingName') }}</dd><dt>未知文件</dt><dd>{{ jobSummaryList(job, 'unknownFiles') }}</dd><dt>警告</dt><dd>{{ jobSummaryList(job, 'warnings') }}</dd></dl></details></template><span v-else class="text-muted">尚无预览</span></td>
                  <td class="p-3"><button v-if="job.status !== 'ingested' && job.status !== 'awaiting_review'" type="button" data-test="run-local-ingest-job" class="rounded-lg border border-border bg-bg px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked" :title="stage3LockReason" @click="runLocalJob(job.id)">继续任务</button><button v-else-if="job.status === 'ingested' && job.cleanupStatus === 'failed'" type="button" data-test="retry-local-ingest-cleanup" class="rounded-lg border border-border bg-bg px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked" :title="stage3LockReason" @click="retryLocalCleanup(job.id)">重试回收</button><span v-else class="text-xs text-muted">—</span></td>
                </tr></tbody>
              </table>
            </div>
            <p v-else class="m-0 rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted">当前筛选没有任务。</p>
            <div v-if="localIngestDashboard.total > localIngestJobLimit" class="mt-3 flex items-center justify-center gap-3">
              <button type="button" data-test="local-ingest-prev" class="h-9 rounded-lg border border-border bg-bg px-3 text-xs font-semibold disabled:opacity-40" :disabled="localIngestJobPage <= 1" @click="goToLocalIngestJobPage(localIngestJobPage - 1)">上一页</button>
              <span class="text-xs text-muted">第 {{ localIngestJobPage }} 页</span>
              <button type="button" data-test="local-ingest-next" class="h-9 rounded-lg border border-border bg-bg px-3 text-xs font-semibold disabled:opacity-40" :disabled="!localIngestDashboard.hasMore" @click="goToLocalIngestJobPage(localIngestJobPage + 1)">下一页</button>
            </div>
          </div>
        </article>
      </div>
      <p v-else class="mt-4 mb-0 rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted">尚无本地入库任务。请先明确点击“扫描待入库”。</p>
    </section>

    <form class="mb-5 grid gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm lg:grid-cols-[minmax(14rem,1fr)_repeat(3,minmax(9rem,0.22fr))_auto]" @submit.prevent="applyFilters">
      <label class="grid gap-1.5 text-xs font-semibold text-muted">
        搜索博主
        <input
          v-model="query"
          type="search"
          placeholder="输入博主 ID 或名称"
          class="h-11 min-w-0 rounded-xl border border-border bg-bg px-3.5 text-sm text-text outline-none transition focus:border-accent"
        />
      </label>
      <label class="grid gap-1.5 text-xs font-semibold text-muted">
        偏好
        <select v-model="preference" class="h-11 rounded-xl border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent" @change="applyFilters">
          <option value="">喜欢 + 保留</option>
          <option value="liked">喜欢</option>
          <option value="kept">保留</option>
        </select>
      </label>
      <label class="grid gap-1.5 text-xs font-semibold text-muted">
        分级
        <select v-model="rating" class="h-11 rounded-xl border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent" @change="applyFilters">
          <option value="">R15 + R18</option>
          <option value="R15">R15</option>
          <option value="R18">R18</option>
        </select>
      </label>
      <label class="grid gap-1.5 text-xs font-semibold text-muted">
        入库状态
        <select v-model="state" class="h-11 rounded-xl border border-border bg-bg px-3 text-sm text-text outline-none focus:border-accent" @change="applyFilters">
          <option value="">全部状态</option>
          <option value="missing">有待收录作品</option>
          <option value="no-local">尚未入库</option>
          <option value="complete">已完整关联</option>
          <option value="no-source">尚未接入资源</option>
          <option value="unresolved">待核查</option>
        </select>
      </label>
      <div class="flex items-end gap-2">
        <button type="submit" class="h-11 rounded-xl bg-accent px-5 text-sm font-semibold text-white">筛选</button>
        <button type="button" class="h-11 rounded-xl border border-border bg-bg px-4 text-sm font-semibold text-text" @click="resetFilters">重置</button>
      </div>
    </form>

    <p v-if="error" role="alert" class="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
      {{ error }}
    </p>

    <div v-if="loading" class="rounded-2xl border border-dashed border-border py-20 text-center text-muted">
      正在读取图库账本…
    </div>

    <div v-else-if="items.length" class="grid gap-3" aria-label="博主账本列表">
      <article v-for="creator in items" :key="creator.id" data-test="catalog-creator" class="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div class="catalog-row grid items-center gap-3 p-4">
          <div class="min-w-0">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <strong class="truncate text-[0.98rem]">{{ creator.name }}</strong>
              <span class="rounded-full px-2 py-0.5 text-[0.68rem] font-bold" :class="preferenceClass(creator.preference)">
                {{ creator.preference === 'liked' ? '喜欢' : creator.preference === 'kept' ? '保留' : '未分类' }}
              </span>
              <span class="rounded-full px-2 py-0.5 text-[0.68rem] font-bold text-white" :class="ratingClass(creator.rating)">
                {{ creator.rating ?? '未分级' }}
              </span>
            </div>
            <p class="mt-1 mb-0 text-xs text-muted">{{ creator.sourceCollections }} 个资源合集 · {{ statusLabel(creator) }}</p>
          </div>
          <CatalogMetric label="平台作品" :value="creator.remoteWorks" />
          <CatalogMetric label="本地作品" :value="creator.localWorks" />
          <CatalogMetric label="已关联" :value="creator.matchedWorks" />
          <CatalogMetric label="待收录" :value="creator.missingWorks" :alert="creator.missingWorks > 0" />
          <button
            type="button"
            class="h-10 rounded-xl border border-border bg-bg px-4 text-sm font-semibold text-text transition hover:border-accent"
            :aria-expanded="expandedCreatorId === creator.id"
            @click="toggleCreator(creator.id)"
          >
            {{ expandedCreatorId === creator.id ? '收起' : '查看' }}
          </button>
        </div>

        <div v-if="expandedCreatorId === creator.id" data-test="catalog-detail" class="border-t border-border bg-bg/45 p-4 sm:p-5">
          <p v-if="detailLoadingId === creator.id" class="m-0 py-6 text-center text-sm text-muted">正在读取详细账本…</p>
          <p v-else-if="detailErrors[creator.id]" class="m-0 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            {{ detailErrors[creator.id] }}
          </p>
          <div v-else-if="details[creator.id]" class="grid gap-5">
            <section>
              <div class="mb-2 flex items-center justify-between gap-3">
                <h2 class="m-0 text-sm font-semibold">资源来源</h2>
                <span class="text-xs text-muted">别名 {{ details[creator.id].aliases.length }} 个</span>
              </div>
              <div v-if="details[creator.id].collections.length" class="grid gap-2 md:grid-cols-2">
                <article v-for="collection in details[creator.id].collections" :key="collection.id" class="rounded-xl border border-border bg-surface p-3.5">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <span class="text-[0.68rem] font-bold uppercase tracking-[0.1em] text-muted">{{ collection.source }}</span>
                      <h3 class="mt-1 mb-0 text-sm leading-5">{{ collection.title }}</h3>
                    </div>
                    <a v-if="collection.url" :href="collection.url" target="_blank" rel="noreferrer" class="shrink-0 text-xs font-semibold text-accent">打开来源</a>
                  </div>
                  <p class="mt-2 mb-0 text-xs text-muted">
                    平台标注 {{ collection.declaredWorkCount ?? '未知' }} 套
                    <template v-if="collection.deliveries.length"> · {{ deliveryLabel(collection.deliveries[0]) }}</template>
                  </p>
                </article>
              </div>
              <p v-else class="m-0 rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted">尚未接入资源平台合集。</p>
            </section>

            <section>
              <div class="mb-2 flex items-center justify-between gap-3">
                <h2 class="m-0 text-sm font-semibold">待收录作品</h2>
                <div class="flex items-center gap-3">
                  <button v-if="details[creator.id].missing.length && creator.localWorks > 0" type="button" class="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold" @click="planDownloads(creator.id)">只生成此博主任务</button>
                  <span class="text-xs font-semibold" :class="details[creator.id].missing.length ? 'text-amber-600' : 'text-emerald-600'">
                    {{ details[creator.id].missing.length }} 套
                  </span>
                </div>
              </div>
              <div v-if="details[creator.id].missing.length" class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                <article v-for="work in details[creator.id].missing" :key="work.workId" class="rounded-xl border border-border bg-surface px-3.5 py-3">
                  <div class="flex items-start gap-3">
                    <span class="shrink-0 rounded-md bg-amber-100 px-2 py-1 text-[0.68rem] font-bold text-amber-800">
                      {{ work.sourceOrderLabel ?? (work.sourceOrder === null ? '无序号' : `NO.${String(work.sourceOrder).padStart(3, '0')}`) }}
                    </span>
                    <div class="min-w-0">
                      <p class="m-0 text-sm font-medium leading-5">{{ work.title }}</p>
                      <small class="mt-1 block text-[0.68rem] uppercase text-muted">{{ work.source }}</small>
                    </div>
                  </div>
                </article>
              </div>
              <p v-else class="m-0 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-700">平台作品已全部关联到本地图库。</p>
            </section>

            <section v-if="details[creator.id].unresolved.length">
              <h2 class="mb-2 text-sm font-semibold text-amber-700">待核查的本地目录</h2>
              <ul class="m-0 grid gap-2 p-0 list-none">
                <li v-for="work in details[creator.id].unresolved" :key="work.relativePath" class="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-800">
                  {{ work.folderName }} · {{ work.status === 'ambiguous' ? '存在多个可能匹配' : '未找到匹配作品' }}
                </li>
              </ul>
            </section>
          </div>
        </div>
      </article>
    </div>

    <div v-else-if="!error" class="rounded-2xl border border-dashed border-border py-16 text-center text-muted">
      没有符合当前条件的博主。
    </div>

    <footer v-if="total > limit" class="mt-5 flex items-center justify-center gap-3">
      <button type="button" class="h-10 rounded-xl border border-border bg-surface px-4 text-sm font-semibold disabled:opacity-40" :disabled="page <= 1" @click="goToPage(page - 1)">上一页</button>
      <span class="text-sm text-muted">第 {{ page }} / {{ totalPages }} 页</span>
      <button type="button" class="h-10 rounded-xl border border-border bg-surface px-4 text-sm font-semibold disabled:opacity-40" :disabled="!hasMore" @click="goToPage(page + 1)">下一页</button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import ManagedCreatorRoster from '../components/ManagedCreatorRoster.vue';
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue';

import {
  fetchArchiveBridgeStatus,
  fetchArchiveCatalog,
  fetchArchiveCatalogCreator,
  fetchArchiveDownloadTasks,
  fetchArchiveMetadataTasks,
  planArchiveDownloadTasks,
  planArchiveMetadataTasks,
  rotateArchiveBridgeToken,
  fetchLocalIngestInboxCreators,
  fetchLocalIngestJobs,
  fetchLocalIngestOperation,
  fetchLocalIngestSettings,
  retryLocalIngestCleanup,
  runLocalIngestBatch,
  runLocalIngestJob,
  saveLocalIngestSettings,
  scanLocalIngestInbox,
  smokeTestLocalIngestRecycleBin,
  validateLocalIngestSettings
} from '../api/gallery';
import type {
  ArchiveCatalogCreator,
  ArchiveCatalogCreatorDetail,
  ArchiveCatalogPreference,
  ArchiveCatalogState,
  ArchiveCatalogSummary,
  ArchiveDownloadTaskStatus,
  ArchiveDownloadTasksPayload,
  ArchiveMetadataTaskStatus,
  ArchiveMetadataTasksPayload,
  ContentRating,
  LocalIngestInboxCreatorsResult,
  LocalIngestJob,
  LocalIngestJobFilter,
  LocalIngestJobsDashboard,
  LocalIngestOperation,
  LocalIngestSettings
} from '../types/api';
import { RequestError } from '../api/http';

const CatalogMetric = defineComponent({
  props: {
    label: { type: String, required: true },
    value: { type: Number, required: true },
    alert: { type: Boolean, default: false }
  },
  setup(props) {
    return () => h('div', { class: 'min-w-[4.5rem]' }, [
      h('small', { class: 'block text-[0.68rem] font-semibold text-muted' }, props.label),
      h('strong', { class: props.alert ? 'mt-0.5 block text-base text-amber-600' : 'mt-0.5 block text-base text-text' }, String(props.value))
    ]);
  }
});

const limit = 50;
const items = ref<ArchiveCatalogCreator[]>([]);
const summary = ref<ArchiveCatalogSummary | null>(null);
const total = ref(0);
const page = ref(1);
const hasMore = ref(false);
const loading = ref(false);
const error = ref('');
const query = ref('');
const preference = ref<'' | ArchiveCatalogPreference>('');
const rating = ref<'' | ContentRating>('');
const state = ref<'' | ArchiveCatalogState>('');
const expandedCreatorId = ref<number | null>(null);
const detailLoadingId = ref<number | null>(null);
const details = ref<Record<number, ArchiveCatalogCreatorDetail>>({});
const detailErrors = ref<Record<number, string>>({});
const inboxRoot = ref('G:\\cos待入库');
const downloadTasks = ref<ArchiveDownloadTasksPayload | null>(null);
const planningDownloads = ref(false);
const stage2Refreshing = ref(false);
const downloadNotice = ref('');
const bridgeConfigured = ref(false);
const bridgeToken = ref('');
const rotatingBridgeToken = ref(false);
const metadataTasks = ref<ArchiveMetadataTasksPayload | null>(null);
const planningMetadata = ref(false);
const metadataNotice = ref('');
const localIngestSettings = ref<LocalIngestSettings | null>(null);
const localIngestAllowlistText = ref('');
const localIngestInboxCreators = ref<LocalIngestInboxCreatorsResult | null>(null);
const localIngestDashboard = ref<LocalIngestJobsDashboard | null>(null);
const localIngestCreatorId = ref<number | null>(null);
const localIngestJobStatus = ref<'' | LocalIngestJobFilter>('');
const localIngestJobPage = ref(1);
const localIngestJobLimit = 50;
const localIngestRequestBusy = ref(false);
const refreshingStage3State = ref(false);
const localIngestOperation = ref<LocalIngestOperation | null>(null);
const localIngestOperationLastChecked = ref('');
const stage3Clock = ref(Date.now());
const localIngestNotice = ref('');
let stage3PollTimer: ReturnType<typeof setTimeout> | null = null;
let stage3ClockTimer: ReturnType<typeof setInterval> | null = null;
let lastActiveOperationKind: LocalIngestOperation['kind'] = null;
let completionRefreshInFlight = false;

function parseLocalIngestAllowlist(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))];
}

function normalizeCreatorDraftIdentity(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s_\-@·・.]+/gu, '');
}

const localIngestAllowlistDirty = computed(() => {
  if (!localIngestSettings.value) return false;
  return JSON.stringify(parseLocalIngestAllowlist(localIngestAllowlistText.value))
    !== JSON.stringify(localIngestSettings.value.allowlist);
});

const localIngestJobs = computed(() => localIngestDashboard.value?.items ?? []);
const stage3OperationActive = computed(() => localIngestOperation.value?.state !== undefined && localIngestOperation.value.state !== 'idle');
const stage3WriteLocked = computed(() => localIngestRequestBusy.value || stage3OperationActive.value);
const stage3LockReason = computed(() => {
  if (localIngestRequestBusy.value && !stage3OperationActive.value) return '正在向服务端发起 Stage 3 操作，当前任务完成后可再次操作。';
  if (localIngestOperation.value?.state === 'scanning') return 'Stage 3 正在扫描，其他操作暂不可用。';
  if (localIngestOperation.value?.kind === 'batch') return 'Stage 3 正在运行批次，当前批次完成后可再次操作。';
  if (stage3OperationActive.value) return 'Stage 3 当前已有操作，完成后可再次操作。';
  return '';
});
const stage3ActionTitle = computed(() => stage3LockReason.value || (localIngestAllowlistDirty.value ? '请先保存博主名单草稿' : undefined));
const stage3ElapsedMs = computed(() => {
  const operation = localIngestOperation.value;
  if (!operation?.startedAt || operation.state === 'idle') return 0;
  return Math.max(operation.elapsedMs, stage3Clock.value - Date.parse(operation.startedAt));
});
const stage3OperationTitle = computed(() => {
  const operation = localIngestOperation.value;
  if (operation?.state === 'scanning') return 'Stage 3 正在扫描待入库';
  if (operation?.state === 'running' && operation.kind === 'batch') return `正在运行 ${operation.run?.processed ?? 0} / ${operation.run?.total ?? 0}`;
  if (operation?.state === 'running') return 'Stage 3 正在执行操作';
  return 'Stage 3 当前空闲';
});
const stage3OperationDescription = computed(() => {
  const operation = localIngestOperation.value;
  if (stage3OperationActive.value) return `${operation?.message ?? '服务端操作正在执行'}；扫描或运行期间全部 Stage 3 写操作已锁定。`;
  const completed = operation?.lastCompleted;
  if (!completed) return '尚无最近操作记录。空闲时不会自动轮询。';
  return `最近一次${localIngestOperationKindLabel(completed.kind)}于 ${formatClockTime(completed.finishedAt)} ${completed.succeeded ? '完成' : '失败'}。空闲时不会自动轮询。`;
});
const localIngestJobTotalPages = computed(() => Math.max(1, Math.ceil((localIngestDashboard.value?.total ?? 0) / localIngestJobLimit)));

const inboxExistingJobCount = computed(() => {
  const summary = localIngestInboxCreators.value?.summary;
  return summary
    ? summary.queuedJobCount + summary.failedJobCount + summary.awaitingReviewJobCount
    : 0;
});

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit)));
const summaryCards = computed(() => summary.value ? [
  { label: '首批博主', value: summary.value.creators, note: `喜欢 ${summary.value.liked} · 保留 ${summary.value.kept}` },
  { label: '内容分级', value: summary.value.r18, note: `R18 ${summary.value.r18} · R15 ${summary.value.r15}` },
  { label: '已接入来源', value: summary.value.creatorsWithSources, note: `${summary.value.sourceCollections} 个资源合集` },
  { label: '平台作品', value: summary.value.remoteWorks, note: '当前资源平台已记录' },
  { label: '本地作品', value: summary.value.localWorks, note: `${summary.value.matchedWorks} 套已关联` },
  { label: '待收录作品', value: summary.value.missingWorks, note: `${summary.value.unresolvedLocalWorks} 套待核查` }
] : []);

function formatCount(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let next = value / 1024;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) { next /= 1024; index += 1; }
  return `${next.toFixed(next >= 100 ? 0 : 1)} ${units[index]}`;
}

function formatElapsed(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(remainingMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatClockTime(value: string | Date) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

function localIngestOperationKindLabel(kind: NonNullable<LocalIngestOperation['kind']>) {
  return ({
    scan: '扫描',
    batch: '批次运行',
    'single-job': '单项运行',
    cleanup: '回收清理',
    'discover-creators': '待入库博主读取',
    'save-settings': '配置保存',
    validation: '环境验证',
    'recycle-test': '回收站测试'
  } as const)[kind];
}

function localIngestPhaseLabel(phase?: string) {
  if (!phase) return '—';
  return ({
    discovered: '已发现',
    waiting_stable: '等待文件稳定',
    mapping: '精确映射',
    testing_outer: '校验外层压缩包',
    extracting_outer: '解压外层压缩包',
    detecting_inner: '识别内层压缩包',
    renaming_inner: '修正内层后缀',
    testing_inner: '校验内层压缩包',
    extracting_inner: '解压内层压缩包',
    validating: '校验媒体',
    awaiting_commit: '等待提交',
    committing: '写入正式图库',
    rescanning: '定向扫描图库',
    reconciling: '账本对账',
    cleanup: '移入回收站',
    done: '已完成'
  } as Record<string, string>)[phase] ?? phase;
}

function localIngestStatusLabel(status: LocalIngestJob['status']) {
  return ({ queued: '待处理', running: '处理中', awaiting_review: '待人工核查', reconciling: '对账中', ingested: '已入库', failed: '失败' } as const)[status];
}

function localIngestErrorLabel(job: LocalIngestJob) {
  if (job.errorCode === 'INTERRUPTED_PROCESS') return '上次进程中断，可继续';
  return `${job.errorCode}：${job.errorDetail ?? '未提供详细信息'}`;
}

function jobSummaryValue(job: LocalIngestJob, key: string) {
  const value = job.summary?.[key];
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '—';
}

function jobSummaryList(job: LocalIngestJob, key: string) {
  const value = job.summary?.[key];
  return Array.isArray(value) && value.length > 0 ? value.map(String).join('、') : '无';
}

async function loadLocalIngestVisiblePage() {
  if (!localIngestCreatorId.value) return;
  let payload = await fetchLocalIngestJobs({
    creatorId: localIngestCreatorId.value,
    status: localIngestJobStatus.value || undefined,
    page: localIngestJobPage.value,
    limit: localIngestJobLimit
  });
  const finalPage = Math.max(1, Math.ceil(payload.total / localIngestJobLimit));
  if (localIngestJobPage.value > finalPage) {
    localIngestJobPage.value = finalPage;
    payload = await fetchLocalIngestJobs({
      creatorId: localIngestCreatorId.value,
      status: localIngestJobStatus.value || undefined,
      page: finalPage,
      limit: localIngestJobLimit
    });
  }
  localIngestDashboard.value = payload;
}

async function loadLocalIngestDashboard(options: { selectDefault?: boolean; refreshVisible?: boolean } = {}) {
  const summaryPayload = await fetchLocalIngestJobs({ page: 1, limit: localIngestJobLimit });
  const selectedExists = summaryPayload.creators.some((creator) => creator.creatorId === localIngestCreatorId.value);
  if (!selectedExists) {
    localIngestCreatorId.value = options.selectDefault === false ? null : summaryPayload.creators[0]?.creatorId ?? null;
    localIngestJobPage.value = 1;
  }
  localIngestDashboard.value = summaryPayload;
  if (localIngestCreatorId.value && options.refreshVisible !== false) await loadLocalIngestVisiblePage();
}

async function loadLocalIngest() {
  const settings = await fetchLocalIngestSettings();
  localIngestSettings.value = settings;
  localIngestAllowlistText.value = settings.allowlist.join('\n');
  await loadLocalIngestDashboard({ selectDefault: true });
}

function optimisticLocalIngestOperation(
  state: 'scanning' | 'running',
  kind: NonNullable<LocalIngestOperation['kind']>,
  message: string
): LocalIngestOperation {
  const timestamp = new Date().toISOString();
  return {
    state,
    kind,
    startedAt: timestamp,
    updatedAt: timestamp,
    elapsedMs: 0,
    message,
    run: kind === 'batch' ? { total: 0, processed: 0, ingested: 0, failed: 0, awaitingReview: 0, remaining: 0, currentJob: null } : null,
    lastCompleted: localIngestOperation.value?.lastCompleted ?? null
  };
}

function stopStage3Polling() {
  if (stage3PollTimer) clearTimeout(stage3PollTimer);
  stage3PollTimer = null;
  if (stage3ClockTimer) clearInterval(stage3ClockTimer);
  stage3ClockTimer = null;
}

function startStage3Clock() {
  if (stage3ClockTimer || !stage3OperationActive.value || document.hidden) return;
  stage3Clock.value = Date.now();
  stage3ClockTimer = setInterval(() => { stage3Clock.value = Date.now(); }, 1000);
}

function scheduleStage3Poll(delay = 10_000) {
  if (stage3PollTimer) clearTimeout(stage3PollTimer);
  stage3PollTimer = null;
  if (!stage3OperationActive.value || document.hidden) return;
  startStage3Clock();
  stage3PollTimer = setTimeout(() => { void pollStage3Operation(); }, delay);
}

function adoptOperationConflict(reason: unknown): boolean {
  if (!(reason instanceof RequestError) || reason.status !== 409) return false;
  const payload = reason.payload as { code?: string; operation?: LocalIngestOperation } | null;
  if (payload?.code !== 'LOCAL_INGEST_OPERATION_ACTIVE' || !payload.operation) return false;
  localIngestOperation.value = payload.operation;
  lastActiveOperationKind = payload.operation.kind;
  localIngestOperationLastChecked.value = formatClockTime(new Date());
  localIngestNotice.value = `${reason.message}；页面已恢复服务端操作状态。`;
  scheduleStage3Poll();
  return true;
}

async function completeStage3Refresh(kind: LocalIngestOperation['kind']) {
  if (completionRefreshInFlight) return;
  completionRefreshInFlight = true;
  try {
    await loadLocalIngestDashboard({ selectDefault: true, refreshVisible: true });
    if (kind === 'scan') {
      await loadDownloadTasks();
    } else if (kind === 'batch' || kind === 'single-job' || kind === 'cleanup') {
      await Promise.all([loadDownloadTasks(), loadCatalog({ preserveExpanded: true, refreshExpanded: true })]);
    }
  } finally {
    completionRefreshInFlight = false;
  }
}

async function pollStage3Operation() {
  stage3PollTimer = null;
  if (document.hidden || !stage3OperationActive.value) return;
  const previousKind = localIngestOperation.value?.kind ?? lastActiveOperationKind;
  try {
    const operation = await fetchLocalIngestOperation();
    localIngestOperation.value = operation;
    localIngestOperationLastChecked.value = formatClockTime(new Date());
    if (operation.state !== 'idle') {
      lastActiveOperationKind = operation.kind;
      if (operation.state === 'running' && localIngestCreatorId.value) await loadLocalIngestVisiblePage();
      scheduleStage3Poll();
      return;
    }
    stopStage3Polling();
    if (!localIngestRequestBusy.value && previousKind) await completeStage3Refresh(previousKind);
    lastActiveOperationKind = null;
  } catch (reason) {
    localIngestNotice.value = reason instanceof Error ? `无法刷新 Stage 3 状态：${reason.message}` : '无法刷新 Stage 3 状态';
    scheduleStage3Poll();
  }
}

async function refreshStage3State() {
  refreshingStage3State.value = true;
  try {
    const previousKind = localIngestOperation.value?.state === 'idle'
      ? lastActiveOperationKind
      : localIngestOperation.value?.kind ?? lastActiveOperationKind;
    const operation = await fetchLocalIngestOperation();
    localIngestOperation.value = operation;
    localIngestOperationLastChecked.value = formatClockTime(new Date());
    if (operation.state === 'idle') {
      stopStage3Polling();
      if (previousKind && !localIngestRequestBusy.value) await completeStage3Refresh(previousKind);
      else await loadLocalIngestDashboard({ selectDefault: true, refreshVisible: true });
      lastActiveOperationKind = null;
    } else {
      lastActiveOperationKind = operation.kind;
      if (operation.state === 'running' && localIngestCreatorId.value) await loadLocalIngestVisiblePage();
      scheduleStage3Poll();
    }
  } catch (reason) {
    localIngestNotice.value = reason instanceof Error ? reason.message : '无法刷新 Stage 3 状态';
  } finally {
    refreshingStage3State.value = false;
  }
}

async function settleStage3Request(kind: LocalIngestOperation['kind'], refresh: boolean) {
  try {
    localIngestOperation.value = await fetchLocalIngestOperation();
    localIngestOperationLastChecked.value = formatClockTime(new Date());
  } catch {
    localIngestNotice.value = '操作请求已结束，但暂时无法确认服务端 Stage 3 状态；保持锁定并继续重试。';
    scheduleStage3Poll();
    return;
  }
  if (!stage3OperationActive.value) stopStage3Polling();
  if (refresh) await completeStage3Refresh(kind);
  lastActiveOperationKind = stage3OperationActive.value ? localIngestOperation.value?.kind ?? kind : null;
}

function currentLocalIngestSettings(): LocalIngestSettings {
  if (!localIngestSettings.value) throw new Error('本地入库配置尚未加载');
  return {
    ...localIngestSettings.value,
    allowlist: parseLocalIngestAllowlist(localIngestAllowlistText.value),
    maxExtractionDepth: 2
  };
}

async function discoverLocalIngestInboxCreators() {
  localIngestRequestBusy.value = true;
  localIngestOperation.value = optimisticLocalIngestOperation('running', 'discover-creators', '正在读取待入库博主');
  try {
    localIngestInboxCreators.value = await fetchLocalIngestInboxCreators();
    localIngestNotice.value = '';
  } catch (reason) {
    localIngestInboxCreators.value = null;
    if (!adoptOperationConflict(reason)) localIngestNotice.value = reason instanceof Error ? reason.message : '无法读取待入库博主';
  } finally {
    localIngestRequestBusy.value = false;
    if (!stage3OperationActive.value || localIngestOperation.value?.kind === 'discover-creators') await settleStage3Request('discover-creators', false);
  }
}

function applyDiscoveredInboxCreators(mode: 'append' | 'replace') {
  if (!localIngestInboxCreators.value) return;
  const discovered = localIngestInboxCreators.value.detected
    .map((entry) => entry.canonicalName)
    .filter((name): name is string => Boolean(name));
  const next = mode === 'replace' ? [] : parseLocalIngestAllowlist(localIngestAllowlistText.value);
  const identities = new Set(next.map(normalizeCreatorDraftIdentity));
  for (const name of discovered) {
    const identity = normalizeCreatorDraftIdentity(name);
    if (!identity || identities.has(identity)) continue;
    identities.add(identity);
    next.push(name);
  }
  localIngestAllowlistText.value = next.join('\n');
  localIngestNotice.value = mode === 'replace'
    ? '已用待入库博主替换页面草稿；请确认后点击“保存配置”。'
    : '已将待入库博主追加到页面草稿；请确认后点击“保存配置”。';
}

function cancelInboxCreatorDiscovery() {
  localIngestInboxCreators.value = null;
}

async function saveLocalIngestConfig() {
  localIngestRequestBusy.value = true;
  localIngestOperation.value = optimisticLocalIngestOperation('running', 'save-settings', '正在保存 Stage 3 配置');
  try {
    localIngestSettings.value = await saveLocalIngestSettings(currentLocalIngestSettings());
    localIngestAllowlistText.value = localIngestSettings.value.allowlist.join('\n');
    localIngestNotice.value = '本地入库配置已保存；密码仍只保存在服务端本机环境。';
  } catch (reason) {
    if (!adoptOperationConflict(reason)) localIngestNotice.value = reason instanceof Error ? reason.message : '无法保存本地入库配置';
  } finally {
    localIngestRequestBusy.value = false;
    if (!stage3OperationActive.value || localIngestOperation.value?.kind === 'save-settings') await settleStage3Request('save-settings', false);
  }
}

async function validateLocalIngestConfig() {
  localIngestRequestBusy.value = true;
  localIngestOperation.value = optimisticLocalIngestOperation('running', 'validation', '正在验证 Stage 3 环境');
  try {
    const result = await validateLocalIngestSettings(currentLocalIngestSettings());
    localIngestNotice.value = result.valid
              ? `环境验证通过：${result.sevenZip.version ?? '7-Zip 可用'}，三个目录位于同一卷。`
      : `环境验证未通过：${result.errors.join('；')}`;
  } catch (reason) {
    if (!adoptOperationConflict(reason)) localIngestNotice.value = reason instanceof Error ? reason.message : '无法验证本地入库环境';
  } finally {
    localIngestRequestBusy.value = false;
    if (!stage3OperationActive.value || localIngestOperation.value?.kind === 'validation') await settleStage3Request('validation', false);
  }
}

async function smokeTestRecycleBin() {
  localIngestRequestBusy.value = true;
  localIngestOperation.value = optimisticLocalIngestOperation('running', 'recycle-test', '正在测试 Windows 回收站');
  try {
    const result = await smokeTestLocalIngestRecycleBin();
    localIngestNotice.value = result.recycled ? 'G: 盘回收站测试通过，哨兵文件已移入 Windows 回收站。' : '回收站测试未通过。';
  } catch (reason) {
    if (!adoptOperationConflict(reason)) localIngestNotice.value = reason instanceof Error ? reason.message : '回收站测试失败';
  } finally {
    localIngestRequestBusy.value = false;
    if (!stage3OperationActive.value || localIngestOperation.value?.kind === 'recycle-test') await settleStage3Request('recycle-test', false);
  }
}

async function scanLocalInbox() {
  localIngestRequestBusy.value = true;
  localIngestOperation.value = optimisticLocalIngestOperation('scanning', 'scan', '正在扫描待入库目录');
  startStage3Clock();
  try {
    const result = await scanLocalIngestInbox();
    localIngestNotice.value = `发现 ${result.discoveredCreators} 位博主 / ${result.discoveredArchives} 个压缩包；新增 ${result.createdJobs} 个任务，已有 ${result.existingJobs} 个，等待稳定 ${result.waitingStable} 个，待核查 ${result.awaitingReview} 个；已确认 ${result.reconciledDownloadedTasks} 个本地下载并同步 Stage 2，忽略 ${result.ignoredFiles} 项。`;
    await settleStage3Request('scan', true);
  } catch (reason) {
    if (!adoptOperationConflict(reason)) localIngestNotice.value = reason instanceof Error ? reason.message : '无法扫描待入库目录';
  } finally {
    localIngestRequestBusy.value = false;
    if (localIngestOperation.value?.kind === 'scan' && localIngestOperation.value.state !== 'idle') await settleStage3Request('scan', false);
  }
}

async function runLocalJob(id: number) {
  localIngestRequestBusy.value = true;
  localIngestOperation.value = optimisticLocalIngestOperation('running', 'single-job', '正在运行单项任务');
  scheduleStage3Poll();
  try {
    const result = await runLocalIngestJob(id);
    localIngestNotice.value = `${result.creatorName}/${result.sourceArchiveName}：${localIngestStatusLabel(result.status)}（${result.phase}）`;
    await settleStage3Request('single-job', true);
  } catch (reason) {
    if (!adoptOperationConflict(reason)) localIngestNotice.value = reason instanceof Error ? reason.message : '本地入库任务失败';
  } finally {
    localIngestRequestBusy.value = false;
    if (localIngestOperation.value?.kind === 'single-job' && localIngestOperation.value.state !== 'idle') await settleStage3Request('single-job', false);
  }
}

async function runLocalBatch() {
  localIngestRequestBusy.value = true;
  localIngestOperation.value = optimisticLocalIngestOperation('running', 'batch', '正在启动 Stage 3 批次');
  scheduleStage3Poll();
  try {
    const result = await runLocalIngestBatch();
    localIngestNotice.value = result.total > 0
      ? `本批运行 ${result.total} 个任务：已入库 ${result.ingested}，待核查 ${result.awaitingReview}，失败 ${result.failed}。`
      : '当前没有可运行任务；批次没有扫描待入库目录。';
    await settleStage3Request('batch', true);
  } catch (reason) {
    if (!adoptOperationConflict(reason)) localIngestNotice.value = reason instanceof Error ? reason.message : '无法运行本地入库批处理';
  } finally {
    localIngestRequestBusy.value = false;
    if (localIngestOperation.value?.kind === 'batch' && localIngestOperation.value.state !== 'idle') await settleStage3Request('batch', false);
  }
}

async function retryLocalCleanup(id: number) {
  localIngestRequestBusy.value = true;
  localIngestOperation.value = optimisticLocalIngestOperation('running', 'cleanup', '正在重试回收清理');
  scheduleStage3Poll();
  try {
    await retryLocalIngestCleanup(id);
    localIngestNotice.value = '回收站清理已重试。';
    await settleStage3Request('cleanup', true);
  } catch (reason) {
    if (!adoptOperationConflict(reason)) localIngestNotice.value = reason instanceof Error ? reason.message : '无法重试回收站清理';
  } finally {
    localIngestRequestBusy.value = false;
    if (localIngestOperation.value?.kind === 'cleanup' && localIngestOperation.value.state !== 'idle') await settleStage3Request('cleanup', false);
  }
}

async function toggleLocalIngestCreator(creatorId: number) {
  if (localIngestCreatorId.value === creatorId) {
    localIngestCreatorId.value = null;
    const summaryPayload = await fetchLocalIngestJobs({ page: 1, limit: localIngestJobLimit });
    localIngestDashboard.value = summaryPayload;
    return;
  }
  localIngestCreatorId.value = creatorId;
  localIngestJobPage.value = 1;
  localIngestJobStatus.value = '';
  await loadLocalIngestVisiblePage();
}

async function changeLocalIngestJobFilter() {
  localIngestJobPage.value = 1;
  await loadLocalIngestVisiblePage();
}

async function goToLocalIngestJobPage(nextPage: number) {
  localIngestJobPage.value = nextPage;
  await loadLocalIngestVisiblePage();
}

function handleStage3VisibilityChange() {
  if (document.hidden) {
    if (stage3PollTimer) clearTimeout(stage3PollTimer);
    stage3PollTimer = null;
    if (stage3ClockTimer) clearInterval(stage3ClockTimer);
    stage3ClockTimer = null;
    return;
  }
  if (stage3OperationActive.value) scheduleStage3Poll(0);
}

function preferenceClass(value: ArchiveCatalogPreference | null) {
  if (value === 'liked') return 'bg-red-100 text-red-700';
  if (value === 'kept') return 'bg-amber-100 text-amber-800';
  return 'bg-surface-alt text-muted';
}

function ratingClass(value: ContentRating | null) {
  if (value === 'R18') return 'bg-[#b72d45]';
  if (value === 'R15') return 'bg-[#55718f]';
  return 'bg-[#6b7280]';
}

function statusLabel(creator: ArchiveCatalogCreator) {
  if (creator.unresolvedLocalWorks > 0) return '待核查';
  if (creator.remoteWorks === 0) return '尚未接入资源';
  if (creator.localWorks === 0) return '尚未入库';
  if (creator.missingWorks > 0) return `有 ${creator.missingWorks} 套待收录`;
  return '已完整关联';
}

function deliveryLabel(delivery: ArchiveCatalogCreatorDetail['collections'][number]['deliveries'][number]) {
  const provider = delivery.provider === 'baidu' ? '百度网盘' : delivery.provider;
  return delivery.status ? `${provider}：${delivery.status}` : provider;
}

function downloadStatusLabel(status: ArchiveDownloadTaskStatus) {
  return ({
    pending: '待转存',
    claimed: '插件已领取',
    staged: '网盘已暂存，待本地确认',
    downloading: '插件处理中',
    downloaded: '本地已下载，待入库',
    ingested: '已入库',
    failed: '失败',
    cancelled: '已取消'
  } as const)[status];
}

function metadataStatusLabel(status: ArchiveMetadataTaskStatus) {
  return ({
    pending: '待采集',
    claimed: '插件已领取',
    completed: '已接入',
    not_found: 'Costuan 未收录',
    failed: '失败待重试',
    cancelled: '已取消'
  } as const)[status];
}

async function loadMetadataTasks() {
  metadataTasks.value = await fetchArchiveMetadataTasks({ limit: 100 });
}

async function planMetadata() {
  planningMetadata.value = true;
  metadataNotice.value = '';
  try {
    const result = await planArchiveMetadataTasks(false);
    metadataNotice.value = `检测到 ${result.candidates} 位本地待关联博主；新增 ${result.created} 条、重新排队 ${result.requeued} 条、自动确认 ${result.reconciled} 条。请在 CostuanArchiveManager 中点击“采集待关联博主”。`;
    await loadMetadataTasks();
  } catch (reason) {
    metadataNotice.value = reason instanceof Error ? reason.message : '无法生成博主元数据采集任务';
  } finally {
    planningMetadata.value = false;
  }
}

async function loadDownloadTasks() {
  downloadTasks.value = await fetchArchiveDownloadTasks({ limit: 100 });
}

async function refreshStage2Only() {
  stage2Refreshing.value = true;
  try {
    await loadDownloadTasks();
    downloadNotice.value = 'Stage 2 状态已刷新；未执行任务规划或本地扫描。';
  } catch (reason) {
    downloadNotice.value = reason instanceof Error ? reason.message : '无法刷新 Stage 2 状态';
  } finally {
    stage2Refreshing.value = false;
  }
}

async function planDownloads(creatorId?: number) {
  planningDownloads.value = true;
  downloadNotice.value = '';
  try {
    const result = await planArchiveDownloadTasks(inboxRoot.value, creatorId ? [creatorId] : undefined);
    const cleanupNotice = result.removedOutOfScope > 0 ? `已移除 ${result.removedOutOfScope} 条非本地博主任务；` : '';
    const reconcileNotice = result.reconciledLocal > 0 ? `已将 ${result.reconciledLocal} 条本地已有任务标记为已入库；` : '';
    downloadNotice.value = `${cleanupNotice}${reconcileNotice}已新增 ${result.created} 条任务，已有 ${result.existing} 条；${result.skippedWithoutDelivery} 条因尚无可用百度转存记录而跳过。目标根目录：${result.targetRoot}`;
    await loadDownloadTasks();
  } catch (reason) {
    downloadNotice.value = reason instanceof Error ? reason.message : '无法生成下载任务';
  } finally {
    planningDownloads.value = false;
  }
}

async function rotateBridgeToken() {
  rotatingBridgeToken.value = true;
  downloadNotice.value = '';
  try {
    const result = await rotateArchiveBridgeToken();
    bridgeToken.value = result.token;
    bridgeConfigured.value = true;
    downloadNotice.value = '新密钥已生成；旧密钥立即失效。';
  } catch (reason) {
    downloadNotice.value = reason instanceof Error ? reason.message : '无法生成插件连接密钥';
  } finally {
    rotatingBridgeToken.value = false;
  }
}

async function copyBridgeToken() {
  await navigator.clipboard.writeText(bridgeToken.value);
  downloadNotice.value = '插件连接密钥已复制。';
}

async function loadCatalog(options: { preserveExpanded?: boolean; refreshExpanded?: boolean } = {}) {
  loading.value = true;
  error.value = '';
  const preservedCreatorId = options.preserveExpanded ? expandedCreatorId.value : null;
  if (!options.preserveExpanded) expandedCreatorId.value = null;
  try {
    const payload = await fetchArchiveCatalog({
      page: page.value,
      limit,
      preference: preference.value || undefined,
      rating: rating.value || undefined,
      state: state.value || undefined,
      query: query.value
    });
    items.value = payload.items;
    summary.value = payload.summary;
    total.value = payload.total;
    hasMore.value = payload.hasMore;
    if (preservedCreatorId && options.refreshExpanded) {
      try {
        const detail = await fetchArchiveCatalogCreator(preservedCreatorId);
        details.value = { ...details.value, [preservedCreatorId]: detail };
        delete detailErrors.value[preservedCreatorId];
      } catch (reason) {
        detailErrors.value = {
          ...detailErrors.value,
          [preservedCreatorId]: reason instanceof Error ? reason.message : '无法刷新博主账本详情'
        };
      }
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '无法读取图库账本';
  } finally {
    loading.value = false;
  }
}

async function applyFilters() {
  page.value = 1;
  await loadCatalog();
}

async function resetFilters() {
  query.value = '';
  preference.value = '';
  rating.value = '';
  state.value = '';
  page.value = 1;
  await loadCatalog();
}

async function goToPage(nextPage: number) {
  page.value = nextPage;
  await loadCatalog();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function toggleCreator(creatorId: number) {
  if (expandedCreatorId.value === creatorId) {
    expandedCreatorId.value = null;
    return;
  }
  expandedCreatorId.value = creatorId;
  if (details.value[creatorId]) return;
  detailLoadingId.value = creatorId;
  delete detailErrors.value[creatorId];
  try {
    const detail = await fetchArchiveCatalogCreator(creatorId);
    details.value = { ...details.value, [creatorId]: detail };
  } catch (reason) {
    detailErrors.value = {
      ...detailErrors.value,
      [creatorId]: reason instanceof Error ? reason.message : '无法读取博主账本详情'
    };
  } finally {
    detailLoadingId.value = null;
  }
}

onMounted(async () => {
  try {
    localIngestOperation.value = await fetchLocalIngestOperation();
    localIngestOperationLastChecked.value = formatClockTime(new Date());
    if (stage3OperationActive.value) {
      lastActiveOperationKind = localIngestOperation.value.kind;
      scheduleStage3Poll();
    }
  } catch {
    localIngestOperation.value = null;
  }
  document.addEventListener('visibilitychange', handleStage3VisibilityChange);
  await Promise.all([
    loadCatalog(),
    loadDownloadTasks().catch(() => undefined),
    loadMetadataTasks().catch(() => undefined),
    loadLocalIngest().catch(() => undefined),
    fetchArchiveBridgeStatus().then((result) => { bridgeConfigured.value = result.configured; }).catch(() => undefined)
  ]);
});

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleStage3VisibilityChange);
  stopStage3Polling();
});
</script>

<style scoped>
.catalog-row {
  grid-template-columns: minmax(13rem, 2fr) repeat(4, minmax(4.6rem, 0.55fr)) auto;
}

@media (max-width: 900px) {
  .catalog-row {
    grid-template-columns: repeat(4, minmax(4rem, 1fr));
  }

  .catalog-row > :first-child {
    grid-column: 1 / -1;
  }

  .catalog-row > :last-child {
    grid-column: 1 / -1;
    width: 100%;
  }
}
</style>
