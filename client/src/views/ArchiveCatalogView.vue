<template>
  <section class="mx-auto w-full max-w-[92rem] px-1 pb-12 sm:px-4 lg:px-7">
    <header class="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-muted">CosGallery Catalog</p>
        <h1 class="m-0 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">图库账本</h1>
        <p class="mt-2 mb-0 max-w-2xl text-sm leading-6 text-muted">
          管理规范博主身份、作品目录及已有来源信息。资源收录与执行请进入“博主入库”。
        </p>
      </div>
    </header>

    <nav aria-label="账本工作区" class="mb-5 flex flex-wrap gap-2">
      <button v-for="tab in workspaces" :key="tab.id" type="button" :data-test="'workspace-'+tab.id" :aria-pressed="workspace === tab.id" class="rounded-xl border px-5 py-3 text-sm font-semibold" :class="workspace === tab.id ? 'bg-accent text-white border-accent' : 'bg-surface border-border'" @click="selectWorkspace(tab.id)">{{ tab.label }}</button>
    </nav>

    <div v-if="summary" v-show="workspace === 'roster'" class="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6" aria-label="账本概览">
      <article v-for="card in summaryCards" :key="card.label" class="rounded-2xl border border-border bg-surface p-4 shadow-sm">
        <p class="m-0 text-xs font-semibold text-muted">{{ card.label }}</p>
        <strong class="mt-2 block whitespace-pre-line text-2xl tracking-[-0.04em]">{{ typeof card.value === 'number' ? formatCount(card.value) : card.value }}</strong>
        <small class="mt-1 block whitespace-pre-line text-xs leading-5 text-muted">{{ card.note }}</small>
      </article>
    </div>

    <p v-if="downloadNotice" role="alert" class="mb-4 text-sm text-red-700">{{ downloadNotice }}</p>
    <div v-if="rosterVisited" v-show="workspace === 'roster'"><ManagedCreatorRoster ref="managedRoster" @changed="loadCatalog()" @source-planned="loadCatalog" @plan-downloads="planCreatorDownloads" @resource-catalog="openResourceCatalog" /></div>
    <ResourceCatalog v-if="workspace === 'resources'" :key="permissionContext" :creator-id="resourceCreatorId" :global-scope="resourceGlobalScope" :scope-error="resourceScopeError" @select="openResourceCatalog" @all="openAllResources" @resolved="rememberResourceScope" @unavailable="discardRememberedScope" />

  </section>
</template>
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ResourceCatalog from '../components/ResourceCatalog.vue';
import ManagedCreatorRoster from '../components/ManagedCreatorRoster.vue';
import { fetchArchiveCatalog, planArchiveDownloadTasks, fetchLocalIngestSettings } from '../api/gallery';
import type { ArchiveCatalogSummary } from '../types/api';
import { useAuthStore } from '../stores/auth';
const workspaces = [
  { id: 'roster', label: '博主库' },
  { id: 'resources', label: '资源目录' }
] as const;
type Workspace = typeof workspaces[number]['id'];
const route = useRoute();
const router = useRouter();
const workspace = ref<Workspace>('roster');
const rosterVisited = ref(false);
const resourceCreatorId = ref<number | null>(null);
const resourceGlobalScope = ref(false);
const resourceScopeError = ref('');
const auth = useAuthStore();
const permissionContext = computed(() => JSON.stringify([auth.enabled, auth.authenticated, auth.role, auth.accessMode, auth.canManageLibrary]));
let restoredMemory = false;
let activePermissionContext = permissionContext.value;
const memoryKey = () => `cosgallery-resource-scope:${permissionContext.value}`;
function rememberResourceScope(id: number | null) {
  if (resourceScopeError.value) return;
  restoredMemory = false;
  try { sessionStorage.setItem(memoryKey(), id === null ? 'all' : String(id)); } catch { /* Storage is optional. */ }
}
function discardRememberedScope() {
  if (!restoredMemory) return; // Explicit URLs must never silently widen their scope.
  try { sessionStorage.removeItem(memoryKey()); } catch { /* Storage is optional. */ }
  restoredMemory = false;
  resourceCreatorId.value = null;
  resourceGlobalScope.value = true;
}
watch(
  () => [route?.query, permissionContext.value] as const,
  ([query, permission]) => {
    if (route?.path && route.path !== '/archive-catalog') return;
    const requested = query?.workspace;
    workspace.value = workspaces.some(tab => tab.id === requested)
      ? requested as Workspace
      : 'roster';
    if (workspace.value === 'roster') rosterVisited.value = true;
    resourceScopeError.value = '';
    if (permission !== activePermissionContext) {
      resourceCreatorId.value = null; resourceGlobalScope.value = false;
      activePermissionContext = permission;
    }
    restoredMemory = false;
    if (query?.creatorId !== undefined) {
      const value = typeof query.creatorId === 'string' && /^\d+$/.test(query.creatorId) ? Number(query.creatorId) : NaN;
      resourceCreatorId.value = Number.isSafeInteger(value) && value > 0 ? value : null;
      resourceGlobalScope.value = false;
      if (resourceCreatorId.value === null) resourceScopeError.value = '链接中的博主编号无效，请明确选择目录范围。';
    } else if (query?.scope !== undefined) {
      resourceCreatorId.value = null;
      resourceGlobalScope.value = query.scope === 'all';
      if (!resourceGlobalScope.value) resourceScopeError.value = '链接中的目录范围无效，请重新选择。';
    } else if (resourceCreatorId.value === null && !resourceGlobalScope.value) {
      let saved: string | null = null;
      try { saved = sessionStorage.getItem(memoryKey()); } catch { /* Storage is optional. */ }
      const value = saved && /^\d+$/.test(saved) ? Number(saved) : NaN;
      resourceCreatorId.value = Number.isSafeInteger(value) && value > 0 ? value : null;
      resourceGlobalScope.value = resourceCreatorId.value === null;
      restoredMemory = resourceCreatorId.value !== null;
    }
  },
  { immediate: true }
);
function selectWorkspace(value:Workspace) {
  if (value===workspace.value) return;
  if (router && route) void router.push({query:{...closedManagementQuery(),workspace:value},hash:route.hash});
  else {workspace.value=value;if(value==='roster')rosterVisited.value=true;}
}
function closedManagementQuery() {
  // Close only the new navigation entry. Browser Back can still restore the
  // previous management URL; the roster's existing dirty guard owns leaving it.
  return { ...route.query, manageCreator: undefined, manageTab: undefined };
}
function openResourceCatalog(id: number | null) {
  if (router && route) {
    void router.push({ query: { ...closedManagementQuery(), workspace: 'resources', creatorId: id === null ? undefined : String(id), scope: undefined }, hash: route.hash });
  } else {
    resourceCreatorId.value = id;
    resourceGlobalScope.value = false;
    workspace.value = 'resources';
  }
}
function openAllResources() {
  if (router && route) void router.push({ query: { ...closedManagementQuery(), workspace: 'resources', creatorId: undefined, scope: 'all' }, hash: route.hash });
  else { resourceCreatorId.value = null; resourceGlobalScope.value = true; workspace.value = 'resources'; }
}

const summary = ref<ArchiveCatalogSummary | null>(null);
const managedRoster = ref<InstanceType<typeof ManagedCreatorRoster> | null>(null);
const planningDownloads = ref(false);
const downloadNotice = ref('');
let alive = true;
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


async function loadCatalog() {
  try { const payload = await fetchArchiveCatalog({ page: 1, limit: 1 }); if (alive) summary.value = payload.summary; }
  catch { /* The roster owns its visible loading and error state. */ }
}
async function planCreatorDownloads(id: number) {
  if (planningDownloads.value) return;
  planningDownloads.value = true; downloadNotice.value = '';
  try {
    const settings = await fetchLocalIngestSettings();
    await planArchiveDownloadTasks(settings.inboxRoot, [id]);
    if (alive) await router.push({ name: 'costuan-admission', query: { workspace: 'staging' } });
  } catch (reason) { if (alive) downloadNotice.value = reason instanceof Error ? reason.message : '无法生成下载任务'; }
  finally { planningDownloads.value = false; }
}
onMounted(loadCatalog);
onBeforeUnmount(() => { alive = false; });
</script>
