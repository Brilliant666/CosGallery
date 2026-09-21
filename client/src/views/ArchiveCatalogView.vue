<template>
  <section class="mx-auto w-full max-w-[92rem] px-1 pb-12 sm:px-4 lg:px-7">
    <header class="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-muted">CosGallery Catalog</p>
        <h1 class="m-0 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">图库账本</h1>
        <p class="mt-2 mb-0 max-w-2xl text-sm leading-6 text-muted">
          按工作区管理身份、来源、网盘暂存与本地入库。切换和查询只读；执行操作需要明确点击。
        </p>
      </div>
    </header>

    <nav aria-label="账本工作区" class="mb-5 flex flex-wrap gap-2">
      <button v-for="tab in workspaces" :key="tab.id" type="button" :data-test="'workspace-'+tab.id" :aria-pressed="workspace === tab.id" class="rounded-xl border px-5 py-3 text-sm font-semibold" :class="workspace === tab.id ? 'bg-accent text-white border-accent' : 'bg-surface border-border'" @click="workspace = tab.id">{{ tab.label }}</button>
    </nav>

    <div v-if="summary" v-show="workspace === 'roster'" class="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6" aria-label="账本概览">
      <article v-for="card in summaryCards" :key="card.label" class="rounded-2xl border border-border bg-surface p-4 shadow-sm">
        <p class="m-0 text-xs font-semibold text-muted">{{ card.label }}</p>
        <strong class="mt-2 block whitespace-pre-line text-2xl tracking-[-0.04em]">{{ typeof card.value === 'number' ? formatCount(card.value) : card.value }}</strong>
        <small class="mt-1 block whitespace-pre-line text-xs leading-5 text-muted">{{ card.note }}</small>
      </article>
    </div>

    <div v-show="workspace === 'roster'"><ManagedCreatorRoster ref="managedRoster" @changed="loadCatalog()" @source-planned="refreshSourceRegions" @plan-downloads="planCreatorDownloads" @resource-catalog="openResourceCatalog" /></div>
    <ResourceCatalog v-if="workspace === 'resources'" :creator-id="resourceCreatorId" :global-scope="resourceGlobalScope" @select="openResourceCatalog" @all="openAllResources" @back="workspace = 'roster'" />

    <section class="mb-6 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-5" aria-label="博主元数据采集队列" v-show="workspace === 'source'">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p class="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted">Stage 1</p>
          <h2 class="mt-1 mb-0 text-lg font-semibold">来源检查记录</h2>
          <p class="mt-1.5 mb-0 max-w-3xl text-sm leading-6 text-muted">
            从规范博主库明确选择首次收录或增量检查对象，已有来源也可再次检查。复制固定范围到新版插件，读取 Costuan 与百度原分享，仅为本地缺失作品复用或创建任务；不整份转存至 cos图集。刷新账本只读取，不执行来源检查。
          </p>
        </div>
        <div v-if="metadataTasks" class="grid grid-cols-3 gap-2 text-center sm:grid-cols-5">
          <span class="rounded-xl bg-bg px-3 py-2 text-xs"><strong class="block text-base">{{ metadataTasks.summary.sourceCreators }}</strong>有来源的博主</span>
          <span class="rounded-xl bg-bg px-3 py-2 text-xs"><strong class="block text-base">{{ metadataTasks.summary.sourceCollections }}</strong>来源合集</span>
          <span class="rounded-xl bg-bg px-3 py-2 text-xs"><strong class="block text-base">{{ metadataTasks.summary.taskTotal }}</strong>来源检查任务</span>
          <span v-for="status in metadataStatuses" :key="status" class="rounded-xl bg-bg px-3 py-2 text-xs"><strong class="block text-base">{{ metadataTasks.summary.tasks[status] }}</strong>{{ metadataStatusLabel(status) }}</span>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-3">
        <FirstCollectionSelector @planned="refreshSourceRegions" />
        <button type="button" data-test="refresh-stage1" class="h-11 rounded-xl border border-border bg-bg px-4 text-sm disabled:opacity-50" :disabled="sourceRegionsRefreshing" @click="refreshSourceRegions()">刷新账本状态（只读）</button>
        <p class="m-0 text-sm text-muted">此处列出有来源或检查记录的博主，不是全部博主名单。选择与检查需明确操作。</p>
      </div>
      <p v-if="metadataNotice" data-test="metadata-notice" class="mt-3 mb-0 rounded-xl border border-border bg-bg px-3.5 py-3 text-sm text-text">{{ metadataNotice }}</p>
      <SourceReuseReview />

      <p v-if="metadataLoading" role="status" class="mt-3 text-sm text-muted">正在读取来源与检查任务…</p>
      <p v-if="metadataError" role="alert" class="mt-3 text-sm text-red-700">{{ metadataError }}</p>
      <div v-if="metadataTasks?.items.length" class="mt-4 overflow-x-auto rounded-xl border border-border" data-test="metadata-creators">
        <table class="metadata-table w-full min-w-[42rem] border-collapse text-left text-sm">
          <colgroup><col style="width: 18%" /><col style="width: 9%" /><col style="width: 12%" /><col style="width: 36%" /><col style="width: 25%" /></colgroup>
          <thead class="bg-bg text-xs text-muted"><tr><th class="p-3">博主</th><th class="p-3">偏好</th><th class="p-3">本地作品</th><th class="p-3">来源</th><th class="p-3">最近检查</th></tr></thead>
          <tbody>
            <tr v-for="task in metadataTasks.items" :key="task.creatorId" class="border-t border-border">
              <td class="p-3 font-semibold">{{ task.creatorName }}</td>
              <td class="p-3">{{ task.preference === 'liked' ? '喜欢' : task.preference === 'kept' ? '保留' : '未分类' }}</td>
              <td class="p-3">{{ task.localWorks }} 套</td>
              <td class="p-3">
                {{ task.sourceState.metadataAccepted ? '已记录 Costuan 来源' : '尚未取得有效来源' }}
                <template v-if="task.sourceState.metadataAccepted">
                  <small class="block text-muted">{{ task.sourceCollections }} 个有效 Costuan 合集</small>
                  <small class="block text-muted">{{ task.sourceState.deliveryMode === 'direct-share' ? '原分享已核验，暂存进度见 Stage2' : task.sourceState.deliveryReady ? (task.sourceState.deliveryEvidence === 'verified' ? (task.pendingSupplementalTitles?.length ? '编号作品网盘来源已核验' : '网盘来源已核验') : '网盘状态待重新核验') : '网盘来源待确认' }}</small>
                  <small v-if="task.pendingSupplementalTitles?.length" class="block text-muted">{{ task.pendingSupplementalTitles.join('、') }}：附加内容待人工处理，不参与自动下载/入库</small>
                  <details v-if="task.latestSourceAt" class="metadata-details source-details mt-1 text-xs text-muted"><summary class="cursor-pointer">来源详情</summary><span>来源记录时间：{{ formatSourceTime(task.latestSourceAt) }}</span></details>
                </template>
              </td>
              <td class="p-3"><template v-if="task.metadataTask">
                {{ metadataStatusLabel(task.metadataTask.status) }}
                <details class="metadata-details mt-1 text-xs text-muted"><summary class="cursor-pointer">检查详情</summary>
                  <span class="block">任务 #{{ task.metadataTask.id }} · 更新：{{ formatSourceTime(task.metadataTask.updatedAt) }}</span>
                  <span v-if="task.metadataTask.lastError" class="block text-red-700">{{ task.metadataTask.lastError }}</span>
                </details>
              </template><span v-else>无检查记录</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="metadataTasks" class="mt-3 flex items-center justify-between gap-3 text-sm" data-test="metadata-pagination">
        <span>共 {{ metadataTasks.total }} 位 · 第 {{ metadataTasks.page }} / {{ Math.max(1, Math.ceil(metadataTasks.total / metadataTasks.limit)) }} 页</span>
        <div class="flex gap-2"><button type="button" data-test="metadata-prev" :disabled="metadataLoading || metadataTasks.page <= 1" @click="loadMetadataTasks(metadataTasks.page - 1)">上一页</button><button type="button" data-test="metadata-next" :disabled="metadataLoading || !metadataTasks.hasMore" @click="loadMetadataTasks(metadataTasks.page + 1)">下一页</button></div>
      </div>
      <p v-if="metadataTasks && !metadataLoading && !metadataError && !metadataTasks.total" class="mt-3 text-sm text-muted">暂无有效 Costuan 来源或来源检查任务。</p>
    </section>

    <section class="mb-6 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-5" aria-label="缺失作品下载队列" v-show="workspace === 'staging'">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p class="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted">Stage 2</p>
          <h2 class="mt-1 mb-0 text-lg font-semibold">缺失作品下载队列</h2>
          <p class="mt-1.5 mb-0 max-w-3xl text-sm leading-6 text-muted">
            来源检查后，仅为本地缺失的编号作品规划任务。新版插件从原分享精确保存到“我的网盘/cos待入库/规范博主名”，已存在的目标文件复用，再由你手动下载。历史中转任务仍保留；重新检查该博主可取得原分享方式，cos图集 不再是新流程的必需目录。
          </p>
        </div>
      </div>

      <details class="mt-4"><summary class="cursor-pointer font-semibold">暂存设置与高级任务操作</summary>
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

      </details>
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

      <Stage2CreatorQueue ref="stage2Queue" />
    </section>

    <section class="mb-6 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-5" aria-label="本地入库" v-show="workspace === 'ingest'">
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
        <div v-if="localIngestOperation?.run" class="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-11">
          <span><strong class="block text-base">{{ localIngestOperation.run.total }}</strong>本批选中</span>
          <span><strong class="block text-base">{{ localIngestOperation.run.examined }}</strong>实际检查</span>
          <span><strong class="block text-base">{{ localIngestOperation.run.settled }}</strong>已有明确结果</span>
          <span><strong class="block text-base">{{ localIngestOperation.run.ingested }}</strong>已入库</span>
          <span><strong class="block text-base">{{ localIngestOperation.run.failed }}</strong>失败</span>
          <span><strong class="block text-base">{{ localIngestOperation.run.awaitingReview }}</strong>待核查</span>
          <span><strong class="block text-base">{{ localIngestOperation.run.reconciling }}</strong>仍待对账</span>
          <span><strong class="block text-base">{{ localIngestOperation.run.claimUnavailable }}</strong>执行权占用</span>
          <span><strong class="block text-base">{{ localIngestOperation.run.unchanged }}</strong>状态未变化</span>
          <span><strong class="block text-base">{{ localIngestOperation.run.remaining }}</strong>剩余</span>
          <span><strong class="block text-sm">{{ localIngestOperation.run.currentJob?.creatorName ?? '—' }}</strong>{{ localIngestOperation.run.currentJob?.archiveName ?? '等待下一项' }} · {{ localIngestPhaseLabel(localIngestOperation.run.currentJob?.phase) }}</span>
        </div>
        <p v-if="localIngestOperationLastChecked" class="mt-2 mb-0 text-[0.68rem] text-muted">状态读取：{{ localIngestOperationLastChecked }}</p>
      </div>

      <details class="mt-4" data-test="ingest-settings"><summary class="cursor-pointer font-semibold">入库设置与环境工具</summary>
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
        <label class="grid gap-1.5 text-xs font-semibold text-muted">文件稳定秒数
          <input v-model.number="localIngestSettings.fileStableSeconds" data-test="local-ingest-stable-seconds" :disabled="stage3WriteLocked" :title="stage3LockReason" type="number" min="1" max="3600" class="h-11 rounded-xl border border-border bg-bg px-3.5 text-sm text-text disabled:cursor-not-allowed disabled:opacity-60" />
        </label>
        <div class="flex items-end gap-3 pb-2 text-sm">
          <label class="flex items-center gap-2"><input v-model="localIngestSettings.recycleAfterIngest" data-test="local-ingest-recycle" :disabled="stage3WriteLocked" :title="stage3LockReason" type="checkbox" />确认入库后移入回收站</label>
          <span class="text-muted">最大解压深度固定为 2</span>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap gap-2">
        <button type="button" data-test="validate-local-ingest" class="h-10 rounded-xl border border-border bg-bg px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked || !localIngestSettings" :title="stage3LockReason" @click="validateLocalIngestConfig">验证环境</button>
        <button type="button" data-test="smoke-local-ingest-recycle" class="h-10 rounded-xl border border-border bg-bg px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked || !localIngestSettings" :title="stage3LockReason" @click="smokeTestRecycleBin">回收站测试</button>
      </div>
      </details>
      <div class="mt-4" v-if="localIngestSettings">        <div class="grid gap-2">
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
</div>
      <div class="mt-4 flex flex-wrap gap-2">
        <button type="button" data-test="save-local-ingest" class="h-10 rounded-xl border border-border bg-bg px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked || !localIngestSettings" :title="stage3LockReason" @click="saveLocalIngestConfig">保存配置</button>
        <button type="button" data-test="scan-local-ingest" class="h-10 rounded-xl bg-accent px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked || !localIngestSettings || localIngestAllowlistDirty" :title="stage3ActionTitle" @click="scanLocalInbox">扫描待入库</button>
        <button type="button" data-test="run-local-ingest-batch" class="h-10 rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked || !localIngestSettings || localIngestAllowlistDirty" :title="stage3ActionTitle" @click="runLocalBatch()">运行可处理任务</button>
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
            <span><strong class="block text-sm"><span aria-hidden="true">{{ localIngestCreatorId === creator.creatorId ? '▾' : '▸' }}</span> {{ creator.creatorName }} <em v-if="creator.isCurrent" class="not-italic text-blue-700">· 当前处理</em></strong><small class="text-muted">{{ creator.ingested }} / {{ creator.total }} · {{ creator.progressPercent }}%</small></span>
            <span><strong class="block">{{ creator.pending }}</strong>待处理</span><span><strong class="block">{{ creator.running }}</strong>处理中</span><span><strong class="block">{{ creator.ingested }}</strong>已入库</span><span><strong class="block">{{ creator.awaitingReview }}</strong>待核查</span><span><strong class="block">{{ creator.failed }}</strong>失败</span>
          </button>
          <div v-if="localIngestCreatorId === creator.creatorId" class="border-t border-border bg-surface p-3">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div class="flex flex-wrap items-center gap-2">
                <label class="flex items-center gap-2 text-xs font-semibold text-muted">任务状态
                  <select v-model="localIngestJobStatus" data-test="local-ingest-status-filter" class="h-9 rounded-lg border border-border bg-bg px-3 text-xs text-text" @change="changeLocalIngestJobFilter">
                    <option value="">全部</option><option value="pending">待处理</option><option value="running">处理中</option><option value="awaiting_review">待核查</option><option value="failed">失败</option><option value="completed">已完成</option>
                  </select>
                </label>
                <button v-if="creator.pending + creator.failed > 0" type="button" data-test="run-local-ingest-creator" class="h-9 rounded-lg bg-emerald-700 px-3 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked || localIngestAllowlistDirty" :title="stage3ActionTitle" @click="runLocalBatch(creator)">继续该博主待处理（{{ creator.pending + creator.failed }}）</button>
              </div>
              <span class="text-xs text-muted">共 {{ localIngestDashboard.total }} 条 · 第 {{ localIngestDashboard.page }} / {{ localIngestJobTotalPages }} 页</span>
            </div>
            <div v-if="localIngestJobs.length" class="overflow-x-auto rounded-xl border border-border">
              <table class="w-full min-w-[70rem] border-collapse text-left text-sm">
                <thead class="bg-bg text-xs text-muted"><tr><th class="p-3">博主 / 压缩包</th><th class="p-3">映射</th><th class="p-3">状态</th><th class="p-3">校验 / 清理</th><th class="p-3">预览</th><th class="p-3">操作</th></tr></thead>
                <tbody><tr v-for="job in localIngestJobs" :key="job.id" class="border-t border-border align-top">
                  <td class="p-3"><strong>{{ job.creatorName }}</strong><small class="mt-1 block font-mono text-muted">{{ job.sourceArchiveName }} · {{ formatBytes(job.sourceArchiveSize) }}</small></td>
                  <td class="p-3"><span class="font-mono text-xs">source {{ job.sourceWorkId ?? '—' }}</span><small class="mt-1 block text-muted">task {{ job.archiveDownloadTaskId ?? '—' }}</small></td>
                  <td class="p-3"><strong>{{ localIngestStatusLabel(job.status) }}</strong><small class="mt-1 block text-muted">{{ localIngestPhaseLabel(job.phase) }}</small><small v-if="job.errorCode" class="mt-1 block text-red-700">{{ localIngestErrorLabel(job) }}</small><div v-if="job.status === 'awaiting_review'" data-test="local-ingest-review-evidence" class="mt-2 rounded-lg bg-amber-50 p-2 text-xs leading-5 text-amber-900"><strong>人工核查证据</strong><span class="mt-1 block">未知文件：{{ jobSummaryList(job, 'unknownFiles') }}</span><span class="block break-all">处理目录：{{ job.processingPath ?? '未建立' }}</span><span class="block">正式目录：尚未提交</span><span v-if="job.targetPath" class="block break-all">计划路径：{{ job.targetPath }}</span></div></td>
                  <td class="p-3">{{ job.validationStatus }}<small class="mt-1 block text-muted">cleanup: {{ job.cleanupStatus }}</small></td>
                  <td class="p-3 text-xs"><template v-if="job.summary">图片 {{ jobSummaryValue(job, 'imageCount') }} · 视频 {{ jobSummaryValue(job, 'videoCount') }} · 广告 {{ jobSummaryValue(job, 'advertisementFileCount') }}<small class="mt-1 block break-all text-muted">{{ jobSummaryValue(job, 'plannedTargetPath') }}</small><small v-if="Number(job.summary.retainedOriginalCount) > 0" data-test="retained-originals-summary" class="mt-1 block break-all text-amber-800">另保留 {{ jobSummaryValue(job, 'retainedOriginalCount') }} 张原件，暂不支持展示<small class="block">{{ jobSummaryValue(job, 'retainedOriginalDirectory') }}</small></small><details class="mt-2 max-w-[30rem]"><summary class="cursor-pointer font-semibold text-accent">完整入库预览</summary><dl class="mt-2 grid grid-cols-[6rem_minmax(12rem,1fr)] gap-x-2 gap-y-1 break-all leading-5 text-muted"><dt>原始标题</dt><dd>{{ jobSummaryValue(job, 'rawTitle') }}</dd><dt>源压缩包</dt><dd>{{ job.sourceArchivePath }}</dd><dt>SHA-256</dt><dd class="font-mono">{{ job.sourceArchiveSha256 }}</dd><dt>外层格式</dt><dd>{{ jobSummaryValue(job, 'outerFormat') }}</dd><dt>第一层输出</dt><dd>{{ jobSummaryList(job, 'levelOneOutput') }}</dd><dt>内层原名</dt><dd>{{ jobSummaryValue(job, 'innerOriginalName') }}</dd><dt>内层工作名</dt><dd>{{ jobSummaryValue(job, 'innerWorkingName') }}</dd><dt>未知文件</dt><dd>{{ jobSummaryList(job, 'unknownFiles') }}</dd><dt>警告</dt><dd>{{ jobSummaryList(job, 'warnings') }}</dd></dl></details><IngestPerformance :performance="job.summary.performance" /></template><span v-else class="text-muted">尚无预览</span></td>
                  <td class="p-3"><a v-if="job.status === 'awaiting_review'" :href="`/local-review?kind=stage3&jobId=${job.id}&creatorId=${job.creatorId}`" data-test="review-local-ingest-job" class="block rounded-lg border border-border bg-bg px-3 py-2 text-xs font-semibold text-accent">查看并处理</a><button v-else-if="job.status !== 'ingested'" type="button" data-test="run-local-ingest-job" class="rounded-lg border border-border bg-bg px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked" :title="stage3LockReason" @click="runLocalJob(job.id)">继续任务</button><button v-else-if="job.status === 'ingested' && job.cleanupStatus === 'failed'" type="button" data-test="retry-local-ingest-cleanup" class="rounded-lg border border-border bg-bg px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50" :disabled="stage3WriteLocked" :title="stage3LockReason" @click="retryLocalCleanup(job.id)">重试回收</button><span v-else class="text-xs text-muted">—</span></td>
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

  </section>
</template>

<script setup lang="ts">
const workspaces = [
  { id: 'roster', label: '博主库' },
  { id: 'resources', label: '资源目录' },
  { id: 'source', label: '来源检查' },
  { id: 'staging', label: '网盘暂存' },
  { id: 'ingest', label: '本地入库' }
] as const;
type Workspace = typeof workspaces[number]['id'];
const route = useRoute();
const router = useRouter();
const workspace = ref<Workspace>('roster');
const resourceCreatorId = ref<number | null>(null);
const resourceGlobalScope = ref(false);
watch(
  () => route?.query,
  query => {
    const requested = query?.workspace;
    workspace.value = workspaces.some(tab => tab.id === requested)
      ? requested as Workspace
      : 'roster';
    const value = typeof query?.creatorId === 'string' && /^\d+$/.test(query.creatorId) ? Number(query.creatorId) : NaN;
    resourceCreatorId.value = Number.isSafeInteger(value) && value > 0 ? value : null;
    resourceGlobalScope.value = query?.creatorId === undefined && query?.scope === 'all';
  },
  { immediate: true }
);
watch(workspace, value => {
  if (!router || !route || (route.query.workspace ?? 'roster') === value) return;
  void router.push({ query: { ...route.query, workspace: value } });
});
function openResourceCatalog(id: number | null) {
  if (router && route) {
    void router.push({ query: { ...route.query, workspace: 'resources', creatorId: id === null ? undefined : String(id), scope: undefined } });
  } else {
    resourceCreatorId.value = id;
    resourceGlobalScope.value = false;
    workspace.value = 'resources';
  }
}
function openAllResources() {
  if (router && route) void router.push({ query: { ...route.query, workspace: 'resources', creatorId: undefined, scope: 'all' } });
  else { resourceCreatorId.value = null; resourceGlobalScope.value = true; workspace.value = 'resources'; }
}
async function planCreatorDownloads(id:number) { workspace.value='staging'; await planDownloads(id); }
import { useRoute, useRouter } from 'vue-router';
import ResourceCatalog from '../components/ResourceCatalog.vue';
import ManagedCreatorRoster from '../components/ManagedCreatorRoster.vue';
import IngestPerformance from '../components/IngestPerformance.vue';
import FirstCollectionSelector from '../components/FirstCollectionSelector.vue';
import Stage2CreatorQueue from '../components/Stage2CreatorQueue.vue';
import SourceReuseReview from '../components/SourceReuseReview.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import {
  fetchArchiveBridgeStatus,
  fetchArchiveCatalog,
  planArchiveDownloadTasks,
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
  ArchiveCatalogSummary,
  ArchiveMetadataTaskStatus,
  LocalIngestInboxCreatorsResult,
  LocalIngestCreatorJobSummary,
  LocalIngestJob,
  LocalIngestJobFilter,
  LocalIngestJobsDashboard,
  LocalIngestOperation,
  LocalIngestSettings
} from '../types/api';
import { RequestError } from '../api/http';
import { fetchMetadataCreators, type MetadataCreatorPage } from '../api/creator-sync';

const summary = ref<ArchiveCatalogSummary | null>(null);
const managedRoster = ref<InstanceType<typeof ManagedCreatorRoster> | null>(null);
const inboxRoot = ref('G:\\cos待入库');
const stage2Queue = ref<InstanceType<typeof Stage2CreatorQueue> | null>(null);
const planningDownloads = ref(false);
const stage2Refreshing = ref(false);
const downloadNotice = ref('');
const bridgeConfigured = ref(false);
const bridgeToken = ref('');
const rotatingBridgeToken = ref(false);
const metadataTasks = ref<MetadataCreatorPage | null>(null);
const metadataLoading = ref(false);
const metadataError = ref('');
const metadataStatuses: ArchiveMetadataTaskStatus[] = ['pending', 'claimed', 'completed', 'not_found', 'failed', 'cancelled'];
let metadataLoadGeneration = 0;
const metadataNotice = ref('');
const sourceRegionsRefreshing = ref(false);
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
let localIngestLoadGeneration = 0;
let viewDisposed = false;

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
  if (operation?.state === 'running' && operation.kind === 'batch') return `正在检查 ${operation.run?.examined ?? 0} / ${operation.run?.total ?? 0}`;
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

const summaryCards = computed(() => summary.value ? [
  { label: '全库博主', value: summary.value.creators, note: `喜欢 ${summary.value.liked}\n保留 ${summary.value.kept}\n未设置 ${summary.value.unsetPreference}` },
  { label: '内容分级', value: `R15 ${summary.value.r15}\nR18 ${summary.value.r18}`, note: `待分类 ${summary.value.unclassified}` },
  { label: '有来源的博主', value: summary.value.creatorsWithSources, note: `${summary.value.sourceCollections} 个资源合集` },
  { label: '平台作品', value: summary.value.remoteWorks, note: '当前资源平台已记录' },
  { label: '本地作品', value: summary.value.localWorks, note: `${summary.value.matchedWorks} 套已关联\n有本地作品 ${summary.value.creatorsWithLocalWorks} 位\n无本地作品 ${summary.value.creatorsWithoutLocalWorks} 位\n未关联目录 ${summary.value.unlinkedLocalFolders}` },
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
  const generation = ++localIngestLoadGeneration;
  const creatorId = localIngestCreatorId.value;
  const status = localIngestJobStatus.value;
  const page = localIngestJobPage.value;
  const isCurrent = () => !viewDisposed && generation === localIngestLoadGeneration
    && creatorId === localIngestCreatorId.value && status === localIngestJobStatus.value;
  const query = creatorId === null
    ? { page: 1, limit: localIngestJobLimit }
    : { creatorId, status: status || undefined, page, limit: localIngestJobLimit };
  let payload = await fetchLocalIngestJobs(query);
  if (!isCurrent()) return;
  if (creatorId !== null && !payload.creators.some((creator) => creator.creatorId === creatorId)) {
    localIngestCreatorId.value = null;
    localIngestJobPage.value = 1;
    localIngestDashboard.value = { ...payload, items: [], total: 0, page: 1 };
    return;
  }
  const finalPage = Math.max(1, Math.ceil(payload.total / localIngestJobLimit));
  if (creatorId !== null && page > finalPage) {
    payload = await fetchLocalIngestJobs({
      creatorId,
      status: status || undefined,
      page: finalPage,
      limit: localIngestJobLimit
    });
    if (!isCurrent()) return;
    localIngestJobPage.value = finalPage;
  }
  localIngestDashboard.value = creatorId === null ? { ...payload, items: [] } : payload;
}

async function loadLocalIngestDashboard() {
  // null is an explicit all-collapsed selection, including the initial visit.
  await loadLocalIngestVisiblePage();
}

async function loadLocalIngest() {
  const settings = await fetchLocalIngestSettings();
  localIngestSettings.value = settings;
  localIngestAllowlistText.value = settings.allowlist.join('\n');
  await loadLocalIngestDashboard();
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
    run: kind === 'batch' ? {
      total: 0,
      examined: 0,
      settled: 0,
      ingested: 0,
      failed: 0,
      awaitingReview: 0,
      reconciling: 0,
      claimUnavailable: 0,
      unchanged: 0,
      remaining: 0,
      currentJob: null
    } : null,
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
    await loadLocalIngestDashboard();
    if (kind === 'scan') {
      await loadDownloadTasks();
    } else if (kind === 'batch' || kind === 'single-job' || kind === 'cleanup') {
      await Promise.all([loadDownloadTasks(), loadCatalog(), managedRoster.value?.refresh?.()]);
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
      if (operation.state === 'running') await loadLocalIngestVisiblePage();
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
      else await loadLocalIngestDashboard();
      lastActiveOperationKind = null;
    } else {
      lastActiveOperationKind = operation.kind;
      if (operation.state === 'running') await loadLocalIngestVisiblePage();
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

async function runLocalBatch(creator?: LocalIngestCreatorJobSummary) {
  const creatorId = creator?.creatorId;
  const expectedCount = creator ? creator.pending + creator.failed : 0;
  localIngestRequestBusy.value = true;
  localIngestOperation.value = optimisticLocalIngestOperation(
    'running',
    'batch',
    creator ? `正在启动 ${creator.creatorName} 的 ${expectedCount} 项 Stage 3 继续任务` : '正在启动 Stage 3 批次'
  );
  scheduleStage3Poll();
  try {
    const result = await runLocalIngestBatch(creatorId ? { creatorIds: [creatorId] } : {});
    const scope = creator ? `${creator.creatorName}：` : '';
    localIngestNotice.value = result.total > 0
      ? `${scope}本批选中 ${result.total} 个任务，实际检查 ${result.examined} 个：已入库 ${result.ingested}，待核查 ${result.awaitingReview}，失败 ${result.failed}，仍待对账 ${result.reconciling}，执行权被占用 ${result.claimUnavailable}，状态未变化 ${result.unchanged}。`
      : `${scope}当前没有可运行任务；批次没有扫描待入库目录。`;
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
    if (localIngestDashboard.value) localIngestDashboard.value = { ...localIngestDashboard.value, items: [] };
    await loadLocalIngestVisiblePage();
    return;
  }
  localIngestCreatorId.value = creatorId;
  if (localIngestDashboard.value) localIngestDashboard.value = { ...localIngestDashboard.value, items: [] };
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

function handleSourceVisibilityChange() {
  if (!document.hidden) void refreshSourceRegions();
}

function handlePluginStateMessage(event: MessageEvent) {
  if (document.hidden || event.source !== window || event.origin !== window.location.origin) return;
  if (event.data?.source === 'costuan-archive-manager' && event.data?.type === 'cosgallery:archive-state-changed') {
    void refreshSourceRegions();
  }
}

async function refreshSourceRegions(_creatorIds?: number[]) {
  if (sourceRegionsRefreshing.value) return;
  sourceRegionsRefreshing.value = true;
  try {
    await Promise.all([loadMetadataTasks(), loadDownloadTasks()]);
    metadataNotice.value = 'Stage 1/2 状态已读取；未执行任务规划、转存或扫描。';
  } catch (reason) {
    metadataNotice.value = reason instanceof Error ? reason.message : '无法刷新来源状态';
  } finally { sourceRegionsRefreshing.value = false; }
}

function formatSourceTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间待确认' : date.toLocaleString('zh-CN', { hour12: false });
}

function metadataStatusLabel(status: ArchiveMetadataTaskStatus) {
  return ({
    pending: '待采集',
    claimed: '插件已领取',
    completed: '检查已完成',
    not_found: '上次检查未找到合集',
    failed: '失败待重试',
    cancelled: '已取消'
  } as const)[status];
}

async function loadMetadataTasks(requestedPage = metadataTasks.value?.page ?? 1) {
  const generation = ++metadataLoadGeneration;
  metadataLoading.value = true;
  metadataError.value = '';
  try {
    let payload = await fetchMetadataCreators({ page: requestedPage, limit: 20, enabled: 'all' });
    if (viewDisposed || generation !== metadataLoadGeneration) return;
    const lastPage = Math.max(1, Math.ceil(payload.total / payload.limit));
    if (requestedPage > lastPage) payload = await fetchMetadataCreators({ page: lastPage, limit: 20, enabled: 'all' });
    if (!viewDisposed && generation === metadataLoadGeneration) metadataTasks.value = payload;
  } catch (cause) {
    if (!viewDisposed && generation === metadataLoadGeneration) metadataError.value = cause instanceof Error ? cause.message : '来源列表读取失败，请重试。';
  } finally {
    if (!viewDisposed && generation === metadataLoadGeneration) metadataLoading.value = false;
  }
}

async function loadDownloadTasks() {
  await stage2Queue.value?.refresh();
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

async function loadCatalog() {
  try { summary.value = (await fetchArchiveCatalog({page:1,limit:1})).summary; }
  catch { /* The roster owns its own visible loading/error state. */ }
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
  document.addEventListener('visibilitychange', handleSourceVisibilityChange);
  window.addEventListener('message', handlePluginStateMessage);
  await Promise.all([
    loadCatalog(),
    loadDownloadTasks().catch(() => undefined),
    loadMetadataTasks().catch(() => undefined),
    loadLocalIngest().catch(() => undefined),
    fetchArchiveBridgeStatus().then((result) => { bridgeConfigured.value = result.configured; }).catch(() => undefined)
  ]);
});

onBeforeUnmount(() => {
  metadataLoadGeneration += 1;
  viewDisposed = true;
  localIngestLoadGeneration++;
  document.removeEventListener('visibilitychange', handleStage3VisibilityChange);
  document.removeEventListener('visibilitychange', handleSourceVisibilityChange);
  window.removeEventListener('message', handlePluginStateMessage);
  stopStage3Polling();
});
</script>

<style scoped>
.metadata-table {
  table-layout: fixed;
}

.metadata-table th,
.metadata-table td {
  vertical-align: top;
  overflow-wrap: anywhere;
}

.metadata-details {
  /* Summary plus two reserved detail lines; longer content remains unconstrained. */
  line-height: 1rem;
  min-height: 3rem;
}

.source-details {
  /* Source details reserve one line below the summary instead of two. */
  min-height: 2rem;
}

</style>
