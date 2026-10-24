<template>
  <section class="roster" aria-label="博主库">
    <header class="roster-heading">
      <div><h2>博主库</h2><p>统一维护博主 ID、名称与分类。来源平台只补充作品信息。</p></div>
      <button type="button" class="primary" :disabled="!auth.capabilities.canManageLibrary" @click="openNew">新增博主</button>
    </header>
    <div class="roster-layout"><div class="roster-list-column">
    <form class="roster-filters" @submit.prevent="search" @change="onFilterChange">
      <label class="search">搜索名称或别名<input :value="filters.query" type="search" placeholder="名称或别名" @input="onQueryInput" @compositionstart="startComposition" @compositionend="endComposition" @keydown.enter="onEnter" /></label>
      <label>偏好<select v-model="filters.preference"><option value="">全部偏好</option><option value="liked">喜欢</option><option value="kept">保留</option><option value="unset">未设置</option></select></label>
      <label>分级<select v-model="filters.rating"><option value="">全部分级</option><option>R15</option><option>R18</option><option value="unclassified">待分类</option></select></label>
      <label>状态<select v-model="filters.active"><option value="active">启用</option><option value="inactive">停用</option><option value="all">全部状态</option></select></label>
      <label>本地作品<select v-model="filters.hasLocal"><option value="">全部</option><option value="yes">有本地作品</option><option value="no">无本地作品</option></select></label>
      <label>来源记录<select v-model="filters.hasSource"><option value="">全部</option><option value="yes">有来源记录</option><option value="no">无来源记录（全部）</option><option value="no-unchecked">无来源记录 · 尚无检查任务</option><option value="no-not-found">无来源记录 · 最近检查未找到合集</option></select></label>
      <label>作品对账<select v-model="filters.state"><option value="">全部</option><option value="missing">有缺失作品</option><option value="no-local">无本地作品</option><option value="complete">已完整关联</option><option value="no-source">无来源作品</option><option value="unresolved">待核查</option></select></label>
      <button type="button" @click="resetFilters">重置筛选</button>
    </form>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div ref="listTop" class="creator-cards" aria-label="博主账本列表">
      <article v-for="creator in payload?.items" :key="creator.id" class="creator-card">
        <div class="card-identity">
          <div class="card-name"><strong>{{ creator.name }}</strong><span class="badge" :class="creator.preference">{{ preferenceLabel(creator.preference) }}</span><span class="badge rating" :class="creator.rating">{{ creator.rating ?? '待分类' }}</span><small v-if="!creator.isActive">已停用</small></div>
          <p>{{ creator.sourceCollections }} 个资源合集 · {{ ledgerStatus(creator) }}</p>
        </div>
        <div class="card-metric"><small>平台作品</small><strong>{{ creator.remoteWorks }}</strong></div>
        <div class="card-metric"><small>本地作品</small><strong>{{ creator.localWorks }}</strong></div>
        <div class="card-metric"><small>已关联</small><strong>{{ creator.matchedWorks }}</strong></div>
        <div class="card-metric" :class="{missing:creator.missingWorks > 0}"><small>待收录</small><strong>{{ creator.missingWorks }}</strong></div>
        <div class="card-actions"><button type="button" @click="emit('resource-catalog', creator.id)">资源目录</button><button type="button" :aria-label="`管理 ${creator.name}`" :aria-pressed="panelSelection === String(creator.id)" @click="openCreator(creator.id)">管理资料</button></div>
      </article>
    </div>
    <p v-if="payload && !payload.items.length">没有符合条件的博主。</p>
    <footer class="roster-paging">
      <button :disabled="page <= 1 || loading" @click="goPage(page - 1)">上一页</button>
      <span>第 {{ page }} 页 · 筛选结果 {{ payload?.total ?? 0 }} 位 · 每页 50 位</span>
      <button :disabled="!payload?.hasMore || loading" @click="goPage(page + 1)">下一页</button>
    </footer>

    </div><CreatorManagementPanel v-if="panelSelection" :key="panelSelection" ref="panel" :creator-id="panelSelection === 'new' ? null : Number(panelSelection)" :tab="panelTab" @close="closePanel" @tab="changePanelTab" @changed="changed" @created="created" @deleted="deleted" @catalog="id=>emit('resource-catalog',id)" @plan-downloads="id=>emit('plan-downloads',id)" @source-planned="handleSourcePlanned" /></div>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router';
import CreatorManagementPanel, { type CreatorPanelTab } from './CreatorManagementPanel.vue';
import { fetchArchiveCatalog } from '../api/gallery';
import { useAuthStore } from '../stores/auth';
import { pinia } from '../stores/pinia';
import type { ArchiveCatalogCreatorsPayload, ArchiveCatalogPreference, ArchiveCatalogState, ContentRating } from '../types/api';
const emit = defineEmits<{ changed: []; sourcePlanned: [creatorIds: number[]]; 'plan-downloads': [creatorId: number]; 'resource-catalog': [creatorId: number] }>();
const route=useRoute(),router=useRouter(),auth=useAuthStore(pinia);
const payload=ref<ArchiveCatalogCreatorsPayload|null>(null),listTop=ref<HTMLElement|null>(null);
const defaults={ query:'', preference:'' as ''|'liked'|'kept'|'unset', rating:'' as ''|ContentRating|'unclassified', active:'active' as 'active'|'inactive'|'all', hasLocal:'' as ''|'yes'|'no', hasSource:'' as ''|'yes'|'no'|'no-unchecked'|'no-not-found', state:'' as ''|ArchiveCatalogState };
const filters=reactive({...defaults});
const page=ref(1),loading=ref(false),error=ref(''),notice=ref('');
const panel=ref<InstanceType<typeof CreatorManagementPanel>|null>(null), panelSelection=ref(''),panelTab=ref<CreatorPanelTab>('overview');
let loadGeneration=0,queryTimer:ReturnType<typeof setTimeout>|undefined,composing=false,disposed=false,requestKey:string|null=null,appliedFilterKey:string|null=null;
const preferenceLabel=(value:ArchiveCatalogPreference|null)=>value==='liked'?'喜欢':value==='kept'?'保留':'未设置';
const ledgerStatus=(creator:{remoteWorks:number;localWorks:number;missingWorks:number;unresolvedLocalWorks:number})=>creator.unresolvedLocalWorks>0?'待核查':creator.remoteWorks===0?'尚未接入资源':creator.localWorks===0?'尚未入库':creator.missingWorks>0?`有 ${creator.missingWorks} 套待收录`:'已完整关联';
function showError(reason:unknown){error.value=reason instanceof Error?reason.message:'读取失败';}
async function load(force = true) {
  if (disposed) return;
  const filterKey = JSON.stringify(filters);
  const params = {page:page.value,limit:50,query:filters.query,active:filters.active,
    preference:filters.preference||undefined,rating:filters.rating||undefined,hasLocal:filters.hasLocal||undefined,hasSource:filters.hasSource||undefined,state:filters.state||undefined};
  const key = JSON.stringify(params);
  if (!force && requestKey === key) return;
  requestKey = key;
  const generation = ++loadGeneration;
  loading.value = true;
  try {
    const result = await fetchArchiveCatalog(params);
    if (generation === loadGeneration) { payload.value = result; appliedFilterKey = filterKey; return generation; }
  } catch (reason) { if (generation === loadGeneration) { requestKey = null; showError(reason); } }
  finally { if (generation === loadGeneration) { loading.value = false; } }
}
function clearQueryTimer() { clearTimeout(queryTimer); queryTimer = undefined; }
function onFilterChange(event: Event) {
  if (event.target instanceof HTMLSelectElement) void search();
}
function invalidateLoad() { ++loadGeneration; requestKey = null; loading.value = false; }
async function search() {
  clearQueryTimer();
  if (composing) return;
  page.value = 1; error.value = ''; syncFilters(); await load(false);
}
function scheduleQuery() {
  clearQueryTimer();
  invalidateLoad();
  if (composing) return;
  if (!filters.query) { void search(); return; }
  queryTimer = setTimeout(() => { void search(); }, 300);
}
function onQueryInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (value === filters.query) return;
  filters.query = value;
  scheduleQuery();
}
function startComposition() { composing = true; clearQueryTimer(); invalidateLoad(); }
function endComposition(event: CompositionEvent) {
  composing = false;
  filters.query = (event.target as HTMLInputElement).value;
  scheduleQuery();
}
function onEnter(event: KeyboardEvent) {
  event.preventDefault();
  if (!event.isComposing && !composing) void search();
}
function resetFilters() {
  composing = false;
  Object.assign(filters, {query:'',preference:'',rating:'',active:'active',hasLocal:'',hasSource:'',state:''});
  void search();
}
async function handleSourcePlanned(creatorIds: number[]) {
  emit('sourcePlanned', creatorIds);
  await load();
}
async function goPage(value:number) {
  if (JSON.stringify(filters) !== appliedFilterKey) { await search(); return; }
  clearQueryTimer(); page.value = value; syncFilters();
  const generation = await load(false);
  await nextTick();
  if (!disposed && generation !== undefined && generation === loadGeneration && listTop.value?.getClientRects().length) {
    listTop.value.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
}

const validSelection=(value:unknown)=>value==='new'?'new':typeof value==='string'&&/^[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value))?value:'';
const validTab=(value:unknown):CreatorPanelTab=>['overview','profile','directories','sources'].includes(value as string)?value as CreatorPanelTab:'overview';
const filterKeys=Object.keys(defaults) as Array<keyof typeof defaults>;
function syncFilters(){if(!router||!route||route.path!=='/archive-catalog')return;const query:LocationQueryRaw={...route.query};for(const key of filterKeys)query['roster'+key[0]!.toUpperCase()+key.slice(1)]=filters[key]===defaults[key]?undefined:filters[key];query.rosterPage=page.value===1?undefined:String(page.value);void router.replace({query,hash:route.hash});}
watch(()=>route?.query,query=>{
 if(!route||route.path!=='/archive-catalog')return;
 panelSelection.value=(query?.workspace??'roster')==='roster'?validSelection(query?.manageCreator):'';
 panelTab.value=panelSelection.value==='new'?'profile':validTab(query?.manageTab);
 const next={...defaults};
 const options:Record<string,string[]>={preference:['','liked','kept','unset'],rating:['','R15','R18','unclassified'],active:['active','inactive','all'],hasLocal:['','yes','no'],hasSource:['','yes','no','no-unchecked','no-not-found'],state:['','missing','no-local','complete','no-source','unresolved']};
 for(const key of filterKeys){const value=query?.['roster'+key[0]!.toUpperCase()+key.slice(1)];if(typeof value==='string'&&(key==='query'||options[key]?.includes(value)))(next as Record<string,string>)[key]=value;}
 const pageValue=typeof query?.rosterPage==='string'&&/^[1-9]\d*$/.test(query.rosterPage)?Number(query.rosterPage):1;
 const different=JSON.stringify(filters)!==JSON.stringify(next)||page.value!==pageValue;Object.assign(filters,next);page.value=Number.isSafeInteger(pageValue)?pageValue:1;if(different)void load(false);
},{immediate:true});
const removeGuard=router?.beforeEach(async(to,from)=>{
 if(from.path!=='/archive-catalog'||!panelSelection.value)return true;
 const target=to.path==='/archive-catalog'&&(to.query.workspace??'roster')==='roster'?validSelection(to.query.manageCreator):'';
 if(target===panelSelection.value)return true;
 return await panel.value?.requestLeave()??true;
});
async function selectPanel(value:string,tab:CreatorPanelTab='overview',replace=false){if(router&&route){const navigate=replace?router.replace.bind(router):router.push.bind(router);await navigate({query:{...route.query,manageCreator:value||undefined,manageTab:value?tab:undefined},hash:route.hash});}else{if(panelSelection.value!==value&&panel.value&&!await panel.value.requestLeave())return;panelSelection.value=value;panelTab.value=tab;}}
function openNew(){void selectPanel('new','profile');}
function openCreator(id:number){void selectPanel(String(id));}
function closePanel(){void selectPanel('');}
function changePanelTab(tab:CreatorPanelTab){void selectPanel(panelSelection.value,tab);}
function created(id:number){void selectPanel(String(id),'overview',true);}
async function changed(){await load();emit('changed');}
async function deleted(){await selectPanel('','overview',true);if(payload.value?.items.length===1&&page.value>1){page.value--;syncFilters();}await load();notice.value='已删除博主及预览范围内的资料；未删除本地文件。';}
defineExpose({refresh:()=>load()});
onMounted(()=>{void load(false);});
onBeforeUnmount(()=>{disposed=true;clearQueryTimer();invalidateLoad();removeGuard?.();});
</script>
<style scoped>
.roster{margin-bottom:1.5rem;padding:1.25rem;border:1px solid var(--border);border-radius:1rem;background:var(--surface)}
h2,h3,p{margin:0} h2{font-size:1.2rem;font-weight:650} h3{font-size:1rem;font-weight:600;margin-bottom:.65rem} p{line-height:1.6}
.roster-heading{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:1rem}.roster-heading p,.hint,small{color:var(--muted);font-size:.8rem}
.roster-counts{display:flex;flex-wrap:wrap;gap:.65rem 1.4rem;margin-bottom:1rem;font-size:.8rem}.roster-filters{display:flex;flex-wrap:wrap;align-items:end;gap:.6rem;margin-bottom:1rem}
label{display:grid;gap:.3rem;font-size:.8rem}input,select,button{font:inherit}input:not([type=checkbox]),select{min-width:0;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:.5rem;padding:.6rem;width:100%}
.search{flex:1 1 13rem}button{border:1px solid var(--border);border-radius:.5rem;background:var(--surface);color:var(--text);padding:.55rem .85rem;cursor:pointer;white-space:nowrap}button.primary{background:var(--accent-fill,var(--accent));color:white;border-color:var(--accent)}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.roster-paging{display:flex;justify-content:center;align-items:center;flex-wrap:wrap;gap:1rem;margin-top:1rem;font-size:.8rem}
.roster-dialog{margin:auto;width:min(48rem,calc(100vw - 2rem));max-height:90vh;overflow:auto;padding:1.4rem;border:1px solid var(--border);border-radius:1rem;background:var(--surface);color:var(--text)}.roster-dialog::backdrop{background:#0007}.roster-dialog section{margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--border)}
.roster-edit{display:grid;grid-template-columns:2fr 1fr 1fr;gap:.8rem;margin-top:1rem;align-items:end}.roster-edit button{grid-column:1/-1}.alias-list,.source-list{list-style:none;padding:0;margin:0;display:grid;gap:.6rem}.alias-list li{display:flex;align-items:center;justify-content:space-between;gap:1rem;overflow-wrap:anywhere}.source-list small{display:block;overflow-wrap:anywhere}a{color:var(--accent)}
.inline-form{display:flex;align-items:end;gap:.6rem;margin-top:1rem}.inline-form label{flex:1}.error{background:#fee2e2;color:#991b1b;padding:.7rem;border-radius:.5rem;margin:.7rem 0}.collision{background:var(--bg);border:1px solid var(--border);padding:1rem;margin:1rem 0;border-radius:.5rem}.collision button{margin:.4rem .4rem .4rem 0}.collision label{display:flex;align-items:center}.state-controls p{font-size:.85rem;margin-bottom:.65rem}
.ledger-detail{margin-top:.8rem;padding:.7rem;border:1px solid var(--border);border-radius:.5rem;overflow-wrap:anywhere}.ledger-detail summary{cursor:pointer;font-weight:600}.ledger-detail .source-list{margin-top:.7rem}.ledger-detail li{padding:.5rem 0;border-bottom:1px solid var(--border)}
@media(max-width:640px){.roster{padding:.8rem}.roster-edit{grid-template-columns:1fr}.roster-heading{align-items:start}.roster-dialog{padding:1rem}.roster-filters label{flex:1 1 8rem}.roster-filters .search{flex-basis:100%}}
.creator-cards{display:grid;gap:1rem;margin-top:1.2rem}.creator-card{display:grid;grid-template-columns:minmax(15rem,2.5fr) repeat(4,minmax(4rem,.65fr)) auto;align-items:center;gap:1rem;padding:1.3rem;border:1px solid var(--border);border-radius:1rem;background:var(--surface);box-shadow:0 2px 3px #00000012}.card-name{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem}.card-identity p{margin:.5rem 0 0;color:var(--muted);font-size:.8rem}.badge{border-radius:1rem;background:var(--bg);padding:.2rem .5rem;font-size:.7rem;font-weight:700}.badge.liked{background:#fee2e2;color:#dc2626}.badge.kept{background:#fef3c7;color:#92400e}.badge.rating{background:#6b7280;color:white}.badge.R15{background:#55718f}.badge.R18{background:#b72d45}.card-metric small{display:block;color:var(--muted);font-size:.75rem}.card-metric strong{display:block;margin-top:.3rem;font-size:1.15rem}.card-metric.missing strong{color:#d97706}.card-actions{display:flex;flex-wrap:wrap;gap:.5rem}.card-identity{min-width:0;overflow-wrap:anywhere}
@media(max-width:1100px){.creator-card{grid-template-columns:repeat(4,minmax(0,1fr))}.card-identity{grid-column:1/-1}.card-actions{grid-column:1/-1;justify-content:flex-end}}
</style>
<style scoped>
.card-actions a{display:inline-flex;align-items:center;border:1px solid var(--border);border-radius:.5rem;background:var(--surface);color:var(--accent);padding:.55rem .85rem;text-decoration:none;white-space:nowrap}.card-actions a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
<style scoped>
.roster-layout{display:grid;gap:1.1rem;align-items:start;min-width:0}.roster-list-column{min-width:0}.card-actions [aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
</style>
