<template>
  <details class="source-evidence" :open="expanded" @toggle="toggle">
    <summary>来源资料 · 原文留存与本地接纳</summary>
    <div v-if="expanded" class="panel-body">
      <p class="hint">仅查看 #{{ creator.id }} {{ creator.name }}。资料保存、作品接纳与精确补缺分别确认；保存资料不创建作品、不运行来源检查或网盘操作。</p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <div class="actions"><button type="button" :disabled="loading || busy" @click="refresh">刷新资料</button><button type="button" :disabled="busy" @click="manualOpen = !manualOpen">{{ manualOpen ? '收起登记' : '手工登记来源资料' }}</button></div>
      <form v-if="manualOpen" class="evidence-form" aria-label="手工登记来源资料" @submit.prevent="save" @keydown="preventManualImplicitSubmit">
        <p class="hint">可登记 Costuan、ecytt、sndiary 等实际来源，不访问网站。不填写 Cookie、登录令牌、提取码或密码；受保护的分享凭据继续使用原通道。</p>
        <fieldset :disabled="busy || !!pendingSave">
          <label>来源平台<input v-model="draft.platform" required maxlength="60" pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*" placeholder="实际平台标识，如 ecytt、sndiary、costuan" /></label>
          <label>页面链接<input v-model="draft.pageUrl" required maxlength="2000" type="url" placeholder="https://…" /></label>
          <label>页面原标题<input v-model="draft.pageTitle" maxlength="1000" /></label>
          <label>原始目录文本<textarea v-model="draft.rawDirectoryText" rows="6" maxlength="100000" placeholder="可为空；保留范围、未编号和未知行，不需要逐行补博主名" /></label>
          <label>资源入口（可选，每行一个不含密钥的 URL）<textarea v-model="draft.resourceLines" rows="2" maxlength="16000" /></label>
          <label>本批说明<textarea v-model="draft.notes" rows="2" maxlength="4000" placeholder="例如：用户手工获取并解压，尚未逐套关联" /></label>
        </fieldset>
        <p v-if="pendingSave" class="hint">保存回执尚未确认。重试会提交同一请求及原始内容，不另建一份。{{ pendingPersisted ? '刷新页面后仍可重试。' : '浏览器会话存储不可用；请留在本页重试，不要关闭页面。' }}</p>
        <button type="submit" :disabled="busy">{{ pendingSave ? '重试确认原资料保存' : '保存来源资料（不执行获取）' }}</button>
      </form>
      <p v-if="loading">正在读取来源资料…</p>
      <p v-else-if="list && !list.items.length">尚无来源资料，可先手工登记页面；无需先创建作品。</p>
      <ul class="evidence-list">
        <li v-for="record in list?.items" :key="record.id">
          <button type="button" :disabled="busy" :aria-pressed="selected?.id === record.id" @click="select(record.id)">
            <strong>#{{ record.id }} {{ record.pageTitle || record.platform }}</strong>
            <span>{{ record.platform }} · {{ identityLabel(record.identityState) }} · {{ completenessLabel(record.completeness) }} · {{ formatTime(record.observedAt) }}</span>
          </button>
        </li>
      </ul>
      <div v-if="list && list.total > 20" class="actions"><button type="button" :disabled="page <= 1 || loading || busy" @click="changePage(page - 1)">上一页资料</button><span>第 {{ page }} 页 · 共 {{ list.total }} 份</span><button type="button" :disabled="page * list.limit >= list.total || loading || busy" @click="changePage(page + 1)">下一页资料</button></div>
      <p v-if="detailLoading">正在读取资料详情…</p>
      <article v-if="selected" class="evidence-detail" aria-label="来源资料详情">
        <h4>{{ selected.pageTitle || selected.platform }} · 资料 #{{ selected.id }}</h4>
        <div class="actions"><button type="button" @click="copyId">复制资料 ID</button></div>
        <p>{{ identityLabel(selected.identityState) }} · {{ completenessLabel(selected.completeness) }} · {{ selected.method === 'manual' ? '手工登记' : '插件观察' }} · {{ formatTime(selected.observedAt) }}</p>
        <p class="hint">{{ selected.identityReason }}。资料留存不是完整目录核验，也不是入库、暂存或本地满足。</p>
        <dl><dt>页面位置（纯文本）</dt><dd>{{ selected.pageUrl }}</dd><dt>批次备注</dt><dd>{{ selected.notes || '未填写' }}</dd></dl>
        <ul v-if="selected.resourceEntries.length" class="raw-list"><li v-for="(entry, index) in selected.resourceEntries" :key="index">{{ entry.label }} {{ entry.url }}</li></ul>
        <ul v-if="selected.diagnostics.length" class="raw-list"><li v-for="(message, index) in selected.diagnostics" :key="index">{{ message }}</li></ul>
        <details><summary>原始目录 · 纯文本</summary><pre>{{ selected.rawDirectoryText || '未提供目录文本' }}</pre></details>
        <details open><summary>解析结果 · {{ selected.parsedEntries.length }} 条，范围不自动展开</summary>
          <ol class="entry-list"><li v-for="entry in selected.parsedEntries" :key="entry.key"><strong>{{ entryLabel(entry.state) }}</strong> · 第 {{ entry.lineNumber }} 行 <span v-if="entry.range"> · {{ entry.range.first }}～{{ entry.range.last }}（{{ entry.range.count }} 个编号，不等于独立作品）</span><pre>{{ entry.raw }}</pre><p v-for="(message, index) in entry.diagnostics" :key="index" class="hint">{{ message }}</p></li></ol>
          <p v-if="!selected.parsedEntries.length" class="hint">暂无可解析条目；有明确页面也可以留存资料，再准备已分套的本地目录。</p>
        </details>
        <form v-if="selected.identityState === 'candidate'" class="evidence-form" aria-label="确认具体页面归属" @submit.prevent="confirmIdentity">
          <p>仅确认这份 {{ selected.platform }} 页面证据属于 #{{ creator.id }} {{ creator.name }}，不添加全局别名、不确认每套对应。</p>
          <label>归属确认依据<textarea v-model="identityReason" required maxlength="2000" :disabled="busy || pendingIdentity?.id === selected.id" /></label>
          <p v-if="pendingIdentity?.id === selected.id" class="hint">原确认回执尚未确认；再次提交沿用原依据及版本。</p>
          <label class="check"><input v-model="identityChecked" type="checkbox" :disabled="busy" />我已核对当前页面和证据，确认上述博主归属</label>
          <button :disabled="busy || !identityChecked || !identityReason.trim()">确认当前证据归属</button>
        </form>
        <p v-else-if="selected.identityState === 'conflict'" class="error">身份冲突：保留资料，不允许在这里强制改绑或据此接纳。需先核对相冲突的具体页面身份。</p>
        <template v-if="selected.identityState === 'confirmed' && selected.creatorId === creator.id">
          <div class="actions"><a :href="`/creator-admission/local/${creator.id}?sourceEvidenceId=${selected.id}`">准备本地接纳</a></div>
          <p class="hint">进入本地导入页面选择已解压目录、查看预览并集中确认。博主及本份资料自动带入；批次来源不自动满足下载需求。</p>
          <details class="admission-handoff"><summary>高级维护：下载 CLI 预览 scope</summary>
            <p class="hint">正常入库使用上方网页入口；以下保留为已有 CLI 的高级范围导出。</p>
            <form class="evidence-form" aria-label="准备本地接纳预览" @submit.prevent="downloadScope">
              <label>已解压作品所在父目录<input v-model="scopeRoot" required placeholder="本机绝对路径" /></label>
              <label>本批一级作品目录（一行一个原名）<textarea v-model="scopeDirectories" required rows="4" placeholder="保留目录原名，不要填写子路径" /></label>
              <label class="check"><input v-model="acceptExistingVersion" type="checkbox" />本批接受已有可用本地版本，并允许以后可靠来源关联；不表示逐字节一致或已确认具体来源</label>
              <p class="hint">规范博主和资料 ID 自动带入。localOnly:false；scope 及后续预览保持 confirmed:false。仅下载范围文件，不执行磁盘操作。</p>
              <button :disabled="busy">下载只读预览 scope</button>
            </form>
          </details>
          <details><summary>已有关联与后补批次来源 · {{ selected.links.length }} 项</summary>
            <p class="hint">批次关联仅说明文件来自此页，不等于精确外部编号对应，也不标记 local_satisfied。已完成计划不会被改写。</p>
            <ul class="raw-list"><li v-for="link in selected.links" :key="link.id">Work #{{ link.workId }}<template v-if="link.localWorkId"> · LocalWork #{{ link.localWorkId }}</template><template v-if="link.planId"> · 接纳计划 {{ link.planId }}</template> · {{ link.reason }}</li></ul>
            <p v-if="!selected.links.length">还没有接纳去向或后补关联。</p>
            <form class="evidence-form" aria-label="后补已有作品批次来源" @submit.prevent="linkExisting">
              <label>已有 Work ID<input v-model="linkWorkId" required type="number" min="1" step="1" :disabled="busy || !!pendingLink" /></label>
              <label>已有 LocalWork ID（可选）<input v-model="linkLocalWorkId" type="number" min="1" step="1" :disabled="busy || !!pendingLink" /></label>
              <label>批次来源依据<textarea v-model="linkReason" required maxlength="2000" :disabled="busy || !!pendingLink" /></label>
              <label class="check"><input v-model="linkChecked" type="checkbox" :disabled="busy || !!pendingLink" />确认此已有作品来自本份资料，不申请精确满足或移动文件</label>
              <button :disabled="busy || (!pendingLink && (!linkChecked || !linkReason.trim()))">{{ pendingLink ? '重试原批次关联' : '保存已有作品批次来源' }}</button>
            </form>
          </details>
          <details><summary>精确条目对应 · {{ selected.entryMappings.length }} 项</summary>
            <p class="hint">仅关联已有 Work。可选已有 SourceWork 必须与该 Work、当前博主及来源页面一致，不能改绑或强行合并。无 SourceWork 时只保存条目对应证据；范围可关联多套，但不宣称整个合集满足。此操作不接受版本、不核销任务。</p>
            <ul class="raw-list"><li v-for="mapping in selected.entryMappings" :key="mapping.id">{{ mapping.entryKey }} → Work #{{ mapping.workId }}<template v-if="mapping.sourceWorkId"> · SourceWork #{{ mapping.sourceWorkId }}</template> · {{ mapping.reason }}</li></ul>
            <form v-if="selected.parsedEntries.some(entry => entry.state === 'candidate' || entry.state === 'range')" class="evidence-form" aria-label="确认已有作品条目对应" @submit.prevent="mapEntry">
              <label>具体条目<select v-model="mappingEntryKey" required :disabled="busy || !!pendingMapping"><option value="">选择已解析的具体条目</option><option v-for="entry in selected.parsedEntries.filter(item => item.state === 'candidate' || item.state === 'range')" :key="entry.key" :value="entry.key">第 {{ entry.lineNumber }} 行 · {{ entry.title }}</option></select></label>
              <label>已有 Work ID<input v-model="mappingWorkId" required type="number" min="1" step="1" :disabled="busy || !!pendingMapping" /></label>
              <label>已有 SourceWork ID（可选，不能填写 Work ID）<input v-model="mappingSourceWorkId" type="number" min="1" step="1" :disabled="busy || !!pendingMapping" /></label>
              <label>明确对应依据<textarea v-model="mappingReason" required maxlength="2000" :disabled="busy || !!pendingMapping" /></label>
              <label class="check"><input v-model="mappingChecked" type="checkbox" :disabled="busy || !!pendingMapping" />确认所选条目与已有作品对应；不是凭同名或数量猜测</label>
              <button :disabled="busy || (!pendingMapping && (!mappingChecked || !mappingReason.trim() || !mappingEntryKey))">{{ pendingMapping ? '重试原条目对应' : '保存已有作品条目对应' }}</button>
            </form>
          </details>
        </template>
      </article>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import * as api from '../api/source-evidence';
import { RequestError } from '../api/http';
import type { SaveSourceEvidenceInput, ConfirmSourceEvidenceInput, LinkSourceEvidenceInput, MapSourceEvidenceEntryInput, SourceEvidenceObservation, SourceEvidencePage } from '../api/source-evidence';

const props = defineProps<{ creator: { id: number; name: string } }>();
const expanded = ref(false), loading = ref(false), detailLoading = ref(false), busy = ref(false), manualOpen = ref(false);
const list = ref<SourceEvidencePage | null>(null), selected = ref<SourceEvidenceObservation | null>(null);
const page = ref(1), error = ref(''), notice = ref('');
const draft = reactive({ platform: '', pageUrl: '', pageTitle: '', rawDirectoryText: '', notes: '', resourceLines: '' });
const pendingSave = ref<SaveSourceEvidenceInput | null>(null);
const pendingIdentity = ref<{ id: number; input: ConfirmSourceEvidenceInput } | null>(null);
const pendingLink = ref<{ id: number; input: LinkSourceEvidenceInput } | null>(null);
const pendingMapping = ref<{ id: number; input: MapSourceEvidenceEntryInput } | null>(null);
const pendingPersisted = ref(true);
const identityReason = ref(''), identityChecked = ref(false);
const scopeRoot = ref(''), scopeDirectories = ref(''), acceptExistingVersion = ref(false);
const linkWorkId = ref<number | string>(''), linkLocalWorkId = ref<number | string>(''), linkReason = ref(''), linkChecked = ref(false);
const mappingEntryKey = ref(''), mappingWorkId = ref<number | string>(''), mappingSourceWorkId = ref<number | string>(''), mappingReason = ref(''), mappingChecked = ref(false);
let generation = 0, listRequest = 0, detailRequest = 0;
const identityLabel = (state: string) => ({ confirmed: '归属已确认', candidate: '归属待确认', conflict: '身份冲突' }[state] ?? state);
const completenessLabel = (state: string) => state === 'partial' ? '部分资料 · 非完整核验' : '完整性未知';
const entryLabel = (state: string) => ({ candidate: '单套候选 · 未映射', range: '范围 / 合集 · 内部待确认', unknown: '未解释文本', conflict: '条目冲突' }[state] ?? state);
const formatTime = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false }); };
const key = (creatorId = props.creator.id) => `cosgallery:source-evidence:pending:${creatorId}`;
function preventManualImplicitSubmit(event: KeyboardEvent) {
  // Only suppress the input's implicit submit, not IME confirmation, textarea
  // line breaks or keyboard activation of the explicit save button.
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement && !event.isComposing && event.keyCode !== 229) event.preventDefault();
}
function persist() {
  try {
    if (pendingSave.value || pendingIdentity.value || pendingLink.value || pendingMapping.value) sessionStorage.setItem(key(), JSON.stringify({ save: pendingSave.value, identity: pendingIdentity.value, link: pendingLink.value, mapping: pendingMapping.value }));
    else sessionStorage.removeItem(key());
    pendingPersisted.value = true;
  } catch { pendingPersisted.value = false; }
}
function restorePending() {
  try {
    const pending = JSON.parse(sessionStorage.getItem(key()) ?? 'null');
    if (pending?.save?.creatorId === props.creator.id && pending.save.record?.method === 'manual' && typeof pending.save.requestId === 'string') {
      try {
        api.assertSafeSourceEvidenceInput(pending.save);
        pendingSave.value = pending.save; manualOpen.value = true;
        Object.assign(draft, { ...pending.save.record, resourceLines: pending.save.record.resourceEntries.map((entry: { url: string }) => entry.url).join('\n') });
      } catch {
        pending.save = null; sessionStorage.setItem(key(), JSON.stringify(pending));
        error.value = '浏览器中旧的待重传资料含不安全或无效内容，已移除该份暂存；未发送。请移除凭据后重新登记。';
      }
    }
    for (const type of ['identity', 'link', 'mapping'] as const) {
      if (pending?.[type]?.input?.creatorId !== props.creator.id) continue;
      try {
        api.assertSafeSourceEvidenceText(pending[type].input.reason);
        if (type === 'identity') pendingIdentity.value = pending.identity;
        if (type === 'link') pendingLink.value = pending.link;
        if (type === 'mapping') pendingMapping.value = pending.mapping;
      } catch { pending[type] = null; sessionStorage.setItem(key(), JSON.stringify(pending)); error.value = '已移除浏览器中含疑似凭据的旧确认暂存，未发送；请重新填写不含凭据的依据。'; }
    }
  } catch { /* Invalid saved drafts never cause a submission. */ }
}
function belongs(record: SourceEvidenceObservation) { return record.creatorId === props.creator.id || record.candidateCreatorId === props.creator.id; }
function setSelected(record: SourceEvidenceObservation) {
  if (!belongs(record)) throw new Error('返回资料不属于当前博主范围，未展示');
  selected.value = record;
  identityReason.value = pendingIdentity.value?.id === record.id ? pendingIdentity.value.input.reason : '';
  identityChecked.value = false;
  if (pendingLink.value?.id === record.id) {
    linkWorkId.value = pendingLink.value.input.workId; linkLocalWorkId.value = pendingLink.value.input.localWorkId ?? ''; linkReason.value = pendingLink.value.input.reason;
  } else { linkWorkId.value = ''; linkLocalWorkId.value = ''; linkReason.value = ''; }
  linkChecked.value = false;
  if (pendingMapping.value?.id === record.id) {
    mappingEntryKey.value = pendingMapping.value.input.entryKey; mappingWorkId.value = pendingMapping.value.input.workId; mappingSourceWorkId.value = pendingMapping.value.input.sourceWorkId ?? ''; mappingReason.value = pendingMapping.value.input.reason;
  } else { mappingEntryKey.value = ''; mappingWorkId.value = ''; mappingSourceWorkId.value = ''; mappingReason.value = ''; }
  mappingChecked.value = false;
  scopeRoot.value = ''; scopeDirectories.value = ''; acceptExistingVersion.value = false;
}
function showError(reason: unknown) { error.value = reason instanceof Error ? reason.message : '读取或保存失败，未确认成功'; }
function definitiveFailure(reason: unknown) { return reason instanceof RequestError && reason.status >= 400 && reason.status < 500 && reason.status !== 408; }
async function refresh() {
  const turn = generation, request = ++listRequest;
  loading.value = true; error.value = '';
  try {
    const result = await api.fetchSourceEvidence(props.creator.id, page.value);
    if (turn !== generation || request !== listRequest) return;
    if (result.items.some(record => !belongs(record))) throw new Error('返回列表超出当前博主范围，未展示');
    list.value = result;
  } catch (reason) { if (turn === generation && request === listRequest) showError(reason); }
  finally { if (turn === generation && request === listRequest) loading.value = false; }
}
async function select(id: number) {
  if (busy.value) return;
  const turn = generation, request = ++detailRequest;
  detailLoading.value = true; selected.value = null; error.value = ''; notice.value = '';
  try {
    const result = await api.fetchSourceEvidenceDetail(id);
    if (turn === generation && request === detailRequest) setSelected(result);
  } catch (reason) { if (turn === generation && request === detailRequest) showError(reason); }
  finally { if (turn === generation && request === detailRequest) detailLoading.value = false; }
}
function toggle(event: Event) { expanded.value = (event.currentTarget as HTMLDetailsElement).open; if (expanded.value && !list.value && !loading.value) void refresh(); }
async function changePage(next: number) { page.value = next; await refresh(); }
async function save() {
  if (busy.value) return;
  const turn = generation;
  error.value = ''; notice.value = '';
  try {
    if (!pendingSave.value) {
      const urls = draft.resourceLines.split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
      if (urls.length > 10) throw new Error('资源入口最多 10 个');
      if (![draft.pageUrl.trim(), ...urls].every(value => /^https?:\/\//iu.test(value))) throw new Error('仅接受 HTTP / HTTPS 位置文本，不执行这些链接');
      const input: SaveSourceEvidenceInput = { creatorId: props.creator.id, requestId: crypto.randomUUID(), record: { platform: draft.platform.trim(), pageUrl: draft.pageUrl.trim(), pageTitle: draft.pageTitle.trim(), method: 'manual', rawDirectoryText: draft.rawDirectoryText, notes: draft.notes, resourceEntries: urls.map(url => ({ url, label: '用户记录的资源入口' })), completeness: draft.rawDirectoryText.trim() ? 'partial' : 'unknown' } };
      api.assertSafeSourceEvidenceInput(input);
      pendingSave.value = input;
      persist();
    }
    busy.value = true;
    const result = await api.saveSourceEvidence(pendingSave.value);
    if (turn !== generation) return;
    if (!result.ok || !result.recorded) throw new Error('尚未获得资料保存成功回执');
    if (!belongs(result.observation)) throw new Error('保存回执不属于当前博主范围，保留原请求待确认');
    pendingSave.value = null; persist(); setSelected(result.observation);
    manualOpen.value = false; Object.assign(draft, { platform: '', pageUrl: '', pageTitle: '', rawDirectoryText: '', notes: '', resourceLines: '' });
    notice.value = '来源资料已保存；归属及目录判断见下方。未创建作品、获取任务或执行转存。';
    page.value = 1; await refresh();
  } catch (reason) {
    if (turn === generation) { if (definitiveFailure(reason)) { pendingSave.value = null; persist(); } showError(reason); }
  } finally { if (turn === generation) busy.value = false; }
}
async function confirmIdentity() {
  const record = selected.value;
  if (busy.value || !record || record.identityState !== 'candidate' || !identityChecked.value || !identityReason.value.trim()) return;
  const turn = generation;
  if (pendingIdentity.value && pendingIdentity.value.id !== record.id) { error.value = `资料 #${pendingIdentity.value.id} 仍有待确认的身份回执，请先打开该份资料重试`; return; }
  try { api.assertSafeSourceEvidenceText(identityReason.value); } catch (reason) { showError(reason); return; }
  busy.value = true; error.value = ''; notice.value = '';
  if (!pendingIdentity.value || pendingIdentity.value.id !== record.id) pendingIdentity.value = { id: record.id, input: { creatorId: props.creator.id, requestId: crypto.randomUUID(), reason: identityReason.value.trim(), expectedRevision: record.identityRevision } };
  persist();
  try {
    const result = await api.confirmSourceEvidenceIdentity(record.id, pendingIdentity.value.input);
    if (turn !== generation) return;
    if (!result.ok) throw new Error('尚未获得身份确认回执');
    pendingIdentity.value = null; persist(); setSelected(result.observation);
    notice.value = '仅确认当前来源证据的博主归属；没有新增全局别名或精确作品映射。'; await refresh();
  } catch (reason) { if (turn === generation) { if (definitiveFailure(reason)) { pendingIdentity.value = null; persist(); } showError(reason); } }
  finally { if (turn === generation) busy.value = false; }
}
async function mapEntry() {
  const record = selected.value;
  if (busy.value || !record || record.identityState !== 'confirmed' || record.creatorId !== props.creator.id) return;
  if (!pendingMapping.value && (!mappingChecked.value || !mappingReason.value.trim() || !mappingEntryKey.value)) return;
  const turn = generation;
  error.value = ''; notice.value = '';
  try {
    if (!pendingMapping.value) {
      const workId = Number(mappingWorkId.value), sourceWorkId = mappingSourceWorkId.value === '' ? undefined : Number(mappingSourceWorkId.value);
      if (!Number.isSafeInteger(workId) || workId <= 0 || (sourceWorkId !== undefined && (!Number.isSafeInteger(sourceWorkId) || sourceWorkId <= 0))) throw new Error('请输入准确的已有 Work / SourceWork ID');
      api.assertSafeSourceEvidenceText(mappingReason.value);
      pendingMapping.value = { id: record.id, input: { creatorId: props.creator.id, entryKey: mappingEntryKey.value, workId, ...(sourceWorkId === undefined ? {} : { sourceWorkId }), key: crypto.randomUUID(), reason: mappingReason.value.trim() } }; persist();
    }
    if (pendingMapping.value.id !== record.id) throw new Error(`资料 #${pendingMapping.value.id} 仍有待确认的条目对应回执，请先打开该份资料重试`);
    busy.value = true;
    const result = await api.mapSourceEvidenceEntry(record.id, pendingMapping.value.input);
    if (turn !== generation) return;
    if (!result.ok) throw new Error('尚未获得条目对应回执');
    pendingMapping.value = null; persist();
    const detail = await api.fetchSourceEvidenceDetail(record.id);
    if (turn !== generation) return;
    setSelected(detail); notice.value = '具体条目对应已保存；未接受来源版本、生成获取任务或标记本地满足。';
  } catch (reason) { if (turn === generation) { if (definitiveFailure(reason)) { pendingMapping.value = null; persist(); } showError(reason); } }
  finally { if (turn === generation) busy.value = false; }
}
async function linkExisting() {
  const record = selected.value;
  if (busy.value || !record || record.identityState !== 'confirmed' || record.creatorId !== props.creator.id) return;
  if (!pendingLink.value && (!linkChecked.value || !linkReason.value.trim())) return;
  const turn = generation;
  error.value = ''; notice.value = '';
  try {
    if (!pendingLink.value) {
      const workId = Number(linkWorkId.value), localWorkId = linkLocalWorkId.value === '' ? undefined : Number(linkLocalWorkId.value);
      if (!Number.isSafeInteger(workId) || workId <= 0 || (localWorkId !== undefined && (!Number.isSafeInteger(localWorkId) || localWorkId <= 0))) throw new Error('请输入准确的已有 Work / LocalWork ID');
      api.assertSafeSourceEvidenceText(linkReason.value);
      pendingLink.value = { id: record.id, input: { creatorId: props.creator.id, workId, ...(localWorkId === undefined ? {} : { localWorkId }), key: crypto.randomUUID(), reason: linkReason.value.trim() } }; persist();
    }
    if (pendingLink.value.id !== record.id) throw new Error(`资料 #${pendingLink.value.id} 仍有待确认的关联回执，请先打开该份资料重试`);
    busy.value = true;
    const result = await api.linkSourceEvidenceWork(record.id, pendingLink.value.input);
    if (turn !== generation) return;
    if (!result.ok) throw new Error('尚未获得批次来源关联回执');
    pendingLink.value = null; persist();
    const detail = await api.fetchSourceEvidenceDetail(record.id);
    if (turn !== generation) return;
    setSelected(detail); notice.value = '批次来源已关联已有作品；未修改原计划、移动文件或满足任务。';
  } catch (reason) { if (turn === generation) { if (definitiveFailure(reason)) { pendingLink.value = null; persist(); } showError(reason); } }
  finally { if (turn === generation) busy.value = false; }
}
function downloadScope() {
  const record = selected.value;
  if (!record || record.identityState !== 'confirmed' || record.creatorId !== props.creator.id) return;
  error.value = '';
  try {
    const scope = api.createSourceEvidenceScope({ creatorId: props.creator.id, sourceEvidenceId: record.id, inputRoot: scopeRoot.value, directoryLines: scopeDirectories.value, acceptExistingVersion: acceptExistingVersion.value });
    const url = URL.createObjectURL(new Blob([JSON.stringify(scope, null, 2) + '\n'], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `source-evidence-${record.id}-preview-scope.json`; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice.value = '已生成 confirmed:false 的 preview scope。下一步交给原 CLI 预览；尚未读取或移动本机文件。';
  } catch (reason) { showError(reason); }
}
async function copyId() {
  const id = selected.value?.id, turn = generation;
  if (id === undefined) return;
  try { await navigator.clipboard.writeText(String(id)); if (turn === generation && selected.value?.id === id) notice.value = `已复制资料 ID ${id}`; }
  catch { if (turn === generation && selected.value?.id === id) notice.value = `未能自动复制，请手工复制资料 ID：${id}`; }
}
watch(() => props.creator.id, () => {
  generation++; listRequest++; detailRequest++; list.value = null; selected.value = null; page.value = 1;
  loading.value = false; detailLoading.value = false; busy.value = false; error.value = ''; notice.value = '';
  pendingSave.value = null; pendingIdentity.value = null; pendingLink.value = null; pendingMapping.value = null; manualOpen.value = false;
  Object.assign(draft, { platform: '', pageUrl: '', pageTitle: '', rawDirectoryText: '', notes: '', resourceLines: '' });
  restorePending(); if (expanded.value) void refresh();
}, { immediate: true });
const hasUnsavedChanges = computed(() => !!(pendingSave.value || pendingIdentity.value || pendingLink.value || pendingMapping.value
  || (manualOpen.value && Object.values(draft).some(value => value.trim())) || identityReason.value.trim()
  || linkReason.value.trim() || mappingReason.value.trim() || scopeRoot.value.trim() || scopeDirectories.value.trim()));
defineExpose({ hasUnsavedChanges, isBusy: busy });
onBeforeUnmount(() => { generation++; });
</script>

<style scoped>
.evidence-form select{width:100%;min-width:0;box-sizing:border-box;padding:.5rem;border:1px solid var(--border);border-radius:.4rem;background:var(--surface);color:var(--text);font:inherit}
.source-evidence{margin-top:1rem;padding:.8rem;border:1px solid var(--border);border-radius:.6rem;overflow-wrap:anywhere}.source-evidence summary{cursor:pointer;font-weight:600}.panel-body{display:grid;gap:.8rem;margin-top:.8rem}.hint{font-size:.88rem;color:var(--muted)}.error{color:var(--danger,#c44)}.actions{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}button{padding:.45rem .7rem;border:1px solid var(--border);border-radius:.5rem;background:var(--surface);color:var(--text);cursor:pointer}button:disabled{opacity:.5;cursor:default}.evidence-list,.entry-list,.raw-list{margin:0;padding:0;list-style:none}.evidence-list li+li{margin-top:.45rem}.evidence-list button{display:grid;gap:.2rem;text-align:left;width:100%;overflow-wrap:anywhere}.evidence-list button[aria-pressed=true]{border-color:var(--accent,#847)}.evidence-list span{font-size:.8rem}.evidence-form,.evidence-form fieldset{display:grid;gap:.65rem}.evidence-form fieldset{border:0;padding:0;min-width:0}.evidence-form label{display:grid;gap:.25rem}.evidence-form input,.evidence-form textarea{width:100%;min-width:0;box-sizing:border-box;padding:.5rem;border:1px solid var(--border);border-radius:.4rem;background:var(--surface);color:var(--text);font:inherit}.evidence-form .check{display:flex;align-items:flex-start;gap:.5rem}.check input{width:auto;margin-top:.25rem}.evidence-detail{display:grid;gap:.8rem;min-width:0;padding-top:.8rem;border-top:1px solid var(--border)}.evidence-detail h4,.evidence-detail p{margin:0}.evidence-detail dd{margin:0 0 .5rem}.evidence-detail pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:18rem;overflow:auto;font:inherit;padding:.5rem;background:var(--surface-alt,var(--surface))}.entry-list{max-height:24rem;overflow:auto}.entry-list li{padding:.6rem 0;border-bottom:1px solid var(--border)}.admission-handoff ol{padding-left:1.3rem}details details{padding:.6rem;border:1px solid var(--border);border-radius:.4rem}details details>summary{margin-bottom:.6rem}@media(max-width:640px){.source-evidence{padding:.55rem}.actions button{flex:1 1 9rem}.evidence-form button{width:100%}}
</style>
<style scoped>
.actions a{display:inline-flex;align-items:center;padding:.5rem .8rem;border:1px solid var(--accent);border-radius:.5rem;color:var(--accent);text-decoration:none}.actions a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
