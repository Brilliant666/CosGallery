<template>
  <section class="admission-page">
    <header><div><p class="eyebrow">LOCAL ADMISSION</p><h1>{{ creatorName || '本地目录' }} · 本地导入</h1><p>选择已分套的本机目录，集中确认后后台执行。无需上传媒体，也无需先登记来源。</p></div><RouterLink to="/archive-catalog">返回博主库</RouterLink></header>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <section class="panel recent"><div class="section-heading"><h2>当前 / 最近导入批次</h2><button :disabled="busy" @click="loadRecent">刷新批次</button><button :disabled="busy || active" @click="startNew">选择新一批目录</button></div><p v-if="!recent.length">还没有导入批次。</p><ul><li v-for="record in recent" :key="record.id"><button @click="openBatch(record.id)" :disabled="busy" :aria-pressed="batch?.id === record.id">{{ time(record.createdAt) }} · {{ record.totals.total }} 目录 · {{ stateLabel(record.state) }}</button></li></ul></section>
    <section v-if="!batch" class="panel" aria-label="选择本地目录">
      <h2>1. 选择目录</h2><p class="hint">请先完成手工复制 / 解压。执行期间不要修改同批文件；服务端会在确认及执行时再次核对。</p>
      <dl v-if="settings"><dt>已解压等待区</dt><dd>{{ settings.waitingRoot || '尚未配置' }}</dd><dt>正式图库</dt><dd>{{ settings.galleryRoot }}</dd></dl>
      <details><summary>等待区设置</summary><form @submit.prevent="saveRoot"><label>已解压等待区根目录<input v-model="waitingRoot" required placeholder="本机服务允许的等待区" /></label><button :disabled="busy">保存等待区</button></form><p class="hint">这里只配置等待区，不开放任意磁盘浏览。源与正式图库必须支持既有同卷移动。</p></details>
      <div class="actions"><button :disabled="busy" @click="browse()">返回等待区</button><strong>{{ parent || '选择本批博主文件夹' }}</strong><button :disabled="busy" @click="browse(parent || undefined)">刷新当前目录</button></div>
      <p v-if="directoryLoading" role="status">正在列出当前层级…</p>
      <template v-if="directories && !parent"><div class="directory-list"><button v-for="dir in directories.items" :key="dir.name" :disabled="busy || !dir.selectable" @click="browse(dir.name)"><strong>{{ dir.name }}</strong><small>{{ dir.matchesSelectedCreator ? '名称 / 已登记别名匹配当前博主' : dir.matchedCreatorIds.length ? '匹配其他规范身份，请核对；不会新建博主' : '名称未自动对应；将以本页规范博主预览' }}</small><small v-if="dir.reason">{{ dir.reason }}</small></button></div></template>
      <template v-else-if="directories"><div class="actions"><button :disabled="busy" @click="selectAll">全选当前可接纳目录</button><button :disabled="busy" @click="selectedNames = []">取消选择</button><span>已选 {{ selectedNames.length }} / {{ directories.items.length }} 个目录</span></div><div class="directory-list"><label v-for="dir in directories.items" :key="dir.name" class="directory-row"><input v-model="selectedNames" type="checkbox" :value="dir.name" :disabled="busy || !dir.selectable" /><span>{{ dir.name }}<small v-if="dir.reason">{{ dir.reason }}</small></span></label></div></template>
      <p v-if="directories && !directories.items.length">当前层级没有目录。只读取这一层，不递归扫描旧图库。</p>
      <label>本批来源资料（可选）<select v-model="sourceEvidenceId" :disabled="busy"><option :value="null">无来源资料，本地先接纳</option><option v-for="source in sources" :key="source.id" :value="source.id">{{ source.pageTitle || source.platform }} · {{ time(source.observedAt) }}</option></select></label><div v-if="sourceHasMore" class="actions"><button :disabled="busy" @click="loadSources(sourcePage + 1)">更多本博主资料</button></div><p class="hint">批次来源只说明文件出处，不代表精确作品对应或下载需求已满足。</p>
      <label class="check"><input v-model="filesReady" type="checkbox" :disabled="busy" />手工复制 / 解压已结束，本批目录目前不再写入</label>
      <button class="primary" data-test="admission-preview" :disabled="busy || !filesReady || !parent || !selectedNames.length" @click="preview">{{ busy ? '正在生成预览…' : `生成 ${selectedNames.length} 个目录的实际预览` }}</button>
    </section>
    <template v-if="batch">
      <section class="panel" aria-label="批次状态"><div class="section-heading"><h2>{{ stateLabel(batch.state) }}</h2><button :disabled="busy" @click="refreshBatch()">读取最新状态</button></div><p>{{ batch.totals.completed }} 已完成 · {{ batch.totals.selected }} 确认接纳 · {{ batch.totals.skipped }} 跳过 · {{ batch.totals.deferred }} 暂缓</p><p v-if="active" role="status">服务端正在执行。关闭页面不会取消；稍后通过“最近导入批次”继续查看。{{ pollFailures ? '暂时无法刷新，可手动读取最新状态。' : '' }}</p><p v-if="batch.error" class="error">{{ batch.error }}</p><details><summary>技术详情</summary><dl><dt>批次</dt><dd>{{ batch.id }}</dd><dt>原计划</dt><dd>{{ batch.planId || '尚未确认' }}</dd><dt>更新时间</dt><dd>{{ batch.updatedAt }}</dd><dt>输入根目录</dt><dd>{{ batch.inputRoot }}</dd></dl></details></section>
      <section v-if="batch.state === 'draft'" class="panel" aria-label="预览与确认">
        <h2>2. 预览与集中确认</h2><p>候选不是已批准关系。默认暂缓；可集中选择明确的新作品，其他项分别复用已有作品、确认同套、跳过或暂缓。</p>
        <p v-if="items.some(item => item.suggestedAction)" class="hint">已保留未变化项目的上次选择，仍需本次确认。发生变化或无法复用的项目暂缓，不会自动执行。</p>
        <div class="actions"><button :disabled="draftLocked" @click="confirmNewGroup">A 组全部选择新独立作品</button><label>分组<select v-model="group"><option value="all">全部目录</option><option v-for="(label, key) in groups" :key="key" :value="key">{{ key }} · {{ label }}</option></select></label></div>
        <section class="batch-ads" aria-label="本批附件集中选择">
          <h3>本批附件集中选择</h3>
          <p class="hint">仅作用于已选择接纳的 {{ selectedCount }} 个目录，跨全部分页和分组；不改变作品身份，跳过 / 暂缓目录不处理。TXT / URL 只是候选，不默认当作广告。</p>
          <p class="hint">全局已确认图片广告：492.jpg、009-01.jpg（ecytt02）。新选择接纳时默认勾选，可逐项取消；确认后可恢复移出，不清理已入库历史文件。</p>
          <fieldset :disabled="draftLocked">
            <div class="actions"><button data-test="ads-select-all" :disabled="!adSummary.length" @click="selectAds(true)">勾选全部候选</button><button data-test="ads-clear-all" :disabled="!adsCount" @click="selectAds(false)">清空本批勾选</button><span>已勾选 {{ adsCount }} 个具体文件，执行前仍需另行确认</span></div>
            <div v-for="ad in adSummary" :key="ad.filename" class="ad-summary-row" :data-ad-filename="ad.filename">
              <span><strong>{{ ad.filename }}</strong><small>{{ ad.type }} · {{ ad.directories }} 个接纳目录 / {{ ad.files }} 个文件 · 已选 {{ ad.selected }}<template v-if="ad.automatic"> · 全局已确认广告</template></small></span>
              <div class="actions"><button :disabled="ad.selected === ad.files" @click="selectAds(true, ad.filename)">勾选同名候选</button><button :disabled="!ad.selected" @click="selectAds(false, ad.filename)">取消同名勾选</button></div>
            </div>
          </fieldset>
          <p v-if="!adSummary.length" class="hint">请先选择接纳的目录；没有匹配附件时无需处理。预览和勾选不会移动文件。</p>
        </section>
        <p v-if="itemsLoading">正在读取预览摘要…</p>
        <article v-for="item in visibleItems" :key="item.key" class="item-card" :data-test="'admission-item-'+item.key">
          <div class="section-heading"><div><span class="badge">{{ item.group }} · {{ groups[item.group] }}</span><h3>{{ item.displayTitle }}</h3><p class="path">{{ item.sourceRelativePath }}</p></div><span>{{ item.summary.images }} 图 · {{ item.summary.videos }} 视频<br /><small>{{ size(item.summary.bytes) }} · {{ item.summary.other }} 附件 / 其他</small></span></div>
          <p v-for="conflict in item.conflicts" :key="conflict" class="warning">{{ conflict }}</p>
          <fieldset :disabled="draftLocked"><label>本次处理<select :value="actionFor(item).action" @change="changeAction(item, $event)"><option value="defer">暂缓，保留等待区文件</option><option value="new">接纳为新独立作品</option><option value="existing">对应已有作品</option><option value="same-as">与本批另一目录同套</option><option value="skip">跳过本次导入，保留等待区文件</option></select></label>
            <template v-if="actionFor(item).action === 'new'"><label>展示名称<input v-model="actions[item.key].displayTitle" maxlength="500" /></label><p class="hint">原目录名与内部结构不变；允许以后可靠来源关联，不自动建立来源对应。</p></template>
            <template v-if="actionFor(item).action === 'existing'"><div class="actions"><button type="button" @click="pickerKey = pickerKey === item.key ? null : item.key">{{ selectedWorks[item.key] ? '改选已有作品' : '查找已有作品' }}</button><button v-for="candidate in item.candidates" :key="candidate.workId" @click="selectWork(item, candidate)">候选：{{ candidate.title }} · {{ candidate.images }} 图 / {{ candidate.videos }} 视频</button></div><AdmissionWorkPicker v-if="pickerKey === item.key" :creator-id="creatorId" @select="selectWork(item, $event)" @close="pickerKey = null" /><div v-if="selectedWorks[item.key]" class="work-selection"><img v-if="selectedWorks[item.key].thumbnailUrl" :src="selectedWorks[item.key].thumbnailUrl!" alt="所选作品封面" loading="lazy" /><div><strong>对应：{{ selectedWorks[item.key].title }}</strong><p>{{ selectedWorks[item.key].images }} 图 · {{ selectedWorks[item.key].videos }} 视频 · {{ selectedWorks[item.key].originalDirectories.join(' / ') }}</p></div></div><label class="check"><input v-model="actions[item.key].primary" type="checkbox" />本目录作为主副本（不选则保留已有主副本）</label><div v-if="acceptExistingVersion && selectedWorks[item.key]?.sources.length"><p>明确接受以下已关联来源的现有本地版本（仅限勾选项）：</p><label v-for="source in selectedWorks[item.key].sources" :key="source.sourceWorkId" class="check"><input v-model="actions[item.key].acceptSourceIds" type="checkbox" :value="source.sourceWorkId" />{{ source.sourceOrder }} {{ source.title }} · {{ source.mediaSummary || '来源数量未声明' }}</label></div></template>
            <template v-if="actionFor(item).action === 'same-as'"><label>同套的本批目录<select v-model="actions[item.key].sameAsKey"><option :value="undefined">选择目录，不以同名自动确认</option><option v-for="other in items.filter(other => other.key !== item.key && ['new','existing'].includes(actionFor(other).action))" :key="other.key" :value="other.key">{{ other.sourceRelativePath }}</option></select></label><label class="check"><input v-model="actions[item.key].primary" type="checkbox" />使用本目录作为这一套的主副本，另一份保留</label></template>
            <label v-if="!['new','defer'].includes(actionFor(item).action)">选择依据 / 备注<input v-model="actions[item.key].reason" maxlength="2000" placeholder="按本次确认选择记录，不默认声称逐字节相同" /></label>
            <details v-if="item.ads.length && isSelected(item)"><summary>附件候选 · {{ item.ads.length }} 项（已选 {{ actionFor(item).approvedAds?.length || 0 }} 项）</summary><p class="hint">仅勾选确认为广告的具体文件；移入可恢复附件区，不永久删除，不打开链接。其他文件保持。</p><label v-for="ad in item.ads" :key="ad.relativePath" class="check"><input v-model="actions[item.key].approvedAds" type="checkbox" :value="ad.relativePath" />{{ ad.relativePath }} · {{ size(ad.size) }}<small v-if="ad.automatic">全局已确认广告（可取消）</small></label></details>
          </fieldset><p v-if="isSelected(item)" class="path">实际目标：{{ item.targetPath }}</p>
        </article>
        <div class="actions"><button :disabled="page <= 1" @click="page--">上一页目录</button><span>共 {{ filteredItems.length }} 目录 · 第 {{ page }} / {{ Math.max(1, Math.ceil(filteredItems.length / pageSize)) }} 页</span><button :disabled="page * pageSize >= filteredItems.length" @click="page++">下一页目录</button></div>
        <label class="check"><input v-model="acceptExistingVersion" type="checkbox" :disabled="draftLocked" />接受已有可用本地版本，并允许以后可靠来源关联。具体来源满足仅按明确映射及所选来源处理，不伪造下载历史。</label>
        <p v-if="pending" class="warning">上次执行回执尚未确认。原请求与选择已保留，请重试原请求；不会创建另一套计划。</p>
        <button class="primary" :disabled="busy || itemsLoading || !items.length" @click="showConfirmation = true">{{ pending ? '查看并重试原提交' : '核对本批并确认执行' }}</button>
      </section>
      <section v-else class="panel" aria-label="执行结果"><h2>3. 执行进度与结果</h2><table><thead><tr><th>目录</th><th>实际阶段</th><th>结果 / 后续</th></tr></thead><tbody><tr v-for="item in items" :key="item.key"><td><label v-if="isUnstarted(item)" class="check"><input v-model="repreviewKeys" type="checkbox" :value="item.key" />{{ item.sourceRelativePath }}</label><span v-else>{{ item.sourceRelativePath }}</span></td><td>{{ phaseLabel(item.state) }}</td><td><p v-if="item.lastError" class="error">{{ item.lastError }}</p><RouterLink v-if="batch.planId && item.lastError && !['completed','skipped','deferred','skip','defer'].includes(item.state)" :to="{name:'local-review',query:{kind:'admission',planId:batch.planId,itemKey:item.key,creatorId}}">查看并处理</RouterLink><RouterLink v-if="item.postId" :to="{name:'canonical-work-gallery',params:{creatorId,postId:item.postId}}">查看已入库图集</RouterLink><span v-if="['skipped','deferred','skip','defer'].includes(item.state)">等待区文件保留</span></td></tr></tbody></table><div class="actions"><button v-if="['interrupted','failed','needs_review'].includes(batch.state)" :disabled="busy" @click="showResume = true">核对后继续原计划</button><button v-if="!active" :disabled="busy || !repreviewKeys.length" @click="repreview">对选中的 {{ repreviewKeys.length }} 个未开始目录重新预览</button></div><p class="hint">可勾选未开始的具体目录单独重新预览，其他项保留。已有移动 / 索引检查点的目录只能继续原计划；不能忽略文件差异。需要文件处置时先进入“查看并处理”。</p></section>
    </template>
    <div v-if="showConfirmation && batch" class="overlay"><section class="confirmation" role="dialog" aria-modal="true" aria-label="确认本批接纳"><h2>确认本批实际操作</h2><p v-if="error" role="alert" class="error">{{ error }}</p><p>{{ selectedCount }} 个目录接纳 · {{ skippedCount }} 跳过 · {{ deferredCount }} 暂缓。跳过 / 暂缓不删除文件。</p><div class="confirmation-list"><article v-for="item in items" :key="item.key"><strong>{{ item.sourceRelativePath }}</strong><span>{{ actionLabels[actionFor(item).action] }}<template v-if="selectedWorks[item.key]"> → {{ selectedWorks[item.key].title }}</template><template v-if="actionFor(item).sameAsKey"> → {{ items.find(other => other.key === actionFor(item).sameAsKey)?.sourceRelativePath }}</template></span><small v-if="isSelected(item)">{{ item.targetPath }}</small><small v-if="actionFor(item).primary">将此副本设为主副本</small><small v-for="ad in actionFor(item).approvedAds" :key="ad">广告可恢复移出：{{ ad }}</small></article></div><p>版本接受：{{ acceptExistingVersion ? '接受现有可用本地版本' : '此次不接受来源版本' }}。原目录和内部结构保持。</p><label class="check"><input v-model="confirmChecked" type="checkbox" />确认上述目录范围、作品选择及跳过 / 暂缓项；当前文件没有继续写入</label><label v-if="adsCount" class="check warning"><input v-model="adsChecked" type="checkbox" />另行确认上面列出的 {{ adsCount }} 个附件是广告，允许移至可恢复附件区，其余保留</label><p v-if="selectionError" class="error">{{ selectionError }}</p><div class="actions"><button :disabled="busy" @click="showConfirmation=false">返回修改</button><button class="primary" data-test="admission-execute" :disabled="busy || !confirmChecked || (adsCount > 0 && !adsChecked) || !!selectionError" @click="execute">{{ busy ? '正在提交…' : pending ? '重试原请求' : '确认并后台执行' }}</button></div></section></div>
    <div v-if="showResume" class="overlay"><section class="confirmation" role="dialog" aria-modal="true" aria-label="继续原计划"><h2>继续这个原计划</h2><p>服务端会重新验证检查点、实际文件与活动任务。已经完成的项不会重新移动；不自动运行其他历史批次。</p><div class="actions"><button :disabled="busy" @click="showResume=false">取消</button><button :disabled="busy" @click="resume">确认继续本批</button></div></section></div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import AdmissionWorkPicker from '../components/AdmissionWorkPicker.vue';
import * as api from '../api/local-admission';
import { fetchSourceEvidence } from '../api/source-evidence';
import type { SourceEvidenceObservation } from '../api/source-evidence';
import { RequestError } from '../api/http';
import type { AdmissionAction, AdmissionActionKind, AdmissionBatch, AdmissionDirectories, AdmissionExecuteInput, AdmissionItem, AdmissionSettings, AdmissionState, AdmissionWork } from '../types/local-admission';
const route = useRoute(), router = useRouter();
const creatorId = computed(() => Number(route.params.creatorId));
const creatorName = ref(''), settings = ref<AdmissionSettings | null>(null), directories = ref<AdmissionDirectories | null>(null), waitingRoot = ref(''), parent = ref(''), selectedNames = ref<string[]>([]), filesReady = ref(false);
const sources = ref<SourceEvidenceObservation[]>([]), sourceEvidenceId = ref<number | null>(null), sourcePage = ref(1), sourceHasMore = ref(false);
const batch = ref<AdmissionBatch | null>(null), items = ref<AdmissionItem[]>([]), recent = ref<AdmissionBatch[]>([]), actions = reactive<Record<string, AdmissionAction>>({}), selectedWorks = reactive<Record<string, AdmissionWork>>({});
const busy = ref(false), directoryLoading = ref(false), itemsLoading = ref(false), error = ref(''), notice = ref(''), group = ref('all'), page = ref(1), pickerKey = ref<string | null>(null), acceptExistingVersion = ref(false), showConfirmation = ref(false), confirmChecked = ref(false), adsChecked = ref(false), showResume = ref(false);
const repreviewKeys = ref<string[]>([]);
const isUnstarted = (item: AdmissionItem) => ['preview','new','existing','same-as','skip','defer','skipped','deferred'].includes(item.state);
const pending = ref<AdmissionExecuteInput | null>(null), pollFailures = ref(0); let mutationToken = 0, directoryRequest = 0, generation = 0, timer: ReturnType<typeof setTimeout> | undefined, disposed = false; const pageSize = 20;
const groups = { A: '新独立作品候选', B: '已有作品候选，待本次确认', C: '已有同套 / 额外副本待选', D: '冲突 / 需要确认' };
const actionLabels: Record<AdmissionActionKind,string> = { new: '新独立作品', existing:'复用已有作品', 'same-as':'与本批另一目录同套', skip:'跳过', defer:'暂缓' };
const stateLabel = (state: AdmissionState) => ({draft:'预览草稿 · 未执行',queued:'已提交',running:'运行中',completed:'已完成',needs_review:'待审核',interrupted:'已中断 · 可核对后继续',failed:'执行失败'}[state]);
const phaseLabel = (value: string) => ({preview:'预览',new:'未开始',existing:'未开始',skip:'跳过',defer:'暂缓',files_verified:'目录已核验',planned:'准备',pending:'准备',moving:'目录移动',moved:'目录已移动',indexing:'媒体索引',indexed:'已索引',linking:'来源关联',completed:'完成',skipped:'跳过',deferred:'暂缓',failed:'失败',needs_review:'待审核'}[value] ?? value);
const size = (bytes: number) => bytes >= 1024**3 ? `${(bytes/1024**3).toFixed(2)} GiB` : bytes >= 1024**2 ? `${(bytes/1024**2).toFixed(1)} MiB` : `${bytes} B`;
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12:false });
const active = computed(() => batch.value ? ['queued','running'].includes(batch.value.state) : false);
const draftLocked = computed(() => busy.value || itemsLoading.value || !!pending.value || batch.value?.state !== 'draft');
const filteredItems = computed(() => items.value.filter(item => group.value === 'all' || item.group === group.value));
const visibleItems = computed(() => filteredItems.value.slice((page.value-1)*pageSize,page.value*pageSize));
function actionFor(item: AdmissionItem): AdmissionAction { return actions[item.key] ?? { key:item.key,action:'defer',approvedAds:[],acceptSourceIds:[] }; }
const isSelected = (item: AdmissionItem) => ['new','existing','same-as'].includes(actionFor(item).action);
const selectedCount = computed(() => items.value.filter(isSelected).length), skippedCount = computed(() => items.value.filter(item => actionFor(item).action==='skip').length), deferredCount = computed(() => items.value.filter(item => actionFor(item).action==='defer').length);
const adsCount = computed(() => items.value.reduce((sum,item) => sum+(isSelected(item) ? actionFor(item).approvedAds?.length ?? 0 : 0),0));
const adFilename = (relativePath: string) => relativePath.split(/[\\/]/).at(-1) ?? relativePath;
const adSummary = computed(() => {
  const rows = new Map<string, { filename: string; type: string; directories: number; files: number; selected: number; automatic: boolean }>();
  for (const item of items.value.filter(isSelected)) {
    const approved = new Set(actionFor(item).approvedAds ?? []), names = new Set<string>();
    for (const ad of item.ads) {
      const filename = adFilename(ad.relativePath);
      const row = rows.get(filename) ?? { filename, type: filename.split('.').at(-1)?.toUpperCase() ?? '附件', directories: 0, files: 0, selected: 0, automatic: false };
      row.files++; if (!names.has(filename)) row.directories++;
      row.selected += Number(approved.has(ad.relativePath)); row.automatic ||= ad.automatic === true;
      names.add(filename); rows.set(filename, row);
    }
  }
  return [...rows.values()].sort((left, right) => left.filename.localeCompare(right.filename, 'zh-CN'));
});
function selectAds(selected: boolean, filename?: string) {
  if (draftLocked.value) return;
  for (const item of items.value.filter(isSelected)) {
    const action = actionFor(item), approved = new Set(action.approvedAds ?? []);
    for (const ad of item.ads) if (filename === undefined || adFilename(ad.relativePath) === filename) {
      if (selected) approved.add(ad.relativePath); else approved.delete(ad.relativePath);
    }
    action.approvedAds = [...approved];
  }
  adsChecked.value = false;
}
function initialAds(item: AdmissionItem): string[] {
  // Re-reading a draft, a historical suggestion or a retry never grants new approval.
  // Apply the global defaults only to an explicit new admission selection; retain cancellations thereafter.
  return isSelected(item) ? [...(actionFor(item).approvedAds ?? [])] : item.ads.filter(ad => ad.automatic).map(ad => ad.relativePath);
}
const selectionError = computed(() => {
  const primaryGroups=new Set<string>();
  for(const item of items.value) {
    const action=actionFor(item);
    if(action.action==='existing'&&!action.workId)return `请为“${item.displayTitle}”选择已有作品，或改为暂缓。`;
    const peer=action.action==='same-as'?items.value.find(other=>other.key===action.sameAsKey):null;
    if(action.action==='same-as'&&(!peer||!['new','existing'].includes(actionFor(peer).action)))return `请为“${item.displayTitle}”选择本批明确接纳的同套目录，或改为暂缓。`;
    if(action.primary&&isSelected(item)){
      const root=peer?actionFor(peer):action;
      const groupKey=root.action==='existing'?`work:${root.workId}`:root.key;
      if(primaryGroups.has(groupKey))return '同一套作品只能明确选择一个主副本，请取消重复的主副本选择。';
      primaryGroups.add(groupKey);
    }
  }
  return '';
});
const storageKey = (id: string) => `cosgallery:admission:pending:${id}`;
function rememberPending(value: AdmissionExecuteInput | null) { pending.value=value; if(!batch.value) return; try { if(value) localStorage.setItem(storageKey(batch.value.id),JSON.stringify(value)); else localStorage.removeItem(storageKey(batch.value.id)); } catch { notice.value='浏览器不能保存重试凭据，请保留本页直到确认服务端已接收；服务端批次和检查点仍会持久保留。'; } }
function restorePending() { pending.value=null; if(!batch.value) return; try { const raw=localStorage.getItem(storageKey(batch.value.id)); if(!raw) return; const parsed: unknown=JSON.parse(raw); if(!parsed||typeof parsed!=='object'||!('requestKey' in parsed)||typeof parsed.requestKey!=='string'||!('confirmed' in parsed)||parsed.confirmed!==true||!('actions' in parsed)||!Array.isArray(parsed.actions)||!('acceptExistingVersion' in parsed)||typeof parsed.acceptExistingVersion!=='boolean') return; const safeActions: AdmissionAction[]=[]; for(const value of parsed.actions) { if(!value||typeof value!=='object'||typeof value.key!=='string'||!['new','existing','same-as','skip','defer'].includes(value.action)) return; safeActions.push(value as AdmissionAction); } pending.value={requestKey:parsed.requestKey,confirmed:true,actions:safeActions,acceptExistingVersion:parsed.acceptExistingVersion,...('adsConfirmed' in parsed&&parsed.adsConfirmed===true?{adsConfirmed:true}:{})}; acceptExistingVersion.value=pending.value.acceptExistingVersion; for(const action of safeActions) actions[action.key]=action; } catch { /* A malformed local retry copy cannot authorize execution. */ } }
function changeAction(item: AdmissionItem,event: Event) { if(draftLocked.value)return; const value=(event.target as HTMLSelectElement).value; if(!['new','existing','same-as','skip','defer'].includes(value))return; const approvedAds=['new','existing','same-as'].includes(value)?initialAds(item):[]; actions[item.key]={key:item.key,action:value as AdmissionActionKind,displayTitle:item.displayTitle,approvedAds,acceptSourceIds:[],primary:false}; adsChecked.value=false; }
function selectWork(item: AdmissionItem,work: AdmissionWork) { if(draftLocked.value)return; actions[item.key]={...actionFor(item),approvedAds:initialAds(item),action:'existing',workId:work.workId,primary:false,acceptSourceIds:[],reason:'用户在确认页选择对应已有作品'}; selectedWorks[item.key]=work; pickerKey.value=null; }
function confirmNewGroup() { if(draftLocked.value)return; for(const item of items.value.filter(item=>item.group==='A')) actions[item.key]={key:item.key,action:'new',displayTitle:item.displayTitle,approvedAds:initialAds(item),acceptSourceIds:[],reason:'用户在确认页选择新独立作品'}; adsChecked.value=false; }
function stopPoll() { if(timer)clearTimeout(timer); timer=undefined; }
function schedulePoll() { stopPoll(); if(!active.value||disposed||pollFailures.value>=3)return; timer=setTimeout(()=>void refreshBatch(true),2500); }
async function loadItems(id: string, current = generation) {
  itemsLoading.value=true;
  try {
    const all: AdmissionItem[]=[];let next=1,total=Infinity;
    while(all.length<total) {
      const result=await api.fetchAdmissionItems(id,next++,100);
      if(current!==generation||disposed)return;
      all.push(...result.items);total=result.total;if(!result.items.length)break;
    }
    if(current!==generation||disposed)return;
    items.value=all;
    for(const item of all) {
      if(actions[item.key]) {
        if(batch.value?.state==='draft'&&!pending.value) {
          const allowed=new Set(item.ads.map(ad=>ad.relativePath));
          actions[item.key].approvedAds=(actions[item.key].approvedAds??[]).filter(relativePath=>allowed.has(relativePath));
        }
        continue;
      }
      const suggestion=batch.value?.state==='draft'?item.suggestedAction:undefined;
      const suggestedWork=suggestion?.action==='existing'?item.candidates.find(work=>work.workId===suggestion.workId):undefined;
      if(suggestion&&(suggestion.action!=='existing'||suggestedWork)) {
        actions[item.key]={...suggestion,key:item.key,displayTitle:suggestion.displayTitle??item.displayTitle,
          approvedAds:[...(suggestion.approvedAds??[])],acceptSourceIds:[...(suggestion.acceptSourceIds??[])]};
        if(suggestedWork)selectedWorks[item.key]=suggestedWork;
      } else actions[item.key]={key:item.key,action:'defer',displayTitle:item.displayTitle,approvedAds:[],acceptSourceIds:[],primary:false};
    }
  } finally {if(current===generation)itemsLoading.value=false;}
}
async function loadRecent() { const current=generation,id=creatorId.value;try { const result=await api.fetchAdmissionBatches(id); if(!disposed&&current===generation&&id===creatorId.value)recent.value=result.items; } catch(cause) { if(current!==generation||disposed)return;error.value=cause instanceof Error?cause.message:'批次列表读取失败'; } }
async function browse(next?: string) { if(busy.value)return; directoryLoading.value=true; error.value=''; const current=generation, request=++directoryRequest; try { const result=await api.fetchAdmissionDirectories(creatorId.value,next); if(current!==generation||request!==directoryRequest||disposed)return; directories.value=result; creatorName.value=result.creator.name; parent.value=next??''; selectedNames.value=[]; filesReady.value=false; } catch(cause) { if(current===generation&&request===directoryRequest)error.value=cause instanceof Error?cause.message:'目录读取失败'; } finally { if(current===generation&&request===directoryRequest)directoryLoading.value=false; } }
function selectAll() { selectedNames.value=directories.value?.items.filter(dir=>dir.selectable).map(dir=>dir.name)??[]; }
async function saveRoot() { busy.value=true; error.value=''; try { settings.value=await api.saveAdmissionSettings(waitingRoot.value); } catch(cause) { error.value=cause instanceof Error?cause.message:'等待区设置失败'; } finally { busy.value=false; } if(!error.value)await browse(); }
async function loadSources(next=1) { const current=generation,id=creatorId.value;try { const result=await fetchSourceEvidence(id,next);if(current!==generation||disposed)return; const confirmed=result.items.filter(source=>source.identityState==='confirmed'&&source.creatorId===creatorId.value); sources.value=next===1?confirmed:[...sources.value,...confirmed]; sourcePage.value=next; sourceHasMore.value=next*result.limit<result.total; } catch(cause) { if(current!==generation||disposed)return;notice.value=`可选来源资料暂时无法读取，可先本地接纳：${cause instanceof Error?cause.message:'网络错误'}`; } }
async function openBatch(id: string) { error.value=''; stopPoll(); const current=++generation;batch.value=null;items.value=[];directories.value=null;filesReady.value=false;pending.value=null;page.value=1;group.value='all';confirmChecked.value=false;adsChecked.value=false; try { const result=await api.fetchAdmissionBatch(id); if(current!==generation||disposed)return; if(result.creatorId!==creatorId.value)throw new Error('批次不属于当前博主'); batch.value=result;repreviewKeys.value=[]; creatorName.value=result.creatorName; for(const key of Object.keys(actions))delete actions[key]; for(const key of Object.keys(selectedWorks))delete selectedWorks[key]; await loadItems(id,current); if(current!==generation||disposed)return;restorePending(); if(result.state!=='draft')rememberPending(null); await router.replace({query:{...route.query,batch:id}}); pollFailures.value=0;schedulePoll(); } catch(cause) { if(current===generation)error.value=cause instanceof Error?cause.message:'批次读取失败'; } }
async function refreshBatch(poll=false) { if(!batch.value)return; const id=batch.value.id,current=generation; try { const result=await api.fetchAdmissionBatch(id); if(current!==generation||disposed)return; const changed=batch.value.updatedAt!==result.updatedAt||batch.value.state!==result.state||batch.value.totals.completed!==result.totals.completed;batch.value=result; pollFailures.value=0; if(result.state!=='draft')rememberPending(null); if(result.state!=='draft'&&(!poll||changed))await loadItems(id,current); schedulePoll(); } catch(cause) { if(current!==generation)return; pollFailures.value++; if(!poll||pollFailures.value>=3)error.value=cause instanceof Error?cause.message:'状态读取失败'; schedulePoll(); } }
async function preview() {
  if(busy.value)return; const token=++mutationToken; busy.value=true;error.value='';
  try {
    const result=await api.createAdmissionPreview({creatorId:creatorId.value,parent:parent.value,directories:[...selectedNames.value],acceptExistingVersion:acceptExistingVersion.value,...(sourceEvidenceId.value?{sourceEvidenceId:sourceEvidenceId.value}:{})});
    if(disposed||token!==mutationToken)return;
    await openBatch(result.id);if(!disposed&&token===mutationToken)await loadRecent();
  }catch(cause){if(!disposed&&token===mutationToken)error.value=cause instanceof Error?cause.message:'预览失败';}
  finally{if(!disposed&&token===mutationToken)busy.value=false;}
}
async function execute() {
  if(!batch.value||busy.value)return; const token=++mutationToken,id=batch.value.id;busy.value=true;error.value='';
  try {
    const input=pending.value??{requestKey:crypto.randomUUID(),confirmed:true as const,acceptExistingVersion:acceptExistingVersion.value,actions:items.value.map(item=>{const action=actionFor(item);return {...action,approvedAds:isSelected(item)?action.approvedAds:[],acceptSourceIds:acceptExistingVersion.value&&action.action==='existing'?action.acceptSourceIds:[],reason:action.reason||`用户在网页确认页选择：${actionLabels[action.action]}`};}),...(adsCount.value?{adsConfirmed:true as const}:{})};
    rememberPending(input);const result=await api.executeAdmission(id,input);
    if(disposed||token!==mutationToken)return;
    batch.value=result;rememberPending(null);showConfirmation.value=false;await loadItems(id);schedulePoll();await loadRecent();
  }catch(cause){
    if(disposed||token!==mutationToken)return;
    error.value=cause instanceof Error?cause.message:'执行回执未确认';
    if(cause instanceof RequestError&&[400,403,404,409,422].includes(cause.status))rememberPending(null);
  }finally{if(!disposed&&token===mutationToken)busy.value=false;}
}
async function resume() {
  if(!batch.value||busy.value)return;const token=++mutationToken,id=batch.value.id,key=`${storageKey(id)}:resume`;busy.value=true;error.value='';
  let requestKey:string;
  try {requestKey=localStorage.getItem(key)||crypto.randomUUID();localStorage.setItem(key,requestKey);}catch{requestKey=crypto.randomUUID();}
  try {
    const result=await api.resumeAdmission(id,{requestKey,confirmed:true});
    try{localStorage.removeItem(key);}catch{/* The acknowledged receipt is also persisted server-side. */}
    if(disposed||token!==mutationToken)return;
    batch.value=result;showResume.value=false;pollFailures.value=0;schedulePoll();
  }catch(cause){
    if(cause instanceof RequestError&&[400,403,404,409,422].includes(cause.status)){try{localStorage.removeItem(key);}catch{/* No business write was accepted. */}}
    if(!disposed&&token===mutationToken)error.value=cause instanceof Error?cause.message:'继续失败';
  }finally{if(!disposed&&token===mutationToken)busy.value=false;}
}
async function repreview() {
  if(!batch.value||busy.value)return;const token=++mutationToken,id=batch.value.id;busy.value=true;error.value='';
  try {
    const keys=repreviewKeys.value.filter(key=>items.value.some(item=>item.key===key&&isUnstarted(item)));
    if(!keys.length)throw new Error('没有待重新预览的目录');
    const result=await api.repreviewAdmission(id,keys);
    if(disposed||token!==mutationToken)return;
    await openBatch(result.id);if(!disposed&&token===mutationToken)await loadRecent();
  }catch(cause){if(!disposed&&token===mutationToken)error.value=cause instanceof Error?cause.message:'重新预览失败';}
  finally{if(!disposed&&token===mutationToken)busy.value=false;}
}
async function startNew() { stopPoll();generation++;batch.value=null;items.value=[];pending.value=null;acceptExistingVersion.value=false;confirmChecked.value=false;adsChecked.value=false;showConfirmation.value=false;await router.replace({query:{...route.query,batch:undefined}});await browse(); }
watch(group,()=>{page.value=1;});
watch(()=>route.query.batch,id=>{if(typeof id==='string'&&id!==batch.value?.id){mutationToken++;busy.value=false;void openBatch(id);}else if(id===undefined&&batch.value){mutationToken++;busy.value=false;void startNew();}});
watch(()=>route.params.creatorId,async()=>{
  const current=++generation;mutationToken++;stopPoll();busy.value=false;showConfirmation.value=false;showResume.value=false;
  batch.value=null;items.value=[];creatorName.value='';directories.value=null;parent.value='';selectedNames.value=[];filesReady.value=false;
  recent.value=[];sources.value=[];sourcePage.value=1;sourceHasMore.value=false;pending.value=null;pickerKey.value=null;
  acceptExistingVersion.value=false;confirmChecked.value=false;adsChecked.value=false;error.value='';notice.value='';
  for(const key of Object.keys(actions))delete actions[key];
  for(const key of Object.keys(selectedWorks))delete selectedWorks[key];
  if(!Number.isSafeInteger(creatorId.value)||creatorId.value<=0){error.value='请从博主库选择一位规范博主进入本地导入';return;}
  sourceEvidenceId.value=Number(route.query.sourceEvidenceId)>0?Number(route.query.sourceEvidenceId):null;
  try {
    const result=await api.fetchAdmissionSettings();if(current!==generation||disposed)return;
    settings.value=result;waitingRoot.value=result.waitingRoot;
    await Promise.all([loadRecent(),loadSources()]);if(current!==generation||disposed)return;
    const id=typeof route.query.batch==='string'?route.query.batch:'';
    if(id)await openBatch(id);else await browse();
  }catch(cause){if(current===generation&&!disposed)error.value=cause instanceof Error?cause.message:'初始化失败';}
},{immediate:true});
onBeforeUnmount(()=>{disposed=true;mutationToken++;generation++;stopPoll();});
</script>

<style scoped>
.batch-ads{border:1px solid #8883;border-radius:.85rem;padding:1rem;margin:1rem 0}.ad-summary-row{display:flex;align-items:center;justify-content:space-between;gap:.8rem;flex-wrap:wrap;border-top:1px solid #8883;padding:.45rem 0;overflow-wrap:anywhere}.ad-summary-row small{display:block}.ad-summary-row .actions{margin:.2rem 0}
.admission-page{max-width:90rem;margin:auto;padding:1rem 1.5rem 5rem;color:var(--text,inherit)}header,.section-heading{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}header{margin-bottom:1.5rem}h1{font-size:1.8rem;margin:.3rem 0}h2{font-size:1.15rem;margin:0 0 .8rem}h3{font-size:1.03rem;margin:.6rem 0}.eyebrow{font-size:.7rem;letter-spacing:.18em;opacity:.65}.panel{background:var(--surface,#fff);border:1px solid #8883;border-radius:1.1rem;padding:1.35rem;margin-bottom:1.2rem}.actions,form{display:flex;flex-wrap:wrap;align-items:end;gap:.65rem;margin:.8rem 0}button,input,select{font:inherit;border:1px solid #8885;border-radius:.6rem;padding:.6rem .85rem;background:var(--bg,#fafafa);color:inherit}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}.primary{background:var(--accent,#7764b0);color:white;border-color:transparent}.hint,small{font-size:.8rem;line-height:1.6;opacity:.76}.error{color:#bb2938;white-space:pre-wrap}.warning{color:#996211;background:#eeaa1110;padding:.6rem;border-radius:.5rem}label{display:grid;gap:.4rem;margin:.7rem 0}.check{display:flex;align-items:flex-start;gap:.6rem;line-height:1.65}.check input{margin-top:.35rem}.directory-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(20rem,1fr));gap:.6rem;margin:1rem 0;max-height:30rem;overflow:auto}.directory-list button{text-align:left;display:grid;gap:.35rem}.directory-row{display:flex;align-items:center;border:1px solid #8883;padding:.7rem;margin:0;border-radius:.6rem;gap:.7rem}.directory-row small{display:block}.item-card{padding:1rem;border:1px solid #8883;border-radius:.85rem;margin:1rem 0}.badge{font-size:.73rem;opacity:.75}.path,dd{overflow-wrap:anywhere}.path{font-size:.83rem;opacity:.8}fieldset{border:0;padding:0;margin:0}.work-selection{display:flex;gap:.8rem;margin:.8rem 0}.work-selection img{width:3.5rem;aspect-ratio:2/3;object-fit:cover;border-radius:.3rem}.recent ul{display:flex;flex-wrap:wrap;gap:.4rem;list-style:none;padding:0}.recent button[aria-pressed=true]{border-color:#7764b0}dl{display:grid;grid-template-columns:8rem 1fr;gap:.5rem;font-size:.85rem}dd{margin:0}summary{cursor:pointer}details{margin:.8rem 0}table{width:100%;border-collapse:collapse;font-size:.85rem}th,td{text-align:left;padding:.7rem;border-bottom:1px solid #8883}td a{display:block;margin:.4rem 0}.overlay{position:fixed;inset:0;z-index:100;background:#0007;display:flex;align-items:center;justify-content:center;padding:1.2rem}.confirmation{background:var(--surface,#fff);padding:1.5rem;border-radius:1rem;max-width:60rem;width:100%;max-height:90vh;overflow:auto}.confirmation-list{max-height:40vh;overflow:auto}.confirmation-list article{display:grid;gap:.35rem;padding:.6rem 0;border-bottom:1px solid #8883;overflow-wrap:anywhere}a{color:var(--accent,#7764b0)}@media(max-width:600px){.admission-page{padding:.5rem}.directory-list{grid-template-columns:1fr}dl{grid-template-columns:1fr}.panel{padding:1rem}}
</style>
<style scoped>
.admission-page,.panel,.item-card,fieldset,.directory-list{min-width:0}.directory-row span,td{overflow-wrap:anywhere}table{table-layout:fixed}.work-selection div{min-width:0}.actions label{min-width:0;max-width:100%}input,select,textarea{max-width:100%}header a{white-space:nowrap}
</style>
