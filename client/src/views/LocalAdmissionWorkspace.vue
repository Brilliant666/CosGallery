<template>
  <main class="admission-workspace">

    <div class="step-navigation"><ol class="steps" aria-label="入库步骤"><li :class="{current:!collection||editingScope}" :aria-current="!collection||editingScope ? 'step' : undefined">1 选择图集</li><li :class="{current:collection?.state==='draft'&&!editingScope}" :aria-current="collection?.state==='draft'&&!editingScope ? 'step' : undefined">2 检查并确认</li><li :class="{current:collection&&collection.state!=='draft'}" :aria-current="collection&&collection.state!=='draft' ? 'step' : undefined">3 入库结果</li></ol><button class="history-toggle" :aria-expanded="showHistory" aria-controls="admission-history" @click="showHistory=!showHistory">{{ showHistory?'收起入库记录':'入库记录' }}</button></div>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="!collection&&attentionCollections.length" class="status-strip" aria-label="待查看的入库批次">
      <strong>已有批次需要查看</strong><button v-for="entry in attentionCollections" :key="entry.id" :disabled="busy" @click="openCollection(entry.id)">{{ entry.batches.map(batch=>batch.creatorName).join('、') }} · {{ stateLabel(entry.state) }}</button>
    </div>
    <p v-if="pending" class="warning receipt-warning" role="status">执行回执尚未确认。原范围与选择已冻结；请在下方“核对并重试原提交”查看原请求，不能另建任务代替。</p>
    <section v-show="showHistory" id="admission-history" class="history panel" aria-label="入库记录">
      <h2>入库记录</h2><p class="hint">重新打开批次，查看后台进度、结果及中断记录；查看记录不会执行入库。</p><p v-if="recentLoading" role="status">读取入库记录…</p><p v-else-if="recentError" class="error">{{ recentError }}</p><p v-else-if="recent&&!recent.items.length">尚无多博主批次；单博主历史记录仍在对应博主的本地导入页。</p><p v-else-if="!recent">入库记录尚未读取。</p>
      <ul><li v-for="entry in recent?.items" :key="entry.id"><button :disabled="busy" @click="openCollection(entry.id)"><strong>{{ entry.batches.map(batch=>batch.creatorName).join('、') }}</strong><small>{{ time(entry.createdAt) }} · {{ entry.totals.total }} 目录 · {{ stateLabel(entry.state) }}</small><small v-if="entry.nextCollectionIds?.length">已有 {{ entry.nextCollectionIds.length }} 份后续预览 · 原记录保留</small><small v-else-if="entry.previousCollectionId">重新检查后的预览</small></button></li></ul>
      <div class="toolbar"><button :disabled="busy||recentLoading" @click="loadRecent(recent?.page??1)">刷新记录</button><button v-if="recent&&recent.page>1" :disabled="recentLoading" @click="loadRecent(recent.page-1)">上一页记录</button><button v-if="recent&&recent.page*recent.pageSize<recent.total" :disabled="recentLoading" @click="loadRecent(recent.page+1)">下一页记录</button></div>
    </section>

    <section v-if="!collection||editingScope" class="panel" aria-label="选择博主与目录">
      <div class="heading"><h2>{{ editingScope?'调整本批导入范围':'选择这次要入库的图集' }}</h2><button :disabled="busy||loading" @click="refreshScope">重新读取等待区</button></div>
      <p v-if="editingScope" class="hint">保留原博主和目录选择。整理后新增的目录需手动勾选；下一步生成新预览，原草稿仍在历史记录中。</p>
      <section class="settings" aria-label="等待区设置与目录规则"><form @submit.prevent="saveSettings"><label>已解压等待区<input v-model="waitingRoot" required /></label><button :disabled="busy">保存等待区</button></form><p v-if="workspace&&!loading&&!workspaceReadError" class="hint">已读取 {{ workspace.items.length }} 个博主目录</p><dl v-if="workspace"><dt>正式图库</dt><dd>{{ workspace.galleryRoot }}</dd></dl><p class="hint">本页只接纳已分套目录；压缩包使用“Costuan入库”。保留原目录名与内部结构，复杂合集先整理边界，不自动拆分或合并。</p></section>
      <template v-if="workspace?.items.length">
        <input v-model="filter" class="filter" type="search" placeholder="筛选等待区名称或已匹配博主" aria-label="筛选等待区博主" />
        <div class="toolbar"><button data-test="select-matched-creators" :disabled="busy||loading" @click="selectMatchedCreators">选择筛选中身份已明确的博主</button><span class="hint">筛选不改变已选范围；此按钮仅补选当前筛选中的明确身份，不替换已有选择。</span></div>
      </template>
      <p v-if="loading" role="status">读取等待区…</p><p v-else-if="workspaceReadError" class="error">等待区读取失败，不能按空目录处理。请核对路径设置后重新读取。</p><p v-else-if="workspace&&!workspace.items.length" class="empty-state">等待区目前没有可列出的博主目录。请先在上述目录中按“博主 / 每套图集”放好并解压文件，再点击“重新读取等待区”。</p><p v-else-if="workspace&&!visibleFolders.length">没有符合当前筛选的目录；清空筛选可查看全部等待区。</p>
      <article v-for="folder in visibleFolders" :key="folder.name" class="folder" :data-folder="folder.name">
        <div class="heading"><label class="check folder-name"><input type="checkbox" :checked="choices[folder.name]?.selected" :disabled="busy||!folder.selectable||!choices[folder.name]?.creator" @change="toggleFolder(folder.name,($event.target as HTMLInputElement).checked)" /><strong>{{ folder.name }}</strong></label><span class="identity">{{ choices[folder.name]?.creator?.name||'需选择规范博主' }}</span></div>
        <p v-if="folder.reason" class="warning">{{ folder.reason }}</p>
        <p class="hint">{{ folder.matches.length===1?(folder.matches[0].matchKind==='alias'?'已登记别名匹配':'规范名称匹配'):folder.matches.length>1?'多个身份候选，需明确选择':'未自动对应，不会创建新博主' }}</p>
        <details :open="!choices[folder.name]?.creator"><summary>{{ choices[folder.name]?.creator?'调整博主身份':'选择博主后才能加入本批' }}</summary><div class="toolbar"><button v-for="match in folder.matches" :key="match.creatorId" :disabled="busy" @click="setCreator(folder.name,{id:match.creatorId,name:match.creatorName,aliases:[]})">{{ match.creatorName }} · {{ match.matchedName }}</button></div><AdmissionCreatorPicker @select="setCreator(folder.name,$event)" /></details>
        <p v-if="!choices[folder.name]?.selected" class="hint">作品范围尚未读取；勾选本行后按需列出目录。</p>
        <template v-if="choices[folder.name]?.selected"><p v-if="choices[folder.name].loading" role="status">读取本博主作品目录…</p><p v-if="choices[folder.name].error" class="error">{{ choices[folder.name].error }}</p>
          <details :open="editingScope||!!choices[folder.name].error"><summary>作品范围 · {{ choices[folder.name].directories.length }} 个目录已选（展开调整）</summary><div class="toolbar"><label class="check"><input type="checkbox" :checked="allSelected(folder.name)" :disabled="busy||choices[folder.name].loading" @change="selectFolderDirectories(folder.name,($event.target as HTMLInputElement).checked)" />选择全部可用作品目录</label><span>{{ choices[folder.name].directories.length }} 个已选</span></div>
          <div class="directory-grid"><label v-for="directory in choices[folder.name].available" :key="directory.name" class="check"><input v-model="choices[folder.name].directories" type="checkbox" :value="directory.name" :disabled="busy||(!directory.selectable&&!choices[folder.name].directories.includes(directory.name))" /><span>{{ directory.name }}<small v-if="directory.reason">{{ directory.reason }}</small></span></label></div>
          </details><AdmissionSourcePicker v-if="choices[folder.name].creator" v-model="choices[folder.name].sourceEvidenceId" :creator-id="choices[folder.name].creator!.id" />
        </template>
      </article>
      <div v-if="workspace?.items.length||chosenFolders.length" class="stage-actions"><div><strong>将检查 {{ chosenFolders.length }} 位博主 · {{ directoryCount }} 个目录</strong><p class="hint">复制 / 解压完成后继续；将盘点文件并保存预览草稿，不执行入库。</p><p v-if="previewBlockReason" id="collection-preview-reason" class="action-reason" role="status">{{ previewBlockReason }}</p></div><div class="toolbar"><button v-if="editingScope" :disabled="busy" @click="cancelScopeEdit">取消调整，返回核对</button><button class="primary" data-test="collection-preview" :disabled="busy||loading||!directoryCount||!!scopeError" aria-describedby="collection-preview-reason" @click="preview">{{ busy?'正在检查所选图集…':'下一步：检查所选图集' }}</button></div></div>
    </section>

    <template v-if="collection&&!editingScope">
      <section class="panel overview" :class="{'draft-overview':collection.state==='draft'}"><div class="heading"><h2>{{ stateLabel(collection.state) }}</h2><span v-if="collection.state==='draft'" class="draft-scope">{{ collection.totals.creators }} 位博主 · {{ collection.totals.total }} 个目录</span><div class="toolbar"><button v-if="collection.state==='draft'" data-test="collection-repreview" :disabled="locked" @click="repreviewFiles">文件有变动？重新检查</button><button v-else :disabled="busy" @click="refreshCollection()">更新进度</button><button v-if="!active&&collection.state!=='draft'" :disabled="busy" @click="startNew">新建批次</button></div></div><p v-if="collection.state!=='draft'">{{ collection.totals.creators }} 位博主 · {{ collection.totals.total }} 个目录 · {{ collection.totals.completed }} 已完成<span v-if="collection.totals.failedCreators"> · {{ collection.totals.failedCreators }} 位需处理</span></p><AdmissionCurrentTotals v-if="collection.state!=='draft'||collection.currentTotals?.completedLater||collection.currentTotals?.unresolved" :totals="collection.currentTotals" /><button v-if="hasLaterCompletion&&collection.state==='draft'" class="toolbar" data-test="view-later-completed" @click="reviewFilter='completed_later';activeBatchId='all';group='all';reviewSearch='';page=1">查看后续已完成项目</button><p v-if="active" role="status">后台按博主串行处理。关闭页面不取消；进度自动更新，不会自动运行其他历史任务。</p><p v-if="collection.error" class="error">{{ collection.error }}</p><details><summary>技术详情</summary><p>{{ collection.id }} · {{ collection.updatedAt }}</p><button v-if="collection.state==='draft'" :disabled="busy" @click="refreshCollection()">读取已保存状态</button></details><div v-if="collection.previousCollectionId||collection.nextCollectionIds?.length" class="toolbar lineage"><button v-if="collection.previousCollectionId" :disabled="busy" @click="openCollection(collection.previousCollectionId)">查看上次预览</button><button v-for="id in collection.nextCollectionIds" :key="id" :disabled="busy" @click="openCollection(id)">查看后续预览 · {{ id.slice(0,8) }}</button><span v-if="collection.nextCollectionIds?.length" class="hint">当前为旧预览；后续预览保留在历史中，不会自动执行。</span></div></section>

      <details v-if="collection.directoryRefresh" class="panel directory-refresh" data-test="directory-refresh">
        <summary>本次目录变化 · 新增 {{ collection.directoryRefresh.added.length }} 个 · 移出 {{ collection.directoryRefresh.removed.length }} 个</summary>
        <p class="hint">重新读取本批已选博主的父目录；“移出”仅表示不再纳入这份新预览，不会删除文件，旧草稿仍保留。新增目录不继承旧合集的作品身份或广告批准，需核对本次选择后确认执行。</p>
        <ul><li v-for="entry in collection.directoryRefresh.added" :key="`add:${entry.creatorId}:${entry.parent}:${entry.name}`">新增：{{ entry.parent }} / {{ entry.name }}</li><li v-for="entry in collection.directoryRefresh.removed" :key="`remove:${entry.creatorId}:${entry.parent}:${entry.name}`">移出：{{ entry.parent }} / {{ entry.name }}</li></ul>
        <p v-for="(warning,index) in collection.directoryRefresh.warnings" :key="index" class="warning">{{ warning }}</p>
      </details>



      <section v-if="collection.state==='draft'" class="panel review-panel" aria-label="多博主集中核对">
        <div class="heading"><h2>先处理需要判断的图集，再查看入库确认</h2><span class="draft-scope">{{ itemsLoading?'读取中':selectedCount }} 已选入库 · {{ itemsLoading?'读取中':deferredCount }} 暂缓 · {{ itemsLoading?'读取中':skippedCount }} 跳过</span></div>

        <div class="review-help"><details class="boundary-help"><summary>文件整理与选择规则</summary><p>正常新作品已按原规则预选；人工暂缓、跳过及广告取消保持。可切到“已选入库”逐项检查。</p><p>在本批已选博主父目录内新增、改名或拆分作品目录后，使用上方“文件有变动？重新检查”。会盘点并保存新预览；新增范围仍须明确核对。更换博主或父目录时选择“上一步：调整导入范围”。原草稿和已确认计划保留。</p><p>边界提示不代表文件损坏。确认整组属于一套，可逐项选择整套接纳；确为多套时先在等待区整理。不覆盖已有作品，也不用改名掩盖冲突。</p><p>未提交选择仅保存在当前浏览器标签页；后台确认与执行记录由服务端保存。</p></details><AdmissionAcquisitionPolicy :retry="!!pending" /></div>
        <section v-if="scopeReviewRows.length&&!pending" class="scope-review warning" aria-label="确认本批目录范围" data-test="scope-review">
          <h3>有 {{ scopeReviewRows.length }} 个目录需要确认属于本批</h3>
          <p>这是范围待确认，不代表文件冲突。旧预览没有记录完整父目录范围，请集中确认以下新发现目录是否属于本次入库。</p>
          <p>{{ scopeReviewSafeCount }} 个无冲突候选可预选 · {{ scopeReviewRows.length-scopeReviewSafeCount }} 个仍需判断作品身份或目录边界。</p>
          <details v-for="entry in scopeReviewGroups" :key="entry.id"><summary>{{ entry.creatorName }} · {{ entry.rows.length }} 个候选目录</summary><ul><li v-for="row in entry.rows" :key="row.item.key">{{ entry.parent }} / {{ row.item.sourceRelativePath }}</li></ul></details>
          <p>不属于本批的目录请先逐项改为跳过；暂不决定的项目可点“本项保留暂缓”。下方按钮只确认仍待核对的范围并更新未提交选择，不执行入库；已作出的人工决定保持。</p>
          <button data-test="scope-review-confirm" :disabled="locked" @click="confirmScopeReview">确认这些目录属于本批，并预选无冲突作品</button>
        </section>
        <AdmissionAdsPicker :entries="allEntries" :locked="locked" :recycle-ads="!pending" @change="invalidateConfirmation" />
        <div class="creator-tabs" role="tablist" aria-label="按博主核对"><button role="tab" :aria-selected="activeBatchId==='all'" @click="activeBatchId='all';page=1">全部博主</button><button v-for="entry in collection.batches" :key="entry.id" role="tab" :aria-selected="activeBatchId===entry.id" @click="activeBatchId=entry.id;page=1">{{ entry.creatorName }} <small>{{ contexts[entry.id]?.items.length??entry.totals.total }} 目录 · {{ pendingFor(entry.id) }} 待处理</small></button></div>
        <div><div class="toolbar review-filters"><label>处理状态<select v-model="reviewFilter" data-test="review-filter"><option value="pending">待处理</option><option value="selected">已选入库</option><option value="skip">跳过</option><option value="completed_later">后续已完成</option><option value="all">全部</option></select></label><label>查看分组<select v-model="group"><option value="all">全部目录</option><option v-for="(name,key) in admissionGroups" :key="key" :value="key">{{ name }}</option></select></label><input v-model="reviewSearch" type="search" aria-label="搜索本批作品或博主" placeholder="作品、原目录或博主名称" /></div><p v-if="itemsLoading" role="status">读取目录摘要…</p>
          <p v-if="!itemsLoading&&!filteredReviewEntries.length" role="status">{{ reviewFilter==='pending'?(hasLaterCompletion?'当前筛选没有待处理项；后续已完成项目可通过上方入口查看，原历史不会再次执行。':'当前范围没有待处理项，可查看已选入库作品后统一确认。'):'没有符合筛选的目录。' }}</p>
          <details v-for="row in visibleReviewEntries" :key="`${row.context.batch.id}:${row.item.key}`" class="review-row" :open="needsAttention(row)">
            <summary><strong>{{ row.context.batch.creatorName }} · {{ row.item.displayTitle }}</strong><span>{{ isAdmissionCompletedLater(row.item)?'后续已完成（原状态保留）':admissionActionLabels[row.context.actions[row.item.key].action] }} · {{ row.item.summary.images }} 图 / {{ row.item.summary.videos }} 视频</span></summary>
            <AdmissionItemEditor v-model="row.context.actions[row.item.key]" :item="row.item" :creator-id="row.context.batch.creatorId" :peers="entriesFor(row.context)" :selected-work="row.context.works[row.item.key]" :locked="locked" :accept-existing-version="acceptsExistingVersion(row.context.batch.id)" :recycle-ads="recyclesAds(row.context.batch.id)" @select-work="row.context.works[row.item.key]=$event" @change="invalidateConfirmation" />
          </details>
          <div class="pagination"><button :disabled="page<=1" @click="page--">上一页目录</button><span>第 {{ page }} / {{ Math.max(1,Math.ceil(filteredReviewEntries.length/20)) }} 页 · {{ filteredReviewEntries.length }} 目录</span><button :disabled="page*20>=filteredReviewEntries.length" @click="page++">下一页目录</button></div>
        </div>

        <div class="stage-actions"><button data-test="collection-edit-scope" :disabled="locked" @click="editScope">上一步：调整导入范围</button><div><strong>{{ itemsLoading?'读取中':selectedCount }} 接纳 · {{ itemsLoading?'读取中':skippedCount }} 跳过 · {{ itemsLoading?'读取中':deferredCount }} 暂缓</strong><p v-if="confirmationBlockReason" id="collection-confirm-reason" class="action-reason" role="status">{{ confirmationBlockReason }}</p></div><button class="primary" data-test="collection-confirm" :disabled="busy||itemsLoading||!allEntries.length||hasLaterCompletion" aria-describedby="collection-confirm-reason" @click="showConfirm=true">{{ pending?'核对并重试原提交':'查看入库确认' }}</button></div>
      </section>

      <section v-else class="panel" aria-label="多博主后台结果">
        <div class="heading"><h2>{{ active?'本批正在后台入库':'本批入库结果' }}</h2><button v-if="allEntries.some(entry=>['completed','skipped','skip'].includes(entry.item.state))" @click="showCompletedResults=!showCompletedResults">{{ showCompletedResults?'收起已完成项目':'查看已完成与跳过项目' }}</button></div>
        <p v-if="active" class="hint">查看当前博主及实际文件阶段即可；离开页面不会取消任务。</p><p v-else class="hint">需要判断的项目直接列在下面；普通已完成项目可按需展开。原状态与后续完成分别保留。</p>
        <article v-for="entry in collection.batches" :key="entry.id" class="result">
          <div class="heading"><h3>{{ entry.creatorName }}</h3><span>{{ batchStateLabel(entry.state) }}</span></div>
          <p>{{ entry.totals.completed }} 已完成 · {{ entry.totals.skipped }} 跳过 · {{ entry.totals.deferred }} 暂缓</p><AdmissionCurrentTotals :totals="entry.currentTotals" />
          <RouterLink v-if="entry.totals.completed" class="primary gallery-link" :to="{name:'canonical-creator',params:{creatorId:entry.creatorId}}">查看本博主图库</RouterLink>
          <p v-if="entry.error" class="error">{{ entry.error }}</p>
          <details :open="resultItems(entry.id).length>0"><summary>目录明细与处理入口 · {{ resultItems(entry.id).length }} 项当前展开范围</summary>
            <ul><li v-for="item in resultItems(entry.id)" :key="item.key">
              <strong>{{ item.sourceRelativePath }}</strong><span>{{ isAdmissionCompletedLater(item)?'原状态：':'' }}{{ itemPhase(item) }}</span>
              <AdmissionCurrentDisposition :disposition="item.currentDisposition" :creator-id="entry.creatorId" /><p v-if="item.lastError" class="error">{{ item.lastError }}</p>
              <RouterLink v-if="!isAdmissionCompletedLater(item)&&item.postId" :to="{name:'canonical-work-gallery',params:{creatorId:entry.creatorId,postId:item.postId}}">查看图集</RouterLink>
              <RouterLink v-if="!isAdmissionCompletedLater(item)&&!active&&entry.planId&&item.nextAction==='review_files'" :to="{name:'local-review',query:{kind:'admission',planId:entry.planId,itemKey:item.key,creatorId:entry.creatorId,collection:collection.id}}">核对文件处置</RouterLink>
              <p v-if="!isAdmissionCompletedLater(item)&&!active&&item.nextActionReason" class="hint">{{ item.nextActionReason }}</p>
              <p v-if="!hasLaterCompletion&&item.nextAction==='resume_plan'&&!active" class="hint">处理原因后，使用下方“核对后继续本批”沿原检查点继续。</p>
            </li></ul>
          </details>
        </article>
        <div v-if="['partial','interrupted'].includes(collection.state)" class="stage-actions"><div><p>{{ hasLaterCompletion?'已有后续完成证据，原集合不能再次继续；其他范围请独立核对。':'先处理上方具体原因，再继续原集合未完成项；已完成的博主不会重跑。' }}</p><p class="hint">尚未移动但源文件已变化的目录，使用“新建批次”按新范围预览，不能修改或重放原确认计划。已经移动的项目按原检查点处理，使用精确审核恢复；两种入口不能互相替代。</p></div><button v-if="!hasLaterCompletion" class="primary" :disabled="busy" @click="showResume=true">核对后继续本批</button></div>
      </section>
      <section v-if="!active&&collection.state!=='draft'" class="panel" aria-label="本批剩余项与目录收尾">
        <h2>后续核对与目录收尾</h2><p v-if="collection.currentTotals">当前仍需核对 {{ collection.currentTotals.pending }} 项</p><p v-else-if="collection.remainingCount!==undefined">尚未执行的暂缓目录 {{ collection.remainingCount }} 项；其他异常以逐项结果为准。</p>
        <p v-if="collection.remainingCount" class="hint">只带入尚未执行的暂缓目录，直接进入后续核对；原确认计划与已完成作品不变。已经移动的异常项仍按原检查点恢复。</p>
        <div class="toolbar"><button v-if="collection.remainingCount" class="primary" data-test="collection-remaining" :disabled="busy||itemsLoading" @click="continueRemaining">继续核对剩余 {{ collection.remainingCount }} 项</button><p v-if="collection.remainingCount&&(busy||itemsLoading)" class="action-reason">正在读取或处理本批，请等待当前请求完成。</p></div>
        <details class="task-tools"><summary>空目录收尾与维护</summary><p class="hint">仅回收本批已清空、没有活动任务的博主父目录，非空目录保留；读取或刷新不执行清理。</p><button data-test="collection-cleanup-parents" :disabled="busy" @click="cleanupParents">清理本批空目录</button></details>
        <p v-if="collection.batches.some(batch=>batch.parentCleanup?.status==='failed')" class="warning">图集入库结果与空目录清理分别记录；下列清理失败不表示已入库作品需要重跑。</p>
        <p v-for="entry in collection.batches.filter(batch=>batch.parentCleanup)" :key="entry.id" :class="entry.parentCleanup?.status==='failed'?'error':'hint'">{{ entry.creatorName }}：{{ entry.parentCleanup?.message }}</p>
      </section>
    </template>

    <div v-if="showConfirm&&collection" class="overlay"><section class="dialog" role="dialog" v-admission-dialog="{ close: () => showConfirm = false, locked: busy }" aria-modal="true" aria-label="确认多博主接纳"><h2>一次确认本批全部范围</h2><p>{{ collection.totals.creators }} 位博主 · {{ selectedCount }} 个接纳目录 · {{ skippedCount }} 跳过 · {{ deferredCount }} 暂缓。</p><div class="confirmation-list"><details v-for="entry in collection.batches" :key="entry.id"><summary><strong>{{ entry.creatorName }}</strong> · {{ batchSummary(entry.id) }}<small>{{ entry.parent }} · 展开核对目录、作品对应和具体广告文件</small></summary><ul><li v-for="pair in contexts[entry.id]?entriesFor(contexts[entry.id]):[]" :key="pair.item.key"><strong>{{ pair.item.sourceRelativePath }}</strong><span>{{ admissionActionLabels[pair.action.action] }}<template v-if="contexts[entry.id].works[pair.item.key]"> → {{ contexts[entry.id].works[pair.item.key].title }}</template><template v-else-if="pair.action.action==='existing'&&pair.action.workId"> → 作品 #{{ pair.action.workId }}（展示资料未缓存）</template><template v-if="pair.action.sameAsKey"> → {{ contexts[entry.id].items.find(item=>item.key===pair.action.sameAsKey)?.sourceRelativePath }}</template></span><small v-if="isAdmissionSelected(pair.action)">{{ pair.item.targetPath }}</small><small v-if="pair.action.primary">使用本目录为主副本，其他副本保留</small><small v-for="ad in pair.action.approvedAds" :key="ad">{{ recyclesAds(entry.id)?'广告送入Windows回收站：':'按原请求移至可恢复附件区：' }}{{ ad }}</small></li></ul></details></div><AdmissionAcquisitionPolicy :retry="!!pending" /><p>跳过 / 暂缓不删除，目标已存在不覆盖。入库完成后，本批已清空且无活动任务的博主父目录送入Windows回收站；非空目录保留。</p><p v-if="selectionError" class="error">{{ selectionError }}</p><p v-if="error" role="alert" class="error">{{ error }}</p><label class="check"><input v-model="confirmed" type="checkbox" />确认上述所有博主、目录及作品选择；当前文件没有继续写入</label><label v-if="adsCount" class="check warning"><input v-model="adsConfirmed" type="checkbox" />另行批准列出的 {{ adsCount }} 个明确广告文件按上述方式处理，其他附件保留</label><p v-if="executeBlockReason" class="action-reason" role="status">{{ executeBlockReason }}</p><div class="dialog-actions"><button :disabled="busy" @click="showConfirm=false">返回核对</button><button class="primary" data-test="collection-execute" :disabled="busy||!confirmed||(adsCount>0&&!adsConfirmed)||!!selectionError" @click="execute">{{ busy?'提交中…':pending?'重试原请求':`确认入库 ${selectedCount} 个目录` }}</button></div></section></div>
    <div v-if="showResume&&collection" class="overlay"><section class="dialog" role="dialog" v-admission-dialog="{ close: () => showResume = false, locked: busy }" aria-modal="true" aria-label="继续多博主原批次"><h2>继续本批未完成项</h2><p>复用已确认计划和检查点，核对实际文件后继续。已完成项不再移动，不自动恢复其他集合或历史任务。</p><div class="dialog-actions"><button :disabled="busy" @click="showResume=false">取消</button><button class="primary" :disabled="busy||hasLaterCompletion" @click="resume">确认继续原批次</button></div></section></div>
  </main>
</template>

<script setup lang="ts">
import { computed,onActivated,onDeactivated,onBeforeUnmount,reactive,ref,watch } from 'vue';
import { RouterLink } from 'vue-router';
import { vAdmissionDialog } from '../utils/admission-dialog';
import { admissionScopeQuery, useAdmissionRoute } from '../utils/admission-route';
import AdmissionCreatorPicker from '../components/AdmissionCreatorPicker.vue';
import AdmissionSourcePicker from '../components/AdmissionSourcePicker.vue';
import AdmissionItemEditor from '../components/AdmissionItemEditor.vue';
import AdmissionAcquisitionPolicy from '../components/AdmissionAcquisitionPolicy.vue';
import AdmissionAdsPicker from '../components/AdmissionAdsPicker.vue';
import AdmissionCurrentDisposition from '../components/AdmissionCurrentDisposition.vue';
import AdmissionCurrentTotals from '../components/AdmissionCurrentTotals.vue';
import * as api from '../api/local-admission';
import { RequestError } from '../api/http';
import { carryRefreshedChoices,clearAdmissionDraft,lastAdmissionCollection,rememberAdmissionCollection,restoreAdmissionDraft,saveAdmissionDraft } from '../utils/admission-navigation';
import { carryRepreviewChoices,type RepreviewEntry } from '../utils/admission-repreview';
import { admissionAction,admissionActionLabels,admissionGroups,admissionPayload,confirmAdmissionScope,isAdmissionCompletedLater,isAdmissionSelected,isAdmissionSafeCandidate,normalizeAdmissionScopeAction,validateAdmissionSelection,type AdmissionEntry } from '../utils/admission-ui';
import type { AdmissionAction,AdmissionBatch,AdmissionCollection,AdmissionCollectionExecuteInput,AdmissionCreator,AdmissionDirectory,AdmissionItem,AdmissionPage,AdmissionPreviewInput,AdmissionWork,AdmissionWorkspace } from '../types/local-admission';

interface FolderChoice {selected:boolean;creator:AdmissionCreator|null;available:AdmissionDirectory[];directories:string[];sourceEvidenceId:number|null;loading:boolean;error:string;request:number}
interface BatchContext {batch:AdmissionCollection['batches'][number];items:AdmissionItem[];actions:Record<string,AdmissionAction>;works:Record<string,AdmissionWork>}
const {route,current:routeCurrent,router}=useAdmissionRoute('local-admission-workspace');
const workspace=ref<AdmissionWorkspace|null>(null),waitingRoot=ref(''),choices=reactive<Record<string,FolderChoice>>({}),filter=ref(''),loading=ref(false),busy=ref(false),itemsLoading=ref(false),error=ref(''),notice=ref('');
const collection=ref<AdmissionCollection|null>(null),contexts=reactive<Record<string,BatchContext>>({}),recent=ref<AdmissionPage<AdmissionCollection>|null>(null),activeBatchId=ref(''),page=ref(1),group=ref('all'),showConfirm=ref(false),confirmed=ref(false),adsConfirmed=ref(false),showResume=ref(false),pending=ref<AdmissionCollectionExecuteInput|null>(null);
const editingScope=ref(false);
const showCompletedResults=ref(false);
const showHistory=ref(false);
const recentLoading=ref(false),recentError=ref(''),workspaceReadError=ref('');let recentRequest=0;
const attentionCollections=computed(()=>recent.value?.items.filter(entry=>['queued','running','interrupted'].includes(entry.state)).slice(0,3)??[]);
const reviewFilter=ref('pending'),reviewSearch=ref('');
let generation=0,disposed=false,startingNew=false,timer:ReturnType<typeof setTimeout>|undefined,pollFailures=0,pageActive=true,wasDeactivated=false;
const active=computed(()=>!!collection.value&&['queued','running'].includes(collection.value.state));
const locked=computed(()=>busy.value||itemsLoading.value||!!pending.value||collection.value?.state!=='draft');
const visibleFolders=computed(()=>workspace.value?.items.filter(folder=>`${folder.name} ${folder.matches.map(match=>match.creatorName).join(' ')}`.toLowerCase().includes(filter.value.trim().toLowerCase()))??[]);
const chosenFolders=computed(()=>Object.entries(choices).filter(([,value])=>value.selected));
const directoryCount=computed(()=>chosenFolders.value.reduce((sum,[,value])=>sum+value.directories.length,0));
const scopeError=computed(()=>{if(chosenFolders.value.length>100)return '每批最多选择100位博主，请分批处理。';const ids=new Set<number>();for(const [name,value] of chosenFolders.value){if(!value.creator)return '请先明确每个目录的规范博主。';if(ids.has(value.creator.id))return `“${value.creator.name}”对应多个等待区父目录，请分批核对；不会自动混合。`;ids.add(value.creator.id);if(value.loading)return '正在读取所选博主的目录。';if(value.error)return '部分目录读取失败，请重新读取或取消该博主。';if(!value.directories.length)return `“${name}”没有选择作品目录，请选择目录或取消勾选该博主。`;if(value.directories.some(directory=>!value.available.some(item=>item.name===directory&&item.selectable)))return `“${name}”仍选有不存在或不可用的目录，请取消后选择整理后的目录。`;}return '';});
const previewBlockReason=computed(()=>busy.value?'正在处理当前请求，请等待结果。':loading.value?'等待区正在读取，请稍候。':scopeError.value||(!chosenFolders.value.length?'尚未选择博主目录。':!directoryCount.value?'尚未选择图集目录，请展开作品范围勾选。':''));
const entriesFor=(context:BatchContext):AdmissionEntry[]=>context.items.map(item=>({item,action:context.actions[item.key]}));
const draftEntries=()=>Object.values(contexts).flatMap(context=>entriesFor(context).map(entry=>({...entry,batchId:context.batch.id,creatorId:context.batch.creatorId,work:context.works[entry.item.key]})));
function saveDraft(){if(collection.value?.state==='draft'&&!pending.value&&!itemsLoading.value)saveAdmissionDraft(collection.value.id,draftEntries());}
const repreviewEntries=():RepreviewEntry[]=>draftEntries().map(entry=>({...entry,parent:contexts[entry.batchId].batch.parent}));
const chosenScopes=():AdmissionPreviewInput[]=>chosenFolders.value.map(([parent,value])=>({creatorId:value.creator!.id,parent,directories:[...value.directories],acceptExistingVersion:true,...(value.sourceEvidenceId?{sourceEvidenceId:value.sourceEvidenceId}:{})}));
const allEntries=computed(()=>collection.value?.batches.flatMap(batch=>contexts[batch.id]?entriesFor(contexts[batch.id]):[])??[]);
const actionableEntries=computed(()=>allEntries.value.filter(entry=>!isAdmissionCompletedLater(entry.item)));
const hasLaterCompletion=computed(()=>!!collection.value?.currentTotals?.completedLater||allEntries.value.some(entry=>isAdmissionCompletedLater(entry.item)));
const selectedCount=computed(()=>actionableEntries.value.filter(entry=>isAdmissionSelected(entry.action)).length),skippedCount=computed(()=>actionableEntries.value.filter(entry=>entry.action.action==='skip').length),deferredCount=computed(()=>actionableEntries.value.filter(entry=>entry.action.action==='defer').length);
const adsCount=computed(()=>actionableEntries.value.reduce((sum,entry)=>sum+(isAdmissionSelected(entry.action)?entry.action.approvedAds?.length??0:0),0));
type ReviewRow={context:BatchContext;item:AdmissionItem};
function needsAttention(row:ReviewRow){if(isAdmissionCompletedLater(row.item))return false;const action=row.context.actions[row.item.key];return row.item.currentDisposition?.status==='unresolved'&&action.selectionOrigin==='automatic'||action.action==='defer'||(action.action==='existing'&&!action.workId)||(action.action==='same-as'&&!entriesFor(row.context).some(peer=>peer.item.key===action.sameAsKey&&['new','existing'].includes(peer.action.action)));}
function batchSummary(id:string){const entries=contexts[id]?entriesFor(contexts[id]).filter(entry=>!isAdmissionCompletedLater(entry.item)):[];return `${entries.filter(entry=>isAdmissionSelected(entry.action)).length} 接纳 · ${entries.filter(entry=>entry.action.action==='skip').length} 跳过 · ${entries.filter(entry=>entry.action.action==='defer').length} 暂缓`;}
function itemPhase(item:AdmissionItem){return ({completed:'完成',skip:'跳过，等待区保留',defer:'暂缓，等待区保留',skipped:'跳过，等待区保留',deferred:'暂缓，等待区保留',not_started:'尚未开始',planned:'已建立计划，尚未移动',move_intent:'移动检查点',files_verified:'文件已核验',indexed:'已索引'} as Record<string,string>)[item.state]??item.state;}
function resultItems(id:string){return (contexts[id]?.items??[]).filter(item=>showCompletedResults.value||!!item.currentDisposition||!!item.lastError||!!(item.nextAction&&item.nextAction!=='none')||!['completed','skipped','skip'].includes(item.state));}
const reviewEntries=computed<ReviewRow[]>(()=>Object.values(contexts).flatMap(context=>context.items.map(item=>({context,item}))));
const scopeReviewRows=computed(()=>reviewEntries.value.filter(row=>!isAdmissionCompletedLater(row.item)&&row.context.actions[row.item.key].selectionOrigin==='scope-review'&&row.context.actions[row.item.key].action==='defer'));
const scopeReviewSafeCount=computed(()=>scopeReviewRows.value.filter(row=>isAdmissionSafeCandidate(row.item)).length);
const scopeReviewGroups=computed(()=>Object.values(contexts).map(context=>({...context.batch,rows:scopeReviewRows.value.filter(row=>row.context.batch.id===context.batch.id)})).filter(entry=>entry.rows.length));
function confirmScopeReview(){
  if(locked.value)return;
  const count=scopeReviewRows.value.length,safe=scopeReviewSafeCount.value;
  for(const row of scopeReviewRows.value)row.context.actions[row.item.key]=confirmAdmissionScope(row.item,row.context.actions[row.item.key]);
  invalidateConfirmation();notice.value=`已确认 ${count} 个目录属于本批，预选 ${safe} 个无冲突作品；其余仍需判断。尚未执行入库。`;
}
function pendingFor(id:string){return reviewEntries.value.filter(row=>row.context.batch.id===id&&needsAttention(row)).length;}
const filteredReviewEntries=computed(()=>reviewEntries.value.filter(row=>{
  const action=row.context.actions[row.item.key],query=reviewSearch.value.trim().toLocaleLowerCase();
  return (activeBatchId.value==='all'||row.context.batch.id===activeBatchId.value)&&(group.value==='all'||row.item.group===group.value)
    &&(reviewFilter.value==='all'||reviewFilter.value==='pending'&&needsAttention(row)||reviewFilter.value==='selected'&&!isAdmissionCompletedLater(row.item)&&isAdmissionSelected(action)||reviewFilter.value==='skip'&&!isAdmissionCompletedLater(row.item)&&action.action==='skip'||reviewFilter.value==='completed_later'&&isAdmissionCompletedLater(row.item))
    &&(!query||`${row.context.batch.creatorName} ${row.item.displayTitle} ${row.item.sourceRelativePath}`.toLocaleLowerCase().includes(query));
}));
const visibleReviewEntries=computed(()=>filteredReviewEntries.value.slice((page.value-1)*20,page.value*20));
function invalidateConfirmation(){confirmed.value=false;adsConfirmed.value=false;saveDraft();}
const selectionError=computed(()=>{if(hasLaterCompletion.value)return '本历史范围已有后续完成项目，不能执行原确认计划；请查看后续结果，其余范围重新核对。';for(const entry of collection.value?.batches??[]){const context=contexts[entry.id];if(!context)return '目录摘要尚未读取完成。';const message=validateAdmissionSelection(entriesFor(context));if(message)return `${entry.creatorName}：${message}`;}return '';});
const confirmationBlockReason=computed(()=>busy.value?'正在处理当前请求。':itemsLoading.value?'正在读取目录摘要，请等待。':hasLaterCompletion.value?'历史范围已有后续完成项目，请查看后续结果，不再执行原计划。':!allEntries.value.length?'当前预览还没有可核对的目录。':'');
const executeBlockReason=computed(()=>busy.value?'正在提交原请求，请等待回执。':selectionError.value||(!confirmed.value?'请先确认本批目录范围与作品选择。':adsCount.value&&!adsConfirmed.value?'请确认上述具体广告文件的处理方式。':''));
const stateLabel=(state:AdmissionCollection['state'])=>({draft:'预览草稿 · 未执行',queued:'等待后台执行',running:'后台处理中',completed:'本批执行已结束 · 请查看结果',partial:'部分完成 · 有项目需处理',interrupted:'中断 · 原批次保留'}[state]);
const batchStateLabel=(state:AdmissionBatch['state'])=>({draft:'待确认',queued:'等待处理',running:'处理中',completed:'完成',needs_review:'需要查看',interrupted:'中断',failed:'失败'}[state]);
const time=(value:string)=>new Date(value).toLocaleString();
const storageKey=(id:string)=>`cosgallery:admission:collection:${id}`;
const definitive=(cause:unknown)=>cause instanceof RequestError&&[400,403,404,409,413,422].includes(cause.status);
function recyclesAds(batchId:string){return pending.value?pending.value.batches.find(entry=>entry.batchId===batchId)?.advertisementDisposition==='recycle_bin':true;}
function acceptsExistingVersion(batchId:string){return pending.value?.batches.find(entry=>entry.batchId===batchId)?.acceptExistingVersion??true;}
function setPending(value:AdmissionCollectionExecuteInput|null){pending.value=value;if(!collection.value)return;try{if(value)localStorage.setItem(storageKey(collection.value.id),JSON.stringify(value));else localStorage.removeItem(storageKey(collection.value.id));}catch{notice.value='浏览器无法保存重试凭据，请保留此页直至确认回执；服务端批次仍会保存。';}}
function restorePending(){if(!collection.value)return;try{const value:unknown=JSON.parse(localStorage.getItem(storageKey(collection.value.id))||'null');if(!value||typeof value!=='object'||!('requestKey'in value)||typeof value.requestKey!=='string'||!('confirmed'in value)||value.confirmed!==true||!('batches'in value)||!Array.isArray(value.batches))return;for(const entry of value.batches){if(!entry||typeof entry!=='object'||typeof entry.batchId!=='string'||!contexts[entry.batchId]||typeof entry.acceptExistingVersion!=='boolean'||!Array.isArray(entry.actions))return;for(const action of entry.actions)if(!action||typeof action!=='object'||typeof action.key!=='string'||!contexts[entry.batchId].actions[action.key]||!['new','existing','same-as','skip','defer'].includes(action.action))return;}const restored=value as AdmissionCollectionExecuteInput;pending.value=restored;for(const entry of restored.batches)for(const action of entry.actions){const context=contexts[entry.batchId];context.actions[action.key]=action;const old=context.works[action.key];delete context.works[action.key];if(action.action==='existing'){const match=old?.workId===action.workId?old:context.items.find(item=>item.key===action.key)?.candidates.find(work=>work.workId===action.workId);if(match)context.works[action.key]=match;}}}catch{/* Local retry data does not authorize server writes. */}}
async function loadWorkspace(){const current=generation;loading.value=true;error.value='';workspaceReadError.value='';try{const result=await api.fetchAdmissionWorkspace();if(current!==generation||disposed)return;workspace.value=result;waitingRoot.value=result.waitingRoot;for(const key of Object.keys(choices))delete choices[key];for(const folder of result.items){const match=folder.matches.length===1?folder.matches[0]:null;choices[folder.name]={selected:false,creator:match?{id:match.creatorId,name:match.creatorName,aliases:[]}:null,available:[],directories:[],sourceEvidenceId:null,loading:false,error:'',request:0};}}catch(cause){if(current===generation){workspaceReadError.value=cause instanceof Error?cause.message:'等待区读取失败';error.value=workspaceReadError.value;}}finally{if(current===generation)loading.value=false;}}
function setCreator(name:string,creator:AdmissionCreator){if(busy.value)return;const choice=choices[name];if(!choice)return;choice.request++;choice.creator=creator;choice.selected=false;choice.directories=[];choice.available=[];choice.sourceEvidenceId=null;choice.loading=false;choice.error='';}
async function selectMatchedCreators(){
  if(busy.value||loading.value)return;
  const current=generation,counts=new Map<number,number>();
  for(const folder of workspace.value?.items??[]){const id=choices[folder.name]?.creator?.id;if(folder.selectable&&id)counts.set(id,(counts.get(id)??0)+1);}
  const selected=new Set(chosenFolders.value.map(([,choice])=>choice.creator!.id));
  const candidates=visibleFolders.value.filter(folder=>{const choice=choices[folder.name];return folder.selectable&&choice?.creator&&!choice.selected&&counts.get(choice.creator.id)===1&&!selected.has(choice.creator.id);});
  const room=Math.max(0,100-chosenFolders.value.length);busy.value=true;
  try{for(const folder of candidates.slice(0,room)){if(current!==generation||disposed)return;await toggleFolder(folder.name,true,true);}if(current===generation)notice.value=`已补选 ${Math.min(room,candidates.length)} 位身份明确的博主；歧义目录和已有选择未改动。${candidates.length>room?'已达每批100位上限，其余请分批。':''}`;}
  finally{if(current===generation)busy.value=false;}
}
async function toggleFolder(name:string,selected:boolean,restoring=false){if(busy.value&&!restoring)return;const choice=choices[name];if(!choice?.creator)return;choice.selected=selected;const request=++choice.request,current=generation;if(!selected){choice.loading=false;return;}choice.loading=true;choice.error='';try{const result=await api.fetchAdmissionDirectories(choice.creator.id,name);if(current!==generation||request!==choice.request||disposed)return;choice.available=result.items;choice.directories=result.items.filter(item=>item.selectable).map(item=>item.name);}catch(cause){if(current===generation&&request===choice.request)choice.error=cause instanceof Error?cause.message:'目录读取失败';}finally{if(current===generation&&request===choice.request)choice.loading=false;}}
function allSelected(name:string){const value=choices[name],available=value?.available.filter(item=>item.selectable)??[];return !!available.length&&available.every(item=>value.directories.includes(item.name));}
function selectFolderDirectories(name:string,selected:boolean){if(busy.value)return;const choice=choices[name];choice.directories=selected?choice.available.filter(item=>item.selectable).map(item=>item.name):[];}
async function saveSettings(){if(busy.value)return;const current=generation;busy.value=true;error.value='';try{await api.saveAdmissionSettings(waitingRoot.value);if(current===generation&&!disposed)await loadWorkspace();}catch(cause){if(current===generation)error.value=cause instanceof Error?cause.message:'设置保存失败';}finally{if(current===generation)busy.value=false;}}
async function loadRecent(page=1){const request=++recentRequest;recentLoading.value=true;recentError.value='';try{const result=await api.fetchAdmissionCollections(page);if(request===recentRequest&&!disposed)recent.value=result;}catch(cause){if(request===recentRequest&&!disposed)recentError.value=cause instanceof Error?cause.message:'入库记录读取失败';}finally{if(request===recentRequest&&!disposed)recentLoading.value=false;}}
async function readItems(batch:AdmissionCollection['batches'][number],current:number){const items:AdmissionItem[]=[];let page=1,total=Infinity;while(items.length<total){const result=await api.fetchAdmissionItems(batch.id,page++,100);if(current!==generation||disposed)return;items.push(...result.items);total=result.total;if(!result.items.length)break;}if(current!==generation||disposed)return;const previous=contexts[batch.id];const context:BatchContext={batch,items,actions:previous?.actions??{},works:previous?.works??{}};for(const item of items){if(context.actions[item.key])continue;const suggested=batch.state==='draft'?item.suggestedAction:undefined,work=suggested?.action==='existing'?item.candidates.find(work=>work.workId===suggested.workId):undefined;context.actions[item.key]=normalizeAdmissionScopeAction(item,suggested&&(suggested.action!=='existing'||work)?{...suggested,key:item.key,selectionOrigin:'manual',approvedAds:[...(suggested.approvedAds??[])],acceptSourceIds:[...(suggested.acceptSourceIds??[])]}:{...admissionAction(item,'defer'),selectionOrigin:'automatic'});if(work)context.works[item.key]=work;}contexts[batch.id]=context;}
async function readAllItems(batches:AdmissionCollection['batches'],current:number){itemsLoading.value=true;try{let index=0;const worker=async()=>{while(index<batches.length&&current===generation&&!disposed){const batch=batches[index++];await readItems(batch,current);}};await Promise.all([worker(),worker()]);}finally{if(current===generation)itemsLoading.value=false;}}
function stopPoll(){if(timer)clearTimeout(timer);timer=undefined;}
function schedulePoll(){stopPoll();if(active.value&&!disposed&&pageActive&&routeCurrent.value&&pollFailures<3&&!document.hidden)timer=setTimeout(()=>void refreshCollection(true),2500);}
async function openCollection(id:string,previous?:RepreviewEntry[]){
  showCompletedResults.value=false;
  saveDraft();const current=++generation;busy.value=false;stopPoll();collection.value=null;editingScope.value=false;pending.value=null;showConfirm.value=false;showResume.value=false;confirmed.value=false;adsConfirmed.value=false;error.value='';notice.value='';page.value=1;group.value='all';reviewFilter.value='pending';reviewSearch.value='';for(const key of Object.keys(contexts))delete contexts[key];
  try {
    const result=await api.fetchAdmissionCollection(id);if(current!==generation||disposed)return;
    collection.value=result;activeBatchId.value='all';
    await readAllItems(result.batches,current);if(current!==generation||disposed)return;
    if(result.state==='draft'){
      const restored=previous?carryRepreviewChoices(previous,repreviewEntries()):restoreAdmissionDraft(id,draftEntries());
      for(const entry of restored){contexts[entry.batchId].actions[entry.key]=entry.action;if(entry.work)contexts[entry.batchId].works[entry.key]=entry.work;}
      restorePending();
      if(!pending.value)selectSafe(new Set(restored.map(entry=>`${entry.batchId}:${entry.key}`)));
    }else {setPending(null);clearAdmissionDraft(id);}
    rememberAdmissionCollection(id);saveDraft();
    await router.replace({query:admissionScopeQuery(route.query,{collection:id}),hash:typeof route.query.collection==='string'&&route.query.collection!==id?'':route.hash});pollFailures=0;schedulePoll();
  }catch(cause){
    if(current!==generation||disposed)return;
    collection.value=null;
    if(cause instanceof RequestError&&[403,404].includes(cause.status)){if(lastAdmissionCollection()===id)rememberAdmissionCollection(null);clearAdmissionDraft(id);}
    await loadWorkspace();if(current===generation&&!disposed)error.value=cause instanceof Error?cause.message:'批次读取失败';
  }
}
async function refreshCollection(poll=false){if(!collection.value)return;saveDraft();const current=generation,id=collection.value.id;try{const result=await api.fetchAdmissionCollection(id);if(current!==generation||disposed)return;saveDraft();const previous=draftEntries();const changed=result.batches.filter(batch=>{const old=contexts[batch.id]?.batch;return !poll||!old||old.state!==batch.state||old.updatedAt!==batch.updatedAt||old.totals.completed!==batch.totals.completed||JSON.stringify(old.currentTotals)!==JSON.stringify(batch.currentTotals);});collection.value=result;if(result.state!=='draft')setPending(null);await readAllItems(changed,current);if(current!==generation||disposed)return;if(result.state==='draft'&&!pending.value){for(const entry of carryRefreshedChoices(previous,draftEntries())){const context=contexts[entry.batchId];context.actions[entry.key]=entry.action;delete context.works[entry.key];if(entry.work)context.works[entry.key]=entry.work;}saveDraft();}pollFailures=0;schedulePoll();}catch(cause){if(current!==generation)return;pollFailures++;if(!poll||pollFailures>=3)error.value=cause instanceof Error?cause.message:'状态读取失败';schedulePoll();}}
async function restoreScope(scopes:AdmissionPreviewInput[],current:number){
  await loadWorkspace();if(current!==generation||disposed)return;
  for(const scope of scopes){
    const entry=collection.value?.batches.find(row=>row.creatorId===scope.creatorId&&row.parent===scope.parent);
    if(!choices[scope.parent]){
      workspace.value?.items.push({name:scope.parent,selectable:true,reason:'原等待区目录已不存在，可取消后选择其他目录。',matches:[]});
      choices[scope.parent]={selected:false,creator:null,available:[],directories:[],sourceEvidenceId:null,loading:false,error:'',request:0};
    }
    const choice=choices[scope.parent];choice.creator={id:scope.creatorId,name:entry?.creatorName??choice.creator?.name??`博主 #${scope.creatorId}`,aliases:[]};choice.selected=true;choice.sourceEvidenceId=scope.sourceEvidenceId??null;
    await toggleFolder(scope.parent,true,true);if(current!==generation||disposed)return;
    choice.directories=[...scope.directories];
    for(const name of scope.directories)if(!choice.available.some(item=>item.name===name))choice.available.push({name,selectable:false,reason:'原目录已不存在，请取消并选择整理后的目录。',matchedCreatorIds:[],matchesSelectedCreator:false});
  }
}
async function editScope(){
  if(locked.value||collection.value?.state!=='draft')return;
  saveDraft();const current=generation,id=collection.value.id;busy.value=true;error.value='';
  try{const result=await api.fetchAdmissionCollectionScope(id);if(current!==generation||disposed)return;await restoreScope(result.scopes,current);if(current===generation&&!disposed)editingScope.value=true;}
  catch(cause){if(current===generation)error.value=cause instanceof Error?cause.message:'原导入范围读取失败';}
  finally{if(current===generation)busy.value=false;}
}
function cancelScopeEdit(){if(!busy.value)editingScope.value=false;}
async function refreshScope(){
  if(busy.value)return;const current=generation,scopes=chosenScopes();busy.value=true;
  try{await restoreScope(scopes,current);}finally{if(current===generation)busy.value=false;}
}
async function preview(){
  if(busy.value||scopeError.value||!directoryCount.value)return;let current=generation;const prior=editingScope.value&&collection.value?.state==='draft'?{id:collection.value.id,entries:repreviewEntries()}:null;
  busy.value=true;error.value='';
  try{const scopes=chosenScopes(),result=prior?await api.repreviewAdmissionCollection(prior.id,scopes):await api.previewAdmissionCollection(scopes);if(current!==generation||disposed)return;
    current++;await openCollection(result.id,prior?.entries);if(current===generation&&!disposed){notice.value=prior?'已生成新预览；依据未变的选择保留，变化项请重新核对。原草稿仍保留。':'';await loadRecent();}}
  catch(cause){if(current===generation&&!disposed)error.value=cause instanceof Error?cause.message:'预览失败';}finally{if(current===generation&&!disposed)busy.value=false;}
}
async function repreviewFiles(){
  if(locked.value||collection.value?.state!=='draft')return;saveDraft();const id=collection.value.id,previous=repreviewEntries();let current=generation;busy.value=true;error.value='';
  try{const result=await api.refreshAdmissionCollectionDirectories(id);if(current!==generation||disposed)return;current++;await openCollection(result.id,previous);
    if(current===generation&&!disposed&&collection.value?.id===result.id){const priorSelected=new Set(previous.filter(row=>isAdmissionSelected(row.action)).map(row=>`${row.creatorId}:${row.parent}:${row.item.sourceRelativePath}`));const selected=repreviewEntries().filter(row=>isAdmissionSelected(row.action)&&!priorSelected.has(`${row.creatorId}:${row.parent}:${row.item.sourceRelativePath}`)).length;const changes=collection.value.directoryRefresh;notice.value=`已重新读取并核对：${changes?`新增目录 ${changes.added.length} 个、移出目录 ${changes.removed.length} 个；`:''}新增选中 ${selected} 个，当前 ${selectedCount.value} 个入库、${deferredCount.value} 个暂缓。依据仍适用的人工决定和已有广告取消保留；新目录请核对后统一确认。`;await loadRecent();}}
  catch(cause){if(current===generation&&!disposed)error.value=cause instanceof Error?cause.message:'重新读取并核对失败';}finally{if(current===generation&&!disposed)busy.value=false;}
}
async function continueRemaining(){
  if(!collection.value||busy.value||active.value||collection.value.state==='draft'||!collection.value.remainingCount)return;
  const id=collection.value.id;let current=generation;busy.value=true;error.value='';
  try{const result=await api.previewRemainingAdmissionCollection(id);if(current!==generation||disposed)return;current++;await openCollection(result.id);
    if(current===generation&&!disposed&&collection.value?.id===result.id){notice.value='已打开剩余项的后续核对草稿。原暂缓选择保留，请核对作品边界后再确认；不会自动执行。';await loadRecent();}}
  catch(cause){if(current===generation&&!disposed)error.value=cause instanceof Error?cause.message:'剩余目录核对暂不可用';}
  finally{if(current===generation&&!disposed)busy.value=false;}
}
async function cleanupParents(){
  if(!collection.value||busy.value||active.value||collection.value.state==='draft')return;
  const current=generation,id=collection.value.id;busy.value=true;error.value='';
  try{const result=await api.cleanupAdmissionCollectionParents(id);if(current!==generation||disposed)return;collection.value=result;notice.value='本批空目录检查完成，请查看各博主的清理结果；非空目录保持。';await loadRecent();}
  catch(cause){if(current===generation&&!disposed)error.value=cause instanceof Error?cause.message:'空目录清理失败';}
  finally{if(current===generation&&!disposed)busy.value=false;}
}
function selectSafe(restored?:Set<string>){
  if(locked.value)return;
  for(const context of Object.values(contexts))for(const item of context.items){
    if(restored&&(restored.has(`${context.batch.id}:${item.key}`)||item.suggestedAction))continue;
    if(isAdmissionSafeCandidate(item)&&context.actions[item.key]?.action==='defer'&&context.actions[item.key]?.selectionOrigin==='automatic')
      context.actions[item.key]={...admissionAction(item,'new',context.actions[item.key]),selectionOrigin:'automatic',reason:'检查后预选无冲突的新作品，待用户最终确认'};
  }
  adsConfirmed.value=false;saveDraft();
}
async function execute(){if(!collection.value||busy.value||selectionError.value)return;saveDraft();const current=generation,id=collection.value.id;busy.value=true;error.value='';try{const input:AdmissionCollectionExecuteInput=pending.value??{requestKey:crypto.randomUUID(),confirmed:true,batches:collection.value.batches.map(batch=>{const entries=entriesFor(contexts[batch.id]);return {batchId:batch.id,acceptExistingVersion:true,advertisementDisposition:'recycle_bin' as const,actions:admissionPayload(entries,true),...(entries.some(entry=>isAdmissionSelected(entry.action)&&entry.action.approvedAds?.length)?{adsConfirmed:true as const}:{})};})};setPending(input);const result=await api.executeAdmissionCollection(id,input);if(current!==generation||disposed)return;collection.value=result;setPending(null);showConfirm.value=false;await readAllItems(result.batches,current);schedulePoll();await loadRecent();}catch(cause){if(current!==generation||disposed)return;error.value=cause instanceof RequestError&&cause.status===413?'本批确认内容超过上限，请分小批；服务端未接受本次执行。':cause instanceof Error?cause.message:'回执未确认';if(definitive(cause))setPending(null);}finally{if(current===generation&&!disposed)busy.value=false;}}
async function resume(){if(!collection.value||busy.value||hasLaterCompletion.value)return;const current=generation,id=collection.value.id,key=`${storageKey(id)}:resume`;busy.value=true;error.value='';let requestKey:string;try{requestKey=localStorage.getItem(key)||crypto.randomUUID();localStorage.setItem(key,requestKey);}catch{requestKey=crypto.randomUUID();}try{const result=await api.resumeAdmissionCollection(id,{requestKey,confirmed:true});try{localStorage.removeItem(key);}catch{/* Server receipt persists. */}if(current!==generation||disposed)return;collection.value=result;showResume.value=false;pollFailures=0;schedulePoll();}catch(cause){if(definitive(cause))try{localStorage.removeItem(key);}catch{/* Rejected receipt is not pending. */}if(current===generation)error.value=cause instanceof Error?cause.message:'继续失败';}finally{if(current===generation&&!disposed)busy.value=false;}}
async function startNew(){
  saveDraft();generation++;stopPoll();rememberAdmissionCollection(null);collection.value=null;editingScope.value=false;pending.value=null;showConfirm.value=false;showResume.value=false;confirmed.value=false;adsConfirmed.value=false;error.value='';startingNew=true;
  for(const key of Object.keys(contexts))delete contexts[key];
  try {await router.replace({query:admissionScopeQuery(route.query),hash:''});await loadWorkspace();}finally{startingNew=false;}
}
function visible(){if(document.hidden)stopPoll();else schedulePoll();}
onDeactivated(()=>{pageActive=false;wasDeactivated=true;saveDraft();stopPoll();});
onActivated(()=>{pageActive=true;if(wasDeactivated&&routeCurrent.value&&collection.value?.state!=='draft'&&!busy.value)void refreshCollection(true);});
watch([group,reviewFilter,reviewSearch],()=>page.value=1);
watch(()=>filteredReviewEntries.value.length,()=>{page.value=Math.min(page.value,Math.max(1,Math.ceil(filteredReviewEntries.value.length/20)));});
watch(()=>route.query.collection,async id=>{
  if(typeof id==='string'){if(id!==collection.value?.id)await openCollection(id);}
  else if(id===undefined){
    if(startingNew)return;
    const remembered=lastAdmissionCollection();
    if(remembered){if(remembered!==collection.value?.id)await openCollection(remembered);else await router.replace({query:admissionScopeQuery(route.query,{collection:remembered}),hash:route.hash});}
    else if(collection.value)await startNew();
    else if(!workspace.value)await loadWorkspace();
  }
},{immediate:true});
void loadRecent();document.addEventListener('visibilitychange',visible);window.addEventListener('pagehide',saveDraft);
onBeforeUnmount(()=>{saveDraft();disposed=true;generation++;stopPoll();document.removeEventListener('visibilitychange',visible);window.removeEventListener('pagehide',saveDraft);});
</script>

<style scoped>
.draft-overview{display:flex;align-items:center;gap:.8rem;flex-wrap:wrap;padding:.6rem 1rem;margin:.5rem 0}.draft-overview>.heading{flex:1;justify-content:flex-start;gap:.8rem}.draft-overview .toolbar{margin:0 0 0 auto}.draft-overview h2{font-size:1rem;margin:0}.draft-scope{font-size:.88rem}.draft-overview>details{font-size:.83rem}.draft-overview>.error,.draft-overview>.lineage,.draft-overview>.current-totals{flex-basis:100%}.review-panel{margin-top:.6rem}.review-help{display:flex;align-items:baseline;gap:.5rem 1.5rem;flex-wrap:wrap;margin:.25rem 0}.review-help>.boundary-help{margin:.25rem 0}.review-filters{margin:.4rem 0!important}.review-filters>label{display:flex;align-items:center;gap:.5rem}.review-filters>input{flex:1;min-width:12rem;max-width:26rem}.review-panel>.creator-tabs{padding:.35rem 0}.review-panel .heading h2{margin:0}.review-help:has(details[open]){align-items:flex-start}@media(max-width:600px){.draft-overview>.heading{flex-basis:100%}.draft-overview .toolbar{margin-left:0}.review-filters>label{flex:1}.review-filters>input{max-width:none;min-width:0;width:100%}}
.hint,.boundary-help p{max-width:85ch}.settings form{max-width:65rem;align-items:flex-end}.settings form label{flex:1;min-width:min(100%,20rem)}.settings form input,.settings form button{box-sizing:border-box;height:2.65rem}.step-navigation{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}.step-navigation .steps{margin:0}.history-toggle{font-size:.85rem}.history.panel{margin:.5rem 0 1rem}
.status-strip,.waiting-location,.selection-summary{display:flex;flex-wrap:wrap;gap:.65rem;align-items:center;margin:.65rem 0}.status-strip{border-left:3px solid var(--accent,#7764b0);padding:.7rem 1rem;background:var(--surface,#fff)}.waiting-location{font-size:.84rem;overflow-wrap:anywhere}.waiting-location small{flex-basis:100%}.selection-summary{font-size:.88rem;border-bottom:1px solid #8882;padding-bottom:.8rem}.action-reason{font-size:.82rem;line-height:1.5;color:var(--muted,#667085);margin:.5rem 0}.empty-state{padding:1rem 0}.boundary-help,.settings,.maintenance{font-size:.83rem;line-height:1.6}.boundary-help{margin:.6rem 0}.receipt-warning{margin:.7rem 0}.stage-actions{scroll-margin-bottom:8rem}.directory-grid>label,.review-row,.result li{scroll-margin-bottom:9rem}.result .primary{display:inline-block;padding:.55rem .8rem;border-radius:.55rem;color:white}.result .hint{max-width:70rem}
.review-row{border-top:1px solid #8883;padding:.7rem 0}.review-row>summary{display:flex;justify-content:space-between;gap:.8rem;flex-wrap:wrap}.review-row>summary span{font-size:.8rem;opacity:.8}.history button{text-align:left}.confirmation-list>details{padding:.7rem 0;border-top:1px solid #8882}
.admission-workspace{width:100%;min-width:0;padding:0 0 2rem;color:var(--text)}header,.heading{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}header{margin-bottom:1.5rem}h1{font-size:1.9rem;margin:.3rem 0}h2{font-size:1.1rem;margin:.3rem 0}h3{font-size:1rem}.eyebrow{font-size:.7rem;letter-spacing:.18em;opacity:.6}header p,.hint{font-size:.83rem;line-height:1.6;opacity:.76}.steps{display:flex;list-style:none;padding:0;gap:1.5rem;flex-wrap:wrap;margin:0 0 1rem}.steps li{padding:.45rem 0;border-bottom:2px solid transparent;font-size:.9rem;color:var(--muted,#667085)}.steps .current{border-bottom-color:var(--accent,#7764b0);color:var(--text,inherit);font-weight:650}.panel{background:var(--surface,#fff);border:1px solid #8883;border-radius:1rem;padding:1.25rem;margin:1rem 0;min-width:0}.history{margin:.5rem 0 1rem;font-size:.88rem}.history>summary{font-weight:600;display:list-item;width:fit-content;padding:.35rem 0}.history[open]{padding:1rem;background:var(--surface,#fff);border:1px solid var(--border,#ddd);border-radius:.85rem}.history ul{max-height:13rem;overflow:auto}.history li{margin:.5rem 0}.settings{margin:1rem 0}.folder,.result{border-top:1px solid #8883;padding:1rem 0}.folder-name{margin:0;font-size:1rem}.identity{font-size:.8rem;border-radius:2rem;background:#8877aa14;padding:.35rem .7rem}.toolbar,.pagination,form{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;margin:.8rem 0}.filter{width:100%;box-sizing:border-box}button,input,select{font:inherit;padding:.55rem .8rem;border:1px solid #8884;border-radius:.55rem;background:var(--bg,#fafafa);color:inherit;max-width:100%}button{cursor:pointer}button:disabled{opacity:.4;cursor:default}.primary{background:var(--accent,#7764b0);color:white;border-color:transparent}label{display:grid;gap:.4rem}.check{display:flex;gap:.6rem;align-items:flex-start;line-height:1.55}.check input{margin-top:.3rem}.directory-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.6rem;padding:.6rem 0}.directory-grid label{font-size:.82rem;overflow-wrap:anywhere}small{font-size:.76rem;opacity:.76;display:block}summary{cursor:pointer}.creator-tabs{display:flex;gap:.5rem;overflow-x:auto;padding:.65rem 0}.creator-tabs button{white-space:nowrap}.creator-tabs button[aria-selected=true]{border-color:var(--accent);background:#8877aa14}.stage-actions{position:sticky;bottom:.6rem;z-index:5;display:flex;justify-content:space-between;align-items:center;gap:1rem;background:var(--surface,#fff);border:1px solid #8883;box-shadow:0 .3rem 1.5rem #0001;padding:.9rem 1rem;border-radius:.8rem;margin-top:1.25rem}.stage-actions strong{font-size:.88rem}.stage-actions label,.stage-actions p{font-size:.78rem;margin:.4rem 0 0}.error{color:#bb2938;white-space:pre-wrap;overflow-wrap:anywhere}.warning{color:#996211;background:#eeaa1110;padding:.6rem;border-radius:.5rem}.result ul,.confirmation-list ul{list-style:none;padding:0}.result li,.confirmation-list li{display:grid;gap:.4rem;padding:.7rem 0;border-top:1px solid #8882;overflow-wrap:anywhere}.result li span{font-size:.8rem}a{color:var(--accent,#7764b0)}.overlay{position:fixed;inset:0;z-index:100;background:#0007;display:flex;align-items:center;justify-content:center;padding:1rem}.dialog{background:var(--surface,#fff);padding:1.5rem;border-radius:1rem;max-width:60rem;width:100%;max-height:90vh;overflow:auto}.confirmation-list{max-height:45vh;overflow:auto}.dialog-actions{display:flex;justify-content:flex-end;gap:.7rem;margin-top:1rem}dl{display:grid;grid-template-columns:6rem 1fr;gap:.4rem;font-size:.8rem}dd{margin:0;overflow-wrap:anywhere}@media(max-width:600px){.admission-workspace{padding:0 0 2rem}.panel{padding:1rem}.stage-actions{align-items:stretch;flex-direction:column}.directory-grid{grid-template-columns:1fr}.steps{gap:.3rem}.steps li{font-size:.75rem;padding:.5rem}.dialog{padding:1rem}}
@media(max-width:767.98px){.stage-actions{bottom:calc(var(--mobile-bottom-nav-height,3.55rem) + .6rem)}}
</style>
