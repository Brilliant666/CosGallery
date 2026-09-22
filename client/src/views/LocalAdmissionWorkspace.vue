<template>
  <main class="admission-workspace">
    <header><div><p class="eyebrow">LOCAL ADMISSION</p><h1>本地入库</h1><p>从等待区选择多位博主，集中核对一次，后台依次接纳。</p></div><RouterLink to="/archive-catalog">博主库</RouterLink></header>
    <ol class="steps" aria-label="入库步骤"><li :class="{current:!collection||editingScope}">1 选择博主与目录</li><li :class="{current:collection?.state==='draft'&&!editingScope}">2 集中核对</li><li :class="{current:collection&&collection.state!=='draft'}">3 后台结果</li></ol>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <details class="panel history"><summary>最近批次与历史记录</summary><p v-if="!recent?.items.length">尚无多博主批次；单博主历史记录仍在对应博主的本地导入页。</p><ul><li v-for="entry in recent?.items" :key="entry.id"><button :disabled="busy" @click="openCollection(entry.id)"><strong>{{ entry.batches.map(batch=>batch.creatorName).join('、') }}</strong><small>{{ time(entry.createdAt) }} · {{ entry.totals.total }} 目录 · {{ stateLabel(entry.state) }} · {{ entry.id.slice(0,8) }}</small><small v-if="entry.nextCollectionIds?.length">已有 {{ entry.nextCollectionIds.length }} 份后续预览 · 原记录保留</small><small v-else-if="entry.previousCollectionId">重新检查后的预览</small></button></li></ul><div class="toolbar"><button :disabled="busy" @click="loadRecent(recent?.page??1)">刷新记录</button><button v-if="recent&&recent.page>1" :disabled="busy" @click="loadRecent(recent.page-1)">上一页记录</button><button v-if="recent&&recent.page*recent.pageSize<recent.total" :disabled="busy" @click="loadRecent(recent.page+1)">下一页记录</button></div></details>

    <section v-if="!collection||editingScope" class="panel" aria-label="选择博主与目录">
      <div class="heading"><h2>{{ editingScope?'调整本批导入范围':'选择这次要收录的范围' }}</h2><button :disabled="busy||loading" @click="refreshScope">重新读取等待区</button></div>
      <p v-if="editingScope" class="hint">保留原博主和目录选择。整理后新增的目录需手动勾选；下一步生成新预览，原草稿仍在历史记录中。</p>
      <p class="hint">这里只列等待区，按选择的作品目录保留原名与内部结构。合集、按月份或类型分层等复杂目录先核对作品边界，不自动拆分或合并。</p>
      <details class="settings"><summary>路径与高级设置</summary><dl v-if="workspace"><dt>等待区</dt><dd>{{ workspace.waitingRoot||'未设置' }}</dd><dt>正式图库</dt><dd>{{ workspace.galleryRoot }}</dd></dl><form @submit.prevent="saveSettings"><label>已解压等待区<input v-model="waitingRoot" required /></label><button :disabled="busy">保存等待区</button></form><p class="hint">压缩包仍使用 Stage3；本页只接纳已分套的目录。</p></details>
      <input v-model="filter" class="filter" type="search" placeholder="筛选等待区名称或已匹配博主" aria-label="筛选等待区博主" />
      <div class="toolbar"><button data-test="select-matched-creators" :disabled="busy||loading" @click="selectMatchedCreators">选择筛选中身份已明确的博主</button><span class="hint">不替换已有选择；同一博主的多个父目录需单独判断。</span></div>
      <p v-if="loading" role="status">读取等待区…</p><p v-else-if="!visibleFolders.length">当前没有匹配的等待区目录。</p>
      <article v-for="folder in visibleFolders" :key="folder.name" class="folder" :data-folder="folder.name">
        <div class="heading"><label class="check folder-name"><input type="checkbox" :checked="choices[folder.name]?.selected" :disabled="busy||!folder.selectable||!choices[folder.name]?.creator" @change="toggleFolder(folder.name,($event.target as HTMLInputElement).checked)" /><strong>{{ folder.name }}</strong></label><span class="identity">{{ choices[folder.name]?.creator?.name||'需选择规范博主' }}</span></div>
        <p v-if="folder.reason" class="warning">{{ folder.reason }}</p>
        <p class="hint">{{ folder.matches.length===1?(folder.matches[0].matchKind==='alias'?'已登记别名匹配':'规范名称匹配'):folder.matches.length>1?'多个身份候选，需明确选择':'未自动对应，不会创建新博主' }}</p>
        <details :open="!choices[folder.name]?.creator"><summary>核对 / 更换博主身份</summary><div class="toolbar"><button v-for="match in folder.matches" :key="match.creatorId" :disabled="busy" @click="setCreator(folder.name,{id:match.creatorId,name:match.creatorName,aliases:[]})">{{ match.creatorName }} · {{ match.matchedName }}</button></div><AdmissionCreatorPicker @select="setCreator(folder.name,$event)" /></details>
        <template v-if="choices[folder.name]?.selected"><p v-if="choices[folder.name].loading" role="status">读取本博主作品目录…</p><p v-if="choices[folder.name].error" class="error">{{ choices[folder.name].error }}</p>
          <details :open="editingScope||!!choices[folder.name].error"><summary>作品范围 · {{ choices[folder.name].directories.length }} 个目录已选（展开调整）</summary><div class="toolbar"><label class="check"><input type="checkbox" :checked="allSelected(folder.name)" :disabled="busy||choices[folder.name].loading" @change="selectFolderDirectories(folder.name,($event.target as HTMLInputElement).checked)" />选择全部可用作品目录</label><span>{{ choices[folder.name].directories.length }} 个已选</span></div>
          <div class="directory-grid"><label v-for="directory in choices[folder.name].available" :key="directory.name" class="check"><input v-model="choices[folder.name].directories" type="checkbox" :value="directory.name" :disabled="busy||(!directory.selectable&&!choices[folder.name].directories.includes(directory.name))" /><span>{{ directory.name }}<small v-if="directory.reason">{{ directory.reason }}</small></span></label></div>
          </details><AdmissionSourcePicker v-if="choices[folder.name].creator" v-model="choices[folder.name].sourceEvidenceId" :creator-id="choices[folder.name].creator!.id" />
        </template>
      </article>
      <div class="stage-actions"><div><strong>{{ chosenFolders.length }} 位博主 · {{ directoryCount }} 个目录</strong><p class="hint">复制 / 解压完成后再进入核对；此步只生成预览，不移动文件。</p></div><div class="toolbar"><button v-if="editingScope" :disabled="busy" @click="cancelScopeEdit">取消调整，返回核对</button><button class="primary" data-test="collection-preview" :disabled="busy||!directoryCount||!!scopeError" @click="preview">{{ busy?'生成预览中…':'下一步 · 集中核对' }}</button></div></div><p v-if="scopeError" class="error">{{ scopeError }}</p>
    </section>

    <template v-if="collection&&!editingScope">
      <section class="panel overview"><div class="heading"><h2>{{ stateLabel(collection.state) }}</h2><div class="toolbar"><button v-if="collection.state==='draft'" data-test="collection-repreview" :disabled="locked" @click="repreviewFiles">重新检查并更新选择</button><button v-else :disabled="busy" @click="refreshCollection()">更新进度</button><button v-if="!active&&collection.state!=='draft'" :disabled="busy" @click="startNew">新建批次</button></div></div><p>{{ collection.totals.creators }} 位博主 · {{ collection.totals.total }} 个目录 · {{ collection.totals.completed }} 已完成<span v-if="collection.totals.failedCreators"> · {{ collection.totals.failedCreators }} 位需处理</span></p><p v-if="active" role="status">后台按博主串行处理。关闭页面不取消；进度自动更新，不会自动运行其他历史任务。</p><p v-if="collection.error" class="error">{{ collection.error }}</p><details><summary>技术详情</summary><p>{{ collection.id }} · {{ collection.updatedAt }}</p><button v-if="collection.state==='draft'" :disabled="busy" @click="refreshCollection()">读取已保存状态</button></details><div v-if="collection.previousCollectionId||collection.nextCollectionIds?.length" class="toolbar lineage"><button v-if="collection.previousCollectionId" :disabled="busy" @click="openCollection(collection.previousCollectionId)">查看上次预览</button><button v-for="id in collection.nextCollectionIds" :key="id" :disabled="busy" @click="openCollection(id)">查看后续预览 · {{ id.slice(0,8) }}</button><span v-if="collection.nextCollectionIds?.length" class="hint">当前为旧预览；后续预览保留在历史中，不会自动执行。</span></div></section>

      <section v-if="!active&&collection.state!=='draft'" class="panel" aria-label="本批剩余项与目录收尾">
        <h2>已入库 {{ collection.totals.completed }} 项 · 待核查 {{ collection.remainingCount??collection.totals.deferred }} 项</h2>
        <p v-if="collection.remainingCount" class="hint">只带入尚未执行的暂缓目录，直接进入后续核对；原确认计划与已完成作品不变。已经移动的异常项仍按原检查点恢复。</p>
        <div class="toolbar"><button v-if="collection.remainingCount" class="primary" data-test="collection-remaining" :disabled="busy||itemsLoading" @click="continueRemaining">继续核对剩余 {{ collection.remainingCount }} 项</button><button data-test="collection-cleanup-parents" :disabled="busy" @click="cleanupParents">清理本批空目录</button></div>
        <p class="hint">入库完成后仅回收已清空、没有活动任务的博主父目录，非空目录保留。历史残留需点击“清理本批空目录”送入Windows回收站；读取或刷新不会触发清理。</p>
        <p v-for="entry in collection.batches.filter(batch=>batch.parentCleanup)" :key="entry.id" :class="entry.parentCleanup?.status==='failed'?'error':'hint'">{{ entry.creatorName }}：{{ entry.parentCleanup?.message }}</p>
      </section>

      <section v-if="collection.state==='draft'" class="panel" aria-label="多博主集中核对">
        <div class="heading"><div><h2>核对作品身份与文件范围</h2><p class="hint">无冲突的新作品自动选中。优先处理下面的待判断项；人工暂缓和跳过保留，预选不等于执行。</p></div></div>
        <p class="hint">整理所选目录内的文件后，点击“重新检查并更新选择”；新增、改名或拆分作品目录，先用“上一步：调整导入范围”。旧草稿未记录选择来源的项目不会被擅自补选。</p>
        <p class="hint">未提交选择仅保存在当前浏览器标签页，刷新或同页返回可恢复；换浏览器或关闭标签页后不保证保留。后台确认与执行记录由服务端保存。</p>
        <details class="boundary-help"><summary>冲突 / 需整理的目录怎么处理？</summary><p>边界提示不代表文件损坏。确认整组属于一套，可逐项选择整套接纳并保留内部结构；确为多套时，先在尚未执行的等待区按一套一个目录整理，再调整导入范围。已有作品或目标冲突须判断身份，不覆盖或用改名掩盖冲突。</p></details>
        <AdmissionAcquisitionPolicy :retry="!!pending" />
        <AdmissionAdsPicker :entries="allEntries" :locked="locked" :recycle-ads="!pending" @change="invalidateConfirmation" />
        <div class="creator-tabs" role="tablist" aria-label="按博主核对"><button role="tab" :aria-selected="activeBatchId==='all'" @click="activeBatchId='all';page=1">全部博主</button><button v-for="entry in collection.batches" :key="entry.id" role="tab" :aria-selected="activeBatchId===entry.id" @click="activeBatchId=entry.id;page=1">{{ entry.creatorName }} <small>{{ contexts[entry.id]?.items.length??entry.totals.total }} 目录 · {{ pendingFor(entry.id) }} 待处理</small></button></div>
        <div><div class="toolbar"><label>处理状态<select v-model="reviewFilter" data-test="review-filter"><option value="pending">待处理</option><option value="selected">已选入库</option><option value="skip">跳过</option><option value="all">全部</option></select></label><label>查看分组<select v-model="group"><option value="all">全部目录</option><option v-for="(name,key) in admissionGroups" :key="key" :value="key">{{ name }}</option></select></label><input v-model="reviewSearch" type="search" aria-label="搜索本批作品或博主" placeholder="作品、原目录或博主名称" /></div><p v-if="itemsLoading" role="status">读取目录摘要…</p>
          <p v-if="!itemsLoading&&!filteredReviewEntries.length" role="status">{{ reviewFilter==='pending'?'当前范围没有待处理项，可查看已选入库作品后统一确认。':'没有符合筛选的目录。' }}</p>
          <details v-for="row in visibleReviewEntries" :key="`${row.context.batch.id}:${row.item.key}`" class="review-row" :open="needsAttention(row)">
            <summary><strong>{{ row.context.batch.creatorName }} · {{ row.item.displayTitle }}</strong><span>{{ admissionActionLabels[row.context.actions[row.item.key].action] }} · {{ row.item.summary.images }} 图 / {{ row.item.summary.videos }} 视频</span></summary>
            <AdmissionItemEditor v-model="row.context.actions[row.item.key]" :item="row.item" :creator-id="row.context.batch.creatorId" :peers="entriesFor(row.context)" :selected-work="row.context.works[row.item.key]" :locked="locked" :accept-existing-version="acceptsExistingVersion(row.context.batch.id)" :recycle-ads="recyclesAds(row.context.batch.id)" @select-work="row.context.works[row.item.key]=$event" @change="invalidateConfirmation" />
          </details>
          <div class="pagination"><button :disabled="page<=1" @click="page--">上一页目录</button><span>第 {{ page }} / {{ Math.max(1,Math.ceil(filteredReviewEntries.length/20)) }} 页 · {{ filteredReviewEntries.length }} 目录</span><button :disabled="page*20>=filteredReviewEntries.length" @click="page++">下一页目录</button></div>
        </div>
        <p class="hint">确认入库后，完成时会将本批已清空的博主父目录送入Windows回收站；仍有暂缓作品或其他文件的非空目录保留，不自动处理剩余项。</p>
        <p v-if="pending" class="warning">执行回执尚未确认。原范围与选择已保留，只能核对并重试原请求，不会再次建立计划。</p>
        <div class="stage-actions"><button data-test="collection-edit-scope" :disabled="locked" @click="editScope">上一步：调整导入范围</button><strong>{{ selectedCount }} 接纳 · {{ skippedCount }} 跳过 · {{ deferredCount }} 暂缓</strong><button class="primary" data-test="collection-confirm" :disabled="busy||itemsLoading||!allEntries.length" @click="showConfirm=true">{{ pending?'核对并重试原提交':'核对全部并确认' }}</button></div>
      </section>

      <section v-else class="panel" aria-label="多博主后台结果"><h2>按博主查看结果</h2><article v-for="entry in collection.batches" :key="entry.id" class="result"><div class="heading"><h3>{{ entry.creatorName }}</h3><span>{{ batchStateLabel(entry.state) }}</span></div><p>{{ entry.totals.completed }} 已完成 · {{ entry.totals.skipped }} 跳过 · {{ entry.totals.deferred }} 暂缓</p><p v-if="entry.error" class="error">{{ entry.error }}</p><details><summary>目录明细与处理入口</summary><ul><li v-for="item in contexts[entry.id]?.items" :key="item.key"><strong>{{ item.sourceRelativePath }}</strong><span>{{ itemPhase(item) }}</span><p v-if="item.lastError" class="error">{{ item.lastError }}</p><RouterLink v-if="item.postId" :to="{name:'canonical-work-gallery',params:{creatorId:entry.creatorId,postId:item.postId}}">查看图集</RouterLink><RouterLink v-if="!active&&entry.planId&&item.nextAction==='review_files'" :to="{name:'local-review',query:{kind:'admission',planId:entry.planId,itemKey:item.key,creatorId:entry.creatorId}}">核对文件处置</RouterLink><p v-if="!active&&item.nextActionReason" class="hint">{{ item.nextActionReason }}</p><button v-if="item.nextAction==='resume_plan'&&!active" :disabled="busy" @click="showResume=true">核对后继续原批次</button></li></ul></details></article><div v-if="['partial','interrupted'].includes(collection.state)" class="stage-actions"><div><p>已完成的博主不会重跑；先处理具体失败原因，再继续原集合未完成项。</p><p class="hint">尚未移动但源文件已变化的目录：使用“新建批次”重新预览仍在等待区的目录，不能修改或重放原确认计划。已经移动的项目按原检查点处理，仅显示当前检查点允许的文件处置入口。</p></div><button :disabled="busy" @click="showResume=true">核对后继续本批</button></div></section>
    </template>

    <div v-if="showConfirm&&collection" class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-label="确认多博主接纳"><h2>一次确认本批全部范围</h2><p>{{ collection.totals.creators }} 位博主 · {{ selectedCount }} 个接纳目录 · {{ skippedCount }} 跳过 · {{ deferredCount }} 暂缓。</p><div class="confirmation-list"><details v-for="entry in collection.batches" :key="entry.id"><summary><strong>{{ entry.creatorName }}</strong> · {{ batchSummary(entry.id) }}<small>{{ entry.parent }} · 展开核对目录、作品对应和具体广告文件</small></summary><ul><li v-for="pair in contexts[entry.id]?entriesFor(contexts[entry.id]):[]" :key="pair.item.key"><strong>{{ pair.item.sourceRelativePath }}</strong><span>{{ admissionActionLabels[pair.action.action] }}<template v-if="contexts[entry.id].works[pair.item.key]"> → {{ contexts[entry.id].works[pair.item.key].title }}</template><template v-else-if="pair.action.action==='existing'&&pair.action.workId"> → 作品 #{{ pair.action.workId }}（展示资料未缓存）</template><template v-if="pair.action.sameAsKey"> → {{ contexts[entry.id].items.find(item=>item.key===pair.action.sameAsKey)?.sourceRelativePath }}</template></span><small v-if="isAdmissionSelected(pair.action)">{{ pair.item.targetPath }}</small><small v-if="pair.action.primary">使用本目录为主副本，其他副本保留</small><small v-for="ad in pair.action.approvedAds" :key="ad">{{ recyclesAds(entry.id)?'广告送入Windows回收站：':'按原请求移至可恢复附件区：' }}{{ ad }}</small></li></ul></details></div><AdmissionAcquisitionPolicy :retry="!!pending" /><p>跳过 / 暂缓不删除，目标已存在不覆盖。</p><p v-if="selectionError" class="error">{{ selectionError }}</p><p v-if="error" role="alert" class="error">{{ error }}</p><label class="check"><input v-model="confirmed" type="checkbox" />确认上述所有博主、目录及作品选择；当前文件没有继续写入</label><label v-if="adsCount" class="check warning"><input v-model="adsConfirmed" type="checkbox" />另行批准列出的 {{ adsCount }} 个明确广告文件按上述方式处理，其他附件保留</label><div class="dialog-actions"><button :disabled="busy" @click="showConfirm=false">返回核对</button><button class="primary" data-test="collection-execute" :disabled="busy||!confirmed||(adsCount>0&&!adsConfirmed)||!!selectionError" @click="execute">{{ busy?'提交中…':pending?'重试原请求':'确认并后台依次执行' }}</button></div></section></div>
    <div v-if="showResume&&collection" class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-label="继续多博主原批次"><h2>继续本批未完成项</h2><p>复用已确认计划和检查点，核对实际文件后继续。已完成项不再移动，不自动恢复其他集合或历史任务。</p><div class="dialog-actions"><button :disabled="busy" @click="showResume=false">取消</button><button class="primary" :disabled="busy" @click="resume">确认继续原批次</button></div></section></div>
  </main>
</template>

<script setup lang="ts">
import { computed,onBeforeUnmount,reactive,ref,watch } from 'vue';
import { RouterLink,useRoute,useRouter } from 'vue-router';
import AdmissionCreatorPicker from '../components/AdmissionCreatorPicker.vue';
import AdmissionSourcePicker from '../components/AdmissionSourcePicker.vue';
import AdmissionItemEditor from '../components/AdmissionItemEditor.vue';
import AdmissionAcquisitionPolicy from '../components/AdmissionAcquisitionPolicy.vue';
import AdmissionAdsPicker from '../components/AdmissionAdsPicker.vue';
import * as api from '../api/local-admission';
import { RequestError } from '../api/http';
import { carryRefreshedChoices,clearAdmissionDraft,lastAdmissionCollection,rememberAdmissionCollection,restoreAdmissionDraft,saveAdmissionDraft } from '../utils/admission-navigation';
import { carryRepreviewChoices,type RepreviewEntry } from '../utils/admission-repreview';
import { admissionAction,admissionActionLabels,admissionGroups,admissionPayload,isAdmissionSelected,isAdmissionSafeCandidate,validateAdmissionSelection,type AdmissionEntry } from '../utils/admission-ui';
import type { AdmissionAction,AdmissionBatch,AdmissionCollection,AdmissionCollectionExecuteInput,AdmissionCreator,AdmissionDirectory,AdmissionItem,AdmissionPage,AdmissionPreviewInput,AdmissionWork,AdmissionWorkspace } from '../types/local-admission';

interface FolderChoice {selected:boolean;creator:AdmissionCreator|null;available:AdmissionDirectory[];directories:string[];sourceEvidenceId:number|null;loading:boolean;error:string;request:number}
interface BatchContext {batch:AdmissionCollection['batches'][number];items:AdmissionItem[];actions:Record<string,AdmissionAction>;works:Record<string,AdmissionWork>}
const route=useRoute(),router=useRouter(),workspace=ref<AdmissionWorkspace|null>(null),waitingRoot=ref(''),choices=reactive<Record<string,FolderChoice>>({}),filter=ref(''),loading=ref(false),busy=ref(false),itemsLoading=ref(false),error=ref(''),notice=ref('');
const collection=ref<AdmissionCollection|null>(null),contexts=reactive<Record<string,BatchContext>>({}),recent=ref<AdmissionPage<AdmissionCollection>|null>(null),activeBatchId=ref(''),page=ref(1),group=ref('all'),showConfirm=ref(false),confirmed=ref(false),adsConfirmed=ref(false),showResume=ref(false),pending=ref<AdmissionCollectionExecuteInput|null>(null);
const editingScope=ref(false);
const reviewFilter=ref('pending'),reviewSearch=ref('');
let generation=0,disposed=false,startingNew=false,timer:ReturnType<typeof setTimeout>|undefined,pollFailures=0;
const active=computed(()=>!!collection.value&&['queued','running'].includes(collection.value.state));
const locked=computed(()=>busy.value||itemsLoading.value||!!pending.value||collection.value?.state!=='draft');
const visibleFolders=computed(()=>workspace.value?.items.filter(folder=>`${folder.name} ${folder.matches.map(match=>match.creatorName).join(' ')}`.toLowerCase().includes(filter.value.trim().toLowerCase()))??[]);
const chosenFolders=computed(()=>Object.entries(choices).filter(([,value])=>value.selected));
const directoryCount=computed(()=>chosenFolders.value.reduce((sum,[,value])=>sum+value.directories.length,0));
const scopeError=computed(()=>{if(chosenFolders.value.length>100)return '每批最多选择100位博主，请分批处理。';const ids=new Set<number>();for(const [name,value] of chosenFolders.value){if(!value.creator)return '请先明确每个目录的规范博主。';if(ids.has(value.creator.id))return `“${value.creator.name}”对应多个等待区父目录，请分批核对；不会自动混合。`;ids.add(value.creator.id);if(value.loading)return '正在读取所选博主的目录。';if(value.error)return '部分目录读取失败，请重新读取或取消该博主。';if(!value.directories.length)return `“${name}”没有选择作品目录，请选择目录或取消勾选该博主。`;if(value.directories.some(directory=>!value.available.some(item=>item.name===directory&&item.selectable)))return `“${name}”仍选有不存在或不可用的目录，请取消后选择整理后的目录。`;}return '';});
const entriesFor=(context:BatchContext):AdmissionEntry[]=>context.items.map(item=>({item,action:context.actions[item.key]}));
const draftEntries=()=>Object.values(contexts).flatMap(context=>entriesFor(context).map(entry=>({...entry,batchId:context.batch.id,creatorId:context.batch.creatorId,work:context.works[entry.item.key]})));
function saveDraft(){if(collection.value?.state==='draft'&&!pending.value&&!itemsLoading.value)saveAdmissionDraft(collection.value.id,draftEntries());}
const repreviewEntries=():RepreviewEntry[]=>draftEntries().map(entry=>({...entry,parent:contexts[entry.batchId].batch.parent}));
const chosenScopes=():AdmissionPreviewInput[]=>chosenFolders.value.map(([parent,value])=>({creatorId:value.creator!.id,parent,directories:[...value.directories],acceptExistingVersion:true,...(value.sourceEvidenceId?{sourceEvidenceId:value.sourceEvidenceId}:{})}));
const allEntries=computed(()=>collection.value?.batches.flatMap(batch=>contexts[batch.id]?entriesFor(contexts[batch.id]):[])??[]);
const selectedCount=computed(()=>allEntries.value.filter(entry=>isAdmissionSelected(entry.action)).length),skippedCount=computed(()=>allEntries.value.filter(entry=>entry.action.action==='skip').length),deferredCount=computed(()=>allEntries.value.filter(entry=>entry.action.action==='defer').length);
const adsCount=computed(()=>allEntries.value.reduce((sum,entry)=>sum+(isAdmissionSelected(entry.action)?entry.action.approvedAds?.length??0:0),0));
type ReviewRow={context:BatchContext;item:AdmissionItem};
function needsAttention(row:ReviewRow){const action=row.context.actions[row.item.key];return action.action==='defer'||(action.action==='existing'&&!action.workId)||(action.action==='same-as'&&!entriesFor(row.context).some(peer=>peer.item.key===action.sameAsKey&&['new','existing'].includes(peer.action.action)));}
function batchSummary(id:string){const entries=contexts[id]?entriesFor(contexts[id]):[];return `${entries.filter(entry=>isAdmissionSelected(entry.action)).length} 接纳 · ${entries.filter(entry=>entry.action.action==='skip').length} 跳过 · ${entries.filter(entry=>entry.action.action==='defer').length} 暂缓`;}
function itemPhase(item:AdmissionItem){return ({completed:'完成',skip:'跳过，等待区保留',defer:'暂缓，等待区保留',skipped:'跳过，等待区保留',deferred:'暂缓，等待区保留',not_started:'尚未开始',planned:'已建立计划，尚未移动',move_intent:'移动检查点',files_verified:'文件已核验',indexed:'已索引'} as Record<string,string>)[item.state]??item.state;}
const reviewEntries=computed<ReviewRow[]>(()=>Object.values(contexts).flatMap(context=>context.items.map(item=>({context,item}))));
function pendingFor(id:string){return reviewEntries.value.filter(row=>row.context.batch.id===id&&needsAttention(row)).length;}
const filteredReviewEntries=computed(()=>reviewEntries.value.filter(row=>{
  const action=row.context.actions[row.item.key],query=reviewSearch.value.trim().toLocaleLowerCase();
  return (activeBatchId.value==='all'||row.context.batch.id===activeBatchId.value)&&(group.value==='all'||row.item.group===group.value)
    &&(reviewFilter.value==='all'||reviewFilter.value==='pending'&&needsAttention(row)||reviewFilter.value==='selected'&&isAdmissionSelected(action)||reviewFilter.value==='skip'&&action.action==='skip')
    &&(!query||`${row.context.batch.creatorName} ${row.item.displayTitle} ${row.item.sourceRelativePath}`.toLocaleLowerCase().includes(query));
}));
const visibleReviewEntries=computed(()=>filteredReviewEntries.value.slice((page.value-1)*20,page.value*20));
function invalidateConfirmation(){confirmed.value=false;adsConfirmed.value=false;saveDraft();}
const selectionError=computed(()=>{for(const entry of collection.value?.batches??[]){const context=contexts[entry.id];if(!context)return '目录摘要尚未读取完成。';const message=validateAdmissionSelection(entriesFor(context));if(message)return `${entry.creatorName}：${message}`;}return '';});
const stateLabel=(state:AdmissionCollection['state'])=>({draft:'预览草稿 · 未执行',queued:'等待后台执行',running:'后台处理中',completed:'本批执行已结束 · 请查看结果',partial:'部分完成 · 有项目需处理',interrupted:'中断 · 原批次保留'}[state]);
const batchStateLabel=(state:AdmissionBatch['state'])=>({draft:'待确认',queued:'等待处理',running:'处理中',completed:'完成',needs_review:'需要查看',interrupted:'中断',failed:'失败'}[state]);
const time=(value:string)=>new Date(value).toLocaleString();
const storageKey=(id:string)=>`cosgallery:admission:collection:${id}`;
const definitive=(cause:unknown)=>cause instanceof RequestError&&[400,403,404,409,413,422].includes(cause.status);
function recyclesAds(batchId:string){return pending.value?pending.value.batches.find(entry=>entry.batchId===batchId)?.advertisementDisposition==='recycle_bin':true;}
function acceptsExistingVersion(batchId:string){return pending.value?.batches.find(entry=>entry.batchId===batchId)?.acceptExistingVersion??true;}
function setPending(value:AdmissionCollectionExecuteInput|null){pending.value=value;if(!collection.value)return;try{if(value)localStorage.setItem(storageKey(collection.value.id),JSON.stringify(value));else localStorage.removeItem(storageKey(collection.value.id));}catch{notice.value='浏览器无法保存重试凭据，请保留此页直至确认回执；服务端批次仍会保存。';}}
function restorePending(){if(!collection.value)return;try{const value:unknown=JSON.parse(localStorage.getItem(storageKey(collection.value.id))||'null');if(!value||typeof value!=='object'||!('requestKey'in value)||typeof value.requestKey!=='string'||!('confirmed'in value)||value.confirmed!==true||!('batches'in value)||!Array.isArray(value.batches))return;for(const entry of value.batches){if(!entry||typeof entry!=='object'||typeof entry.batchId!=='string'||!contexts[entry.batchId]||typeof entry.acceptExistingVersion!=='boolean'||!Array.isArray(entry.actions))return;for(const action of entry.actions)if(!action||typeof action!=='object'||typeof action.key!=='string'||!contexts[entry.batchId].actions[action.key]||!['new','existing','same-as','skip','defer'].includes(action.action))return;}const restored=value as AdmissionCollectionExecuteInput;pending.value=restored;for(const entry of restored.batches)for(const action of entry.actions){const context=contexts[entry.batchId];context.actions[action.key]=action;const old=context.works[action.key];delete context.works[action.key];if(action.action==='existing'){const match=old?.workId===action.workId?old:context.items.find(item=>item.key===action.key)?.candidates.find(work=>work.workId===action.workId);if(match)context.works[action.key]=match;}}}catch{/* Local retry data does not authorize server writes. */}}
async function loadWorkspace(){const current=generation;loading.value=true;error.value='';try{const result=await api.fetchAdmissionWorkspace();if(current!==generation||disposed)return;workspace.value=result;waitingRoot.value=result.waitingRoot;for(const key of Object.keys(choices))delete choices[key];for(const folder of result.items){const match=folder.matches.length===1?folder.matches[0]:null;choices[folder.name]={selected:false,creator:match?{id:match.creatorId,name:match.creatorName,aliases:[]}:null,available:[],directories:[],sourceEvidenceId:null,loading:false,error:'',request:0};}}catch(cause){if(current===generation)error.value=cause instanceof Error?cause.message:'等待区读取失败';}finally{if(current===generation)loading.value=false;}}
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
async function loadRecent(page=1){const current=generation;try{const result=await api.fetchAdmissionCollections(page);if(current===generation&&!disposed)recent.value=result;}catch(cause){if(current===generation)notice.value=cause instanceof Error?cause.message:'最近批次读取失败';}}
async function readItems(batch:AdmissionCollection['batches'][number],current:number){const items:AdmissionItem[]=[];let page=1,total=Infinity;while(items.length<total){const result=await api.fetchAdmissionItems(batch.id,page++,100);if(current!==generation||disposed)return;items.push(...result.items);total=result.total;if(!result.items.length)break;}if(current!==generation||disposed)return;const previous=contexts[batch.id];const context:BatchContext={batch,items,actions:previous?.actions??{},works:previous?.works??{}};for(const item of items){if(context.actions[item.key])continue;const suggested=batch.state==='draft'?item.suggestedAction:undefined,work=suggested?.action==='existing'?item.candidates.find(work=>work.workId===suggested.workId):undefined;context.actions[item.key]=suggested&&(suggested.action!=='existing'||work)?{...suggested,key:item.key,selectionOrigin:'manual',approvedAds:[...(suggested.approvedAds??[])],acceptSourceIds:[...(suggested.acceptSourceIds??[])]}:{...admissionAction(item,'defer'),selectionOrigin:'automatic'};if(work)context.works[item.key]=work;}contexts[batch.id]=context;}
async function readAllItems(batches:AdmissionCollection['batches'],current:number){itemsLoading.value=true;try{let index=0;const worker=async()=>{while(index<batches.length&&current===generation&&!disposed){const batch=batches[index++];await readItems(batch,current);}};await Promise.all([worker(),worker()]);}finally{if(current===generation)itemsLoading.value=false;}}
function stopPoll(){if(timer)clearTimeout(timer);timer=undefined;}
function schedulePoll(){stopPoll();if(active.value&&!disposed&&pollFailures<3&&!document.hidden)timer=setTimeout(()=>void refreshCollection(true),2500);}
async function openCollection(id:string,previous?:RepreviewEntry[]){
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
    await router.replace({query:{collection:id}});pollFailures=0;schedulePoll();
  }catch(cause){
    if(current!==generation||disposed)return;
    collection.value=null;
    if(cause instanceof RequestError&&[403,404].includes(cause.status)){if(lastAdmissionCollection()===id)rememberAdmissionCollection(null);clearAdmissionDraft(id);}
    await loadWorkspace();if(current===generation&&!disposed)error.value=cause instanceof Error?cause.message:'批次读取失败';
  }
}
async function refreshCollection(poll=false){if(!collection.value)return;saveDraft();const current=generation,id=collection.value.id;try{const result=await api.fetchAdmissionCollection(id);if(current!==generation||disposed)return;saveDraft();const previous=draftEntries();const changed=result.batches.filter(batch=>{const old=contexts[batch.id]?.batch;return !poll||!old||old.state!==batch.state||old.updatedAt!==batch.updatedAt||old.totals.completed!==batch.totals.completed;});collection.value=result;if(result.state!=='draft')setPending(null);await readAllItems(changed,current);if(current!==generation||disposed)return;if(result.state==='draft'&&!pending.value){for(const entry of carryRefreshedChoices(previous,draftEntries())){const context=contexts[entry.batchId];context.actions[entry.key]=entry.action;delete context.works[entry.key];if(entry.work)context.works[entry.key]=entry.work;}saveDraft();}pollFailures=0;schedulePoll();}catch(cause){if(current!==generation)return;pollFailures++;if(!poll||pollFailures>=3)error.value=cause instanceof Error?cause.message:'状态读取失败';schedulePoll();}}
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
  try{const result=await api.repreviewAdmissionCollection(id);if(current!==generation||disposed)return;current++;await openCollection(result.id,previous);
    if(current===generation&&!disposed){const priorSelected=new Set(previous.filter(row=>isAdmissionSelected(row.action)).map(row=>`${row.creatorId}:${row.parent}:${row.item.sourceRelativePath}`));const added=repreviewEntries().filter(row=>isAdmissionSelected(row.action)&&!priorSelected.has(`${row.creatorId}:${row.parent}:${row.item.sourceRelativePath}`)).length;notice.value=`已重新检查并更新选择：新增选中 ${added} 个，当前 ${selectedCount.value} 个入库、${deferredCount.value} 个暂缓。人工决定和已有广告取消保留；新增或改名目录请调整导入范围。`;await loadRecent();}}
  catch(cause){if(current===generation&&!disposed)error.value=cause instanceof Error?cause.message:'重新检查文件失败';}finally{if(current===generation&&!disposed)busy.value=false;}
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
async function resume(){if(!collection.value||busy.value)return;const current=generation,id=collection.value.id,key=`${storageKey(id)}:resume`;busy.value=true;error.value='';let requestKey:string;try{requestKey=localStorage.getItem(key)||crypto.randomUUID();localStorage.setItem(key,requestKey);}catch{requestKey=crypto.randomUUID();}try{const result=await api.resumeAdmissionCollection(id,{requestKey,confirmed:true});try{localStorage.removeItem(key);}catch{/* Server receipt persists. */}if(current!==generation||disposed)return;collection.value=result;showResume.value=false;pollFailures=0;schedulePoll();}catch(cause){if(definitive(cause))try{localStorage.removeItem(key);}catch{/* Rejected receipt is not pending. */}if(current===generation)error.value=cause instanceof Error?cause.message:'继续失败';}finally{if(current===generation&&!disposed)busy.value=false;}}
async function startNew(){
  saveDraft();generation++;stopPoll();rememberAdmissionCollection(null);collection.value=null;editingScope.value=false;pending.value=null;showConfirm.value=false;showResume.value=false;confirmed.value=false;adsConfirmed.value=false;error.value='';startingNew=true;
  for(const key of Object.keys(contexts))delete contexts[key];
  try {await router.replace({query:{}});await loadWorkspace();}finally{startingNew=false;}
}
function visible(){if(document.hidden)stopPoll();else schedulePoll();}
watch([group,reviewFilter,reviewSearch],()=>page.value=1);
watch(()=>filteredReviewEntries.value.length,()=>{page.value=Math.min(page.value,Math.max(1,Math.ceil(filteredReviewEntries.value.length/20)));});
watch(()=>route.query.collection,async id=>{
  if(typeof id==='string'){if(id!==collection.value?.id)await openCollection(id);}
  else if(id===undefined){
    if(startingNew)return;
    const remembered=lastAdmissionCollection();
    if(remembered){if(remembered!==collection.value?.id)await openCollection(remembered);else await router.replace({query:{collection:remembered}});}
    else if(collection.value)await startNew();
    else if(!workspace.value)await loadWorkspace();
  }
},{immediate:true});
void loadRecent();document.addEventListener('visibilitychange',visible);window.addEventListener('pagehide',saveDraft);
onBeforeUnmount(()=>{saveDraft();disposed=true;generation++;stopPoll();document.removeEventListener('visibilitychange',visible);window.removeEventListener('pagehide',saveDraft);});
</script>

<style scoped>
.review-row{border-top:1px solid #8883;padding:.7rem 0}.review-row>summary{display:flex;justify-content:space-between;gap:.8rem;flex-wrap:wrap}.review-row>summary span{font-size:.8rem;opacity:.8}.history button{text-align:left}.confirmation-list>details{padding:.7rem 0;border-top:1px solid #8882}
.admission-workspace{max-width:76rem;margin:auto;padding:1.5rem 1.5rem 5rem;color:var(--text)}header,.heading{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}header{margin-bottom:1.5rem}h1{font-size:1.9rem;margin:.3rem 0}h2{font-size:1.1rem;margin:.3rem 0}h3{font-size:1rem}.eyebrow{font-size:.7rem;letter-spacing:.18em;opacity:.6}header p,.hint{font-size:.83rem;line-height:1.6;opacity:.76}.steps{display:flex;list-style:none;padding:0;gap:1rem;flex-wrap:wrap;margin:1.4rem 0}.steps li{padding:.55rem .8rem;border-radius:.5rem;font-size:.86rem;opacity:.55}.steps .current{background:var(--accent,#7764b0);color:white;opacity:1}.panel{background:var(--surface,#fff);border:1px solid #8883;border-radius:1rem;padding:1.25rem;margin:1rem 0;min-width:0}.history>summary{font-weight:600}.history ul{max-height:13rem;overflow:auto}.history li{margin:.5rem 0}.settings{margin:1rem 0}.folder,.result{border-top:1px solid #8883;padding:1rem 0}.folder-name{margin:0;font-size:1rem}.identity{font-size:.8rem;border-radius:2rem;background:#8877aa14;padding:.35rem .7rem}.toolbar,.pagination,form{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;margin:.8rem 0}.filter{width:100%;box-sizing:border-box}button,input,select{font:inherit;padding:.55rem .8rem;border:1px solid #8884;border-radius:.55rem;background:var(--bg,#fafafa);color:inherit;max-width:100%}button{cursor:pointer}button:disabled{opacity:.4;cursor:default}.primary{background:var(--accent,#7764b0);color:white;border-color:transparent}label{display:grid;gap:.4rem}.check{display:flex;gap:.6rem;align-items:flex-start;line-height:1.55}.check input{margin-top:.3rem}.directory-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.6rem;max-height:22rem;overflow:auto;padding:.6rem 0}.directory-grid label{font-size:.82rem;overflow-wrap:anywhere}small{font-size:.76rem;opacity:.76;display:block}summary{cursor:pointer}.creator-tabs{display:flex;gap:.5rem;overflow-x:auto;padding:.65rem 0}.creator-tabs button{white-space:nowrap}.creator-tabs button[aria-selected=true]{border-color:var(--accent);background:#8877aa14}.stage-actions{position:sticky;bottom:.6rem;z-index:5;display:flex;justify-content:space-between;align-items:center;gap:1rem;background:var(--surface,#fff);border:1px solid #8883;box-shadow:0 .3rem 1.5rem #0001;padding:.9rem 1rem;border-radius:.8rem;margin-top:1.25rem}.stage-actions strong{font-size:.88rem}.stage-actions label,.stage-actions p{font-size:.78rem;margin:.4rem 0 0}.error{color:#bb2938;white-space:pre-wrap;overflow-wrap:anywhere}.warning{color:#996211;background:#eeaa1110;padding:.6rem;border-radius:.5rem}.result ul,.confirmation-list ul{list-style:none;padding:0}.result li,.confirmation-list li{display:grid;gap:.4rem;padding:.7rem 0;border-top:1px solid #8882;overflow-wrap:anywhere}.result li span{font-size:.8rem}a{color:var(--accent,#7764b0)}.overlay{position:fixed;inset:0;z-index:100;background:#0007;display:flex;align-items:center;justify-content:center;padding:1rem}.dialog{background:var(--surface,#fff);padding:1.5rem;border-radius:1rem;max-width:60rem;width:100%;max-height:90vh;overflow:auto}.confirmation-list{max-height:45vh;overflow:auto}.dialog-actions{display:flex;justify-content:flex-end;gap:.7rem;margin-top:1rem}dl{display:grid;grid-template-columns:6rem 1fr;gap:.4rem;font-size:.8rem}dd{margin:0;overflow-wrap:anywhere}@media(max-width:600px){.admission-workspace{padding:.5rem}.panel{padding:1rem}.stage-actions{align-items:stretch;flex-direction:column}.directory-grid{grid-template-columns:1fr}.steps{gap:.3rem}.steps li{font-size:.75rem;padding:.5rem}.dialog{padding:1rem}}
</style>
