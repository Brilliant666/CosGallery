<template>
  <section class="resource-catalog" aria-label="资源目录">
    <header>
      <h2>资源目录</h2>
      <p>CosGallery 已确认的本地作品目录，不代表该博主的全网作品已全部收集。</p>
    </header>
    <form class="creator-search" @submit.prevent="searchCreators">
      <label
        >规范博主名称或别名<input
          v-model="creatorQuery"
          type="search"
          placeholder="搜索并选择博主" /></label
      ><button>查找博主</button>
    </form>
    <div v-if="choices.length" class="choices">
      <button
        v-for="choice in choices"
        :key="choice.id"
        @click="emit('select', choice.id)"
      >
        #{{ choice.id }} {{ choice.canonicalName
        }}{{ choice.enabled ? '' : '（停用）' }}
      </button>
    </div>
    <p v-if="searchNotice" role="status">{{ searchNotice }}</p>
    <p v-if="!creatorId">请先选择一位博主；不会预载全库作品。</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="loading" role="status">正在读取资源目录…</p>
    <template v-if="payload">
      <header class="catalog-heading">
        <h3>
          {{ payload.creator.canonicalName }}
          <small>#{{ payload.creator.id }}</small>
        </h3>
        <a :href="`/library/${payload.creator.id}`">查看图库</a
        ><button data-test="refresh" @click="refresh">刷新目录</button>
      </header>
      <p v-if="stale" role="status" class="stale">
        作品数据已更新，请刷新资源目录；当前保留原编排。
      </p>
      <p class="stats">
        独立作品 {{ payload.summary.totalWorks }} · 已编目
        {{ payload.summary.numberedWorks }} · 未编排/待核对
        {{ payload.summary.unarrangedWorks }} · 多副本
        {{ payload.summary.multipleCopyWorks }} · 主副本不可用
        {{ payload.summary.unavailableWorks }}
      </p>
      <p class="hint">
        {{ payload.sortOrder === 'newest' ? '最新作品在前' : '最早作品在前' }} ·
        按已索引数据，不实时检查磁盘。目录 NO 会随编排更新，本地文件名未修改。
      </p>
      <p
        v-if="payload.summary.legacyPosts || payload.summary.sourceOnlyWorks"
        class="hint"
      >
        历史 Post 缺少可靠作品关系
        {{ payload.summary.legacyPosts }} 项；仅有来源、尚未收录
        {{ payload.summary.sourceOnlyWorks }} 项（不编本地 NO）。
      </p>
      <p v-if="payload.summary.excludedDeletedWorks" class="hint">
        已明确删除/回收的
        {{
          payload.summary.excludedDeletedWorks
        }}
        项不在当前目录内，未恢复资源。
      </p>
      <details v-if="payload.legacyGaps.length" class="hint">
        <summary>历史作品关系缺口（未编 NO，未自动补建身份）</summary>
        <ul>
          <li v-for="gap in payload.legacyGaps" :key="gap.postId">
            Post #{{ gap.postId }} · {{ gap.title }} · {{ gap.reason }}
          </li>
        </ul>
      </details>
      <form class="filters" @submit.prevent="applyFilters">
        <label
          >作品搜索<input
            :value="filters.q"
            type="search"
            placeholder="名称、NO 或原目录名"
            @input="queryInput"
            @compositionstart="composing = true"
            @compositionend="compositionEnd" /></label
        ><label
          >本地状态<select v-model="filters.localState" @change="applyFilters">
            <option value="all">全部状态</option>
            <option value="indexed">已索引</option>
            <option value="unavailable">主副本不可用</option>
            <option value="unarranged">未编排/待核对</option>
          </select></label
        ><label
          >来源<select v-model="filters.source" @change="applyFilters">
            <option value="all">全部</option>
            <option value="linked">已关联来源</option>
            <option value="unlinked">未关联来源</option>
          </select></label
        >
      </form>
      <div class="exports">
        <label
          >复制/导出范围<select v-model="scope" data-test="export-scope">
            <option value="all">完整目录（全部分页）</option>
            <option value="filtered">当前筛选结果（全部分页）</option>
          </select></label
        ><button
          :disabled="busy || stale || loading"
          @click="exportAll('copy')"
        >
          复制目录</button
        ><button :disabled="busy || stale || loading" @click="exportAll('txt')">
          导出 TXT</button
        ><button :disabled="busy || stale || loading" @click="exportAll('csv')">
          导出 CSV
        </button>
      </div>
      <p v-if="notice" role="status">{{ notice }}</p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>CosGallery NO / 作品</th>
              <th>排序时间</th>
              <th>主副本媒体</th>
              <th>索引状态</th>
              <th>已有来源对应</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="item in payload.items" :key="item.workId"
              ><tr>
                <td>
                  <strong>{{ item.no ?? '未编排' }}</strong> {{ item.title }}
                </td>
                <td>{{ date(item.sortTimestamp) }}</td>
                <td>
                  {{ item.imageCount ?? '未知' }} P /
                  {{ item.videoCount ?? '未知' }} V<br />{{
                    bytes(item.mediaBytes)
                  }}<small v-if="item.statisticsBasis === 'last-indexed'"
                    >按最后索引记录</small
                  >
                </td>
                <td>
                  {{ stateLabel(item.localState)
                  }}<small>{{ item.reason }}</small>
                </td>
                <td>
                  <template v-if="item.sources.length"
                    ><span
                      v-for="source in item.sources"
                      :key="source.sourceWorkId"
                      class="source-summary"
                      >{{ source.platform }}
                      {{
                        source.sourceOrderLabel ?? source.sourceOrder ?? ''
                      }}
                      · {{ source.title }}</span
                    ></template
                  ><span v-else>未关联来源</span>
                </td>
                <td>
                  <div class="row-actions">
                    <a
                      v-if="item.primaryPostId && item.localState === 'indexed'"
                      :href="`/library/${payload.creator.id}/works/${item.primaryPostId}`"
                      >查看图集</a
                    ><button
                      :disabled="stale || loading"
                      @click="toggleDetail(item.workId)"
                    >
                      {{
                        expanded === item.workId ? '收起' : '展开详情'
                      }}</button
                    ><button
                      :disabled="stale || loading"
                      @click="copyOne(item)"
                    >
                      复制单条
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="expanded === item.workId">
                <td colspan="6" class="detail">
                  <p v-if="detailLoading">正在读取详情…</p>
                  <template v-else-if="details[item.workId]"
                    ><p>
                      稳定 Work #{{ item.workId }} · 主 Post #{{
                        item.primaryPostId ?? '未知'
                      }}
                      · 主 LocalWork #{{ item.primaryLocalWorkId ?? '未知' }}
                    </p>
                    <ul>
                      <li
                        v-for="copy in details[item.workId]!.copies"
                        :key="copy.localWorkId"
                      >
                        {{ copy.primary ? '主副本' : '其他副本' }} ·
                        {{ copy.directoryName }} · LocalWork #{{
                          copy.localWorkId
                        }}
                        / Post #{{ copy.postId ?? '未知' }} ·
                        {{
                          copy.indexedAvailable ? '已索引可用' : '索引不可用'
                        }}
                        · {{ copy.imageCount ?? '未知' }}P /
                        {{ copy.videoCount ?? '未知' }}V ·
                        {{ bytes(copy.mediaBytes) }} · 其他文件
                        {{ copy.otherFileCount ?? '未知' }} · 保留原件
                        {{ copy.retainedOriginalCount ?? '未知' }}
                        <a
                          v-if="copy.postId && copy.indexedAvailable"
                          :href="`/library/${payload.creator.id}/works/${copy.postId}`"
                          >查看副本</a
                        >
                      </li>
                    </ul>
                    <ul>
                      <li
                        v-for="source in item.sources"
                        :key="source.sourceWorkId"
                      >
                        {{ source.platform }} ·
                        {{
                          source.sourceOrderLabel ??
                          source.sourceOrder ??
                          '未编号'
                        }}
                        · {{ source.title }} · 来源声明
                        {{ source.mediaSummary ?? '未知' }}
                        {{ source.active ? '' : '（来源记录已失效）' }}
                        <a
                          v-if="safeUrl(source.url)"
                          :href="safeUrl(source.url)!"
                          target="_blank"
                          rel="noopener noreferrer"
                          >查看来源</a
                        >
                      </li>
                    </ul>
                    <p>本地实测与来源声明分别保留；差异不撤销已接受版本。</p>
                    <p v-for="note in details[item.workId]!.notes" :key="note">
                      {{ note }}
                    </p></template
                  >
                </td>
              </tr></template
            >
          </tbody>
        </table>
      </div>
      <p v-if="!payload.items.length && !loading">当前筛选没有作品。</p>
      <footer>
        <button
          :disabled="loading || stale || payload.page <= 1"
          @click="loadPage(payload.page - 1)"
        >
          上一页</button
        ><span
          >第 {{ payload.page }} /
          {{ Math.max(1, Math.ceil(payload.total / payload.pageSize)) }} 页 ·
          {{ payload.total }} 项 · 每页50项</span
        ><button
          :disabled="
            loading || stale || payload.page * payload.pageSize >= payload.total
          "
          @click="loadPage(payload.page + 1)"
        >
          下一页
        </button>
      </footer>
    </template>
  </section>
</template>
<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useCreatorReadingStore } from '../stores/creator-reading';
import { RequestError } from '../api/http';
import {
  exportResourceCatalog,
  fetchResourceCatalog,
  fetchResourceDetail,
  findResourceCreators,
  type ResourceCreator,
  type ResourceDetail,
  type ResourcePage,
  type ResourceRow
} from '../api/resource-catalog';
const props = defineProps<{ creatorId: number | null }>();
const emit = defineEmits<{ select: [id: number] }>();
const reading = useCreatorReadingStore();
const payload = ref<ResourcePage | null>(null),
  creatorQuery = ref(''),
  choices = ref<ResourceCreator[]>([]),
  searchNotice = ref('');
const loading = ref(false),
  error = ref(''),
  stale = ref(false),
  notice = ref(''),
  busy = ref(false),
  expanded = ref<number | null>(null),
  detailLoading = ref(false);
const details = ref<Record<number, ResourceDetail>>({});
const filters = reactive({ q: '', localState: 'all', source: 'all' });
const scope = ref<'all' | 'filtered'>('all');
let token = 0,
  searchToken = 0,
  detailToken = 0,
  exportToken = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
let composing = false;
function failure(value: unknown) {
  if (value instanceof RequestError && value.status === 409) {
    stale.value = true;
    error.value = '编排已变化，请刷新后继续；未合并不同版本的目录。';
  } else error.value = value instanceof Error ? value.message : '读取失败';
}
async function searchCreators() {
  const current = ++searchToken;
  searchNotice.value = '';
  try {
    const result = await findResourceCreators(creatorQuery.value.trim());
    if (current !== searchToken) return;
    choices.value = result.items;
    searchNotice.value =
      result.total > result.items.length
        ? `共 ${result.total} 位，请缩小搜索范围。`
        : result.items.length
          ? ''
          : '没有符合名称或别名的博主。';
  } catch (e) {
    if (current === searchToken) failure(e);
  }
}
async function loadPage(page = 1, refreshRevision = false) {
  if (!props.creatorId || (stale.value && !refreshRevision)) return;
  const id = props.creatorId,
    current = ++token;
  ++detailToken;
  expanded.value = null;
  detailLoading.value = false;
  loading.value = true;
  error.value = '';
  try {
    const result = await fetchResourceCatalog(
      id,
      { ...filters },
      page,
      refreshRevision ? undefined : payload.value?.revision
    );
    if (current !== token) return;
    payload.value = result;
    stale.value = false;
    details.value = {};
  } catch (e) {
    if (current === token) failure(e);
  } finally {
    if (current === token) loading.value = false;
  }
}
function refresh() {
  clearTimeout(timer);
  void loadPage(1, true);
}
function applyFilters() {
  clearTimeout(timer);
  if (!composing) void loadPage(1);
}
function queryInput(event: Event) {
  filters.q = (event.target as HTMLInputElement).value;
  clearTimeout(timer);
  if (!composing) timer = setTimeout(applyFilters, 250);
}
function compositionEnd(event: Event) {
  composing = false;
  queryInput(event);
}
watch(
  () => props.creatorId,
  () => {
    ++token;
    ++detailToken;
    ++exportToken;
    clearTimeout(timer);
    payload.value = null;
    details.value = {};
    expanded.value = null;
    stale.value = false;
    error.value = '';
    notice.value = '';
    busy.value = false;
    filters.q = '';
    filters.localState = 'all';
    filters.source = 'all';
    void loadPage(1, true);
  },
  { immediate: true }
);
watch(
  () => reading.generation,
  () => {
    if (payload.value) {
      stale.value = true;
      ++token;
      ++detailToken;
      ++exportToken;
      loading.value = false;
      busy.value = false;
    }
  }
);
async function toggleDetail(workId: number) {
  if (expanded.value === workId) {
    expanded.value = null;
    ++detailToken;
    return;
  }
  if (!payload.value || stale.value) return;
  expanded.value = workId;
  const current = ++detailToken,
    id = payload.value.creator.id,
    revision = payload.value.revision;
  if (details.value[workId]) {
    detailLoading.value = false;
    return;
  }
  detailLoading.value = true;
  try {
    const result = await fetchResourceDetail(id, workId, revision);
    if (current === detailToken) details.value[workId] = result;
  } catch (e) {
    if (current === detailToken) failure(e);
  } finally {
    if (current === detailToken) detailLoading.value = false;
  }
}
async function copyOne(item: ResourceRow) {
  if (!payload.value || stale.value) return;
  const current = ++exportToken,
    snapshot = payload.value;
  try {
    const result = await fetchResourceDetail(
      snapshot.creator.id,
      item.workId,
      snapshot.revision
    );
    if (current !== exportToken) return;
    await navigator.clipboard.writeText(result.item.text);
    if (current === exportToken) notice.value = '已复制单条目录。';
  } catch (e) {
    if (current === exportToken) failure(e);
  }
}
async function exportAll(action: 'copy' | 'txt' | 'csv') {
  if (!payload.value || stale.value) return;
  const snapshot = payload.value,
    current = ++exportToken;
  busy.value = true;
  error.value = '';
  try {
    const text = await exportResourceCatalog(
      snapshot.creator.id,
      { ...filters },
      snapshot.revision,
      scope.value,
      action === 'csv' ? 'csv' : 'txt'
    );
    if (
      current !== exportToken ||
      payload.value?.revision !== snapshot.revision
    )
      return;
    if (action === 'copy') await navigator.clipboard.writeText(text);
    else {
      const url = URL.createObjectURL(
        new Blob([text], {
          type:
            action === 'csv'
              ? 'text/csv;charset=utf-8'
              : 'text/plain;charset=utf-8'
        })
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `CosGallery-${snapshot.creator.id}.${action}`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    notice.value =
      action === 'copy'
        ? '已复制所选范围的全部目录（不限当前页）。'
        : '已导出所选范围的全部目录（不限当前页）。';
  } catch (e) {
    if (current === exportToken) failure(e);
  } finally {
    if (current === exportToken) busy.value = false;
  }
}
const date = (value: number | null) =>
  value === null ? '未知 / 未编排' : new Date(value).toLocaleString();
const bytes = (value: number | null) =>
  value === null
    ? '容量未知'
    : value >= 1024 ** 3
      ? `${(value / 1024 ** 3).toFixed(2)} GiB`
      : `${(value / 1024 ** 2).toFixed(2)} MiB`;
const stateLabel = (value: string) =>
  ({
    indexed: '已索引',
    unavailable: '主副本不可用',
    unarranged: '未编排 / 待核对'
  })[value] ?? value;
function safeUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
onBeforeUnmount(() => {
  ++token;
  ++searchToken;
  ++detailToken;
  ++exportToken;
  clearTimeout(timer);
});
</script>
<style scoped>
.resource-catalog {
  border: 1px solid var(--color-border, #ddd);
  border-radius: 1rem;
  padding: 1.25rem;
  background: var(--color-surface, #fff);
}
h2,
h3 {
  font-weight: 650;
  margin: 0 0 0.5rem;
}
p {
  margin: 0.65rem 0;
}
.hint,
small {
  color: var(--color-muted, #667085);
  font-size: 0.8rem;
}
small,
.source-summary {
  display: block;
}
.creator-search,
.filters,
.exports,
.catalog-heading,
.choices,
footer {
  display: flex;
  gap: 0.75rem;
  align-items: end;
  flex-wrap: wrap;
  margin: 1rem 0;
}
label {
  display: grid;
  gap: 0.3rem;
  font-size: 0.85rem;
}
input,
select,
button {
  border: 1px solid var(--color-border, #ddd);
  border-radius: 0.6rem;
  padding: 0.5rem 0.7rem;
  background: var(--color-bg, #f5f6f8);
  color: inherit;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
a {
  color: var(--color-accent, #007bcb);
}
.table-scroll {
  overflow: auto;
}
table {
  width: 100%;
  min-width: 850px;
  border-collapse: collapse;
  font-size: 0.85rem;
}
th,
td {
  text-align: left;
  padding: 0.8rem;
  border-bottom: 1px solid var(--color-border, #ddd);
  vertical-align: top;
}
th {
  white-space: nowrap;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem 0.5rem;
  min-width: 12rem;
}
.row-actions button {
  padding: 0.3rem 0.45rem;
  white-space: nowrap;
}
.detail {
  background: var(--color-bg, #f5f6f8);
  overflow-wrap: anywhere;
}
.detail li {
  margin: 0.5rem 0;
}
.error {
  color: #b42318;
}
.stale {
  padding: 0.7rem;
  background: #fff3cd;
  color: #755000;
}
footer {
  justify-content: center;
}
.stats {
  line-height: 1.8;
}
@media (max-width: 600px) {
  .resource-catalog {
    padding: 0.75rem;
  }
  .filters label,
  .creator-search label {
    width: 100%;
  }
}
</style>
