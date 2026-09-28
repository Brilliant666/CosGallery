<template>
  <section v-if="auth.capabilities.canAccessSettings" class="card grid gap-4 p-6 sm:p-8" aria-labelledby="companion-grants-title">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="companion-grants-title" class="m-0 text-[1.18rem]">Companion 只读连接</h2>
        <p class="mt-1 mb-0 text-sm text-muted">为独立浏览辅助插件创建专用授权；与 CostuanArchiveManager 的采集连接无关，不允许采集、绑定来源或执行入库。</p>
      </div>
      <button type="button" class="btn-secondary" :disabled="busy" @click="load">刷新授权</button>
    </header>
    <p v-if="error" role="alert" class="m-0 text-sm text-red-600">{{ error }}</p>
    <p v-if="loading" role="status" class="m-0 text-sm text-muted">正在读取授权…</p>
    <p v-if="state?.instanceId" class="m-0 break-all text-xs text-muted">当前实例：{{ state.label }} · {{ state.instanceId }}</p>
    <form class="grid gap-3" @submit.prevent="create">
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="grid gap-1 text-sm">连接名称
          <input v-model="label" data-testid="grant-label" class="rounded-xl border border-border bg-surface px-3 py-2" maxlength="80" required :disabled="busy" placeholder="例如：我的 Companion" />
        </label>
        <label class="grid gap-1 text-sm">Companion 扩展 ID 或来源
          <input v-model="originInput" data-testid="grant-origin" class="rounded-xl border border-border bg-surface px-3 py-2" maxlength="64" required :disabled="busy" spellcheck="false" autocomplete="off" placeholder="扩展管理页中的 32 位 ID" />
        </label>
      </div>
      <label class="flex items-center gap-2 text-sm">有效期
        <select v-model.number="expiresInDays" :disabled="busy" class="rounded-xl border border-border bg-surface px-3 py-2">
          <option :value="7">7 天</option><option :value="30">30 天</option><option :value="90">90 天</option>
        </select>
      </label>
      <fieldset :disabled="busy" class="m-0 grid gap-2 border-0 p-0 text-sm">
        <legend class="mb-2">允许读取的范围</legend>
        <label class="flex items-center gap-2"><input type="checkbox" checked disabled />规范博主身份（必需）</label>
        <label v-for="scope in optionalScopes" :key="scope.value" class="flex items-center gap-2">
          <input v-model="selectedScopes" type="checkbox" :value="scope.value" />{{ scope.label }}
        </label>
      </fieldset>
      <p class="m-0 text-xs text-muted">未授权作品摘要时，插件不能读取收录数量；跳转权限仅提供链接，不能代替网页登录。</p>
      <button class="btn-primary justify-self-start" type="submit" :disabled="busy || !state || !!issuedToken">创建只读授权</button>
    </form>
    <section v-if="issuedToken" class="grid gap-2 rounded-xl border border-border bg-surface-alt p-4" aria-label="一次性连接密钥">
      <p class="m-0 text-sm">连接密钥仅显示这一次。复制到 Companion 后关闭；刷新或离开页面将无法再次读取。</p>
      <label class="grid gap-1 text-sm">连接密钥<input :value="issuedToken" readonly autocomplete="off" spellcheck="false" class="min-w-0 rounded-lg border border-border bg-surface p-2 font-mono" /></label>
      <div class="flex flex-wrap gap-2"><button type="button" class="btn-secondary" @click="copyToken">复制密钥</button><button type="button" class="btn-secondary" @click="clearToken">已保存，关闭密钥</button></div>
      <p v-if="copyNotice" role="status" class="m-0 text-sm">{{ copyNotice }}</p>
    </section>
    <p v-if="state && !state.grants.length" class="m-0 text-sm text-muted">尚无 Companion 授权。</p>
    <ul v-if="state?.grants.length" class="m-0 grid list-none gap-3 p-0" aria-label="已有 Companion 授权">
      <li v-for="grant in state.grants" :key="grant.id" class="grid gap-2 rounded-xl border border-border p-4">
        <div class="flex flex-wrap items-center justify-between gap-2"><strong>{{ grant.label }}</strong><span class="text-sm">{{ grant.revokedAt ? '已撤销' : expired(grant) ? '已到期' : '有效' }}</span></div>
        <p class="m-0 break-all text-xs text-muted">{{ grant.extensionOrigin }}</p>
        <p class="m-0 text-sm">权限：{{ grant.scopes.map(scopeLabel).join('、') }}</p>
        <p class="m-0 text-xs text-muted">创建 {{ date(grant.createdAt) }} · 到期 {{ date(grant.expiresAt) }}</p>
        <button v-if="!grant.revokedAt" type="button" class="btn-secondary justify-self-start" :disabled="busy" @click="revoke(grant)">撤销 {{ grant.label }}</button>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth';
import { createCompanionGrant, fetchCompanionGrants, normalizeCompanionOrigin, revokeCompanionGrant, type CompanionGrant, type CompanionGrants, type CompanionScope } from '../api/companion-grants';
const auth = useAuthStore();
const state = ref<CompanionGrants | null>(null);
const label = ref(''), originInput = ref(''), expiresInDays = ref(30);
const optionalScopes: Array<{ value: CompanionScope; label: string }> = [
  { value: 'summary:read', label: '本地作品收录摘要' },
  { value: 'library:link', label: '图库跳转链接' },
  { value: 'catalog:link', label: '资源目录跳转链接' }
];
const selectedScopes = ref<CompanionScope[]>(['summary:read', 'library:link', 'catalog:link']);
const issuedToken = ref(''), issuedId = ref(''), copyNotice = ref(''), error = ref('');
const loading = ref(false), writing = ref(false);
const busy = computed(() => loading.value || writing.value);
let generation = 0, disposed = false;
const current = (request: number) => !disposed && auth.capabilities.canAccessSettings && request === generation;
function clearToken() { issuedToken.value = ''; issuedId.value = ''; copyNotice.value = ''; }
function scopeLabel(scope: CompanionScope) { return scope === 'identity:read' ? '规范博主身份' : optionalScopes.find(item => item.value === scope)?.label ?? scope; }
function date(value: string) { return new Date(value).toLocaleString(); }
function expired(grant: CompanionGrant) { return Date.parse(grant.expiresAt) <= Date.now(); }
async function load() {
  if (busy.value || disposed || !auth.capabilities.canAccessSettings) return;
  clearToken(); const request = ++generation; loading.value = true; error.value = '';
  try { const result = await fetchCompanionGrants(); if (current(request)) state.value = result; }
  catch (e) { if (current(request)) { state.value = null; error.value = e instanceof Error ? e.message : '读取授权失败'; } }
  finally { if (current(request)) loading.value = false; }
}
async function create() {
  if (busy.value || !state.value || issuedToken.value || !auth.capabilities.canAccessSettings) return;
  const extensionOrigin = normalizeCompanionOrigin(originInput.value);
  if (!extensionOrigin || !label.value.trim()) { error.value = '请填写连接名称和有效的 32 位扩展 ID。'; return; }
  const request = ++generation; writing.value = true; error.value = '';
  try {
    const result = await createCompanionGrant({ label: label.value.trim(), extensionOrigin, expiresInDays: expiresInDays.value, scopes: ['identity:read', ...selectedScopes.value] });
    if (current(request)) {
      state.value = { instanceId: result.instanceId, label: result.label, grants: [result.grant, ...(state.value?.grants ?? [])] };
      issuedToken.value = result.token; issuedId.value = result.grant.id;
    }
  } catch (e) { if (current(request)) error.value = e instanceof Error ? e.message : '创建授权失败，不会自动重试'; }
  finally { if (current(request)) writing.value = false; }
}
async function revoke(grant: CompanionGrant) {
  if (busy.value || grant.revokedAt || !auth.capabilities.canAccessSettings) return;
  const request = ++generation; writing.value = true; error.value = '';
  try {
    await revokeCompanionGrant(grant.id);
    if (current(request)) {
      if (issuedId.value === grant.id) clearToken();
      // Read back the authoritative revocation time; do not fabricate a server record.
      state.value = null;
      const result = await fetchCompanionGrants();
      if (current(request)) state.value = result;
    }
  } catch (e) { if (current(request)) error.value = e instanceof Error ? e.message : '撤销授权失败，请刷新核对'; }
  finally { if (current(request)) writing.value = false; }
}
async function copyToken() {
  const request = generation;
  if (!issuedToken.value || !auth.capabilities.canAccessSettings) return;
  try { await navigator.clipboard.writeText(issuedToken.value); if (current(request)) copyNotice.value = '已复制'; }
  catch { if (current(request)) copyNotice.value = '复制失败，请手动选择连接密钥复制。'; }
}
watch(() => [auth.capabilities.canAccessSettings, auth.role, auth.authenticated] as const, () => {
  ++generation; clearToken(); state.value = null; error.value = ''; loading.value = false; writing.value = false;
  if (auth.capabilities.canAccessSettings) void load();
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; ++generation; clearToken(); });
</script>
