<template>
  <section v-if="auth.capabilities.canAccessSettings" class="card grid gap-4 p-6 sm:p-8" aria-labelledby="recovery-points-title">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="recovery-points-title" class="m-0 text-[1.18rem]">备份与恢复点</h2>
        <p class="mt-1 mb-0 text-sm text-muted">保存完整应用数据库、必要配置与已有密钥；不包含原媒体、图片缓存或浏览器插件存储。</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn-secondary" :disabled="loading || creating" @click="load">刷新状态</button>
        <button type="button" class="btn-primary" :disabled="!state || loading || creating || !!state.active" @click="create">
          {{ creating || state?.active ? '正在创建…' : '立即创建恢复点' }}
        </button>
      </div>
    </div>
    <p v-if="error" role="alert" class="m-0 rounded-xl border border-red-300 p-3 text-sm">{{ error }} 不会自动重复创建，可刷新状态后再决定。</p>
    <p v-if="loading && !state" role="status" class="m-0 text-muted">正在读取恢复点状态…</p>
    <template v-if="state">
      <dl class="m-0 grid gap-3 text-sm sm:grid-cols-2">
        <div class="sm:col-span-2"><dt class="text-muted">实际备份位置</dt><dd class="m-0 break-all font-mono">{{ state.backupRoot }}</dd></div>
        <div><dt class="text-muted">最近成功</dt><dd class="m-0">{{ state.latestSuccess ? date(state.latestSuccess.completedAt) : '暂无成功恢复点' }}</dd></div>
        <div><dt class="text-muted">自动备份</dt><dd class="m-0">{{ state.automatic.enabled ? `已启用 · 每 ${state.automatic.intervalHours} 小时检查日常恢复点` : '未启用（由实例配置控制）' }}</dd></div>
      </dl>
      <p class="m-0 text-sm text-muted">保留目标：最近 {{ state.automatic.retainDaily }} 份日常、{{ state.automatic.retainWeekly }} 份周恢复点。手动及重要操作前恢复点不自动删除；只有新备份成功后才整理本机制的日常记录。</p>
      <p v-if="state.active" role="status" class="m-0 rounded-xl border border-border bg-surface-alt p-3 text-sm">
        后台创建中 · {{ reason(state.active.reason) }} · {{ date(state.active.startedAt) }}。可离开页面，返回后查看真实结果；关闭页面不会取消任务。
      </p>
      <p v-if="state.lastFailure" role="alert" class="m-0 rounded-xl border border-red-300 p-3 text-sm">
        最近失败：{{ date(state.lastFailure.at) }} · {{ state.lastFailure.message }}（{{ state.lastFailure.code }}）。已有成功恢复点保留，失败或未完成目录不作为成功恢复点。
      </p>
      <p v-if="state.latestSuccess && !state.latestSuccess.configuration.complete" class="m-0 rounded-xl border border-amber-300 p-3 text-sm">
        最近恢复点的数据库校验通过，但创建时记录了配置恢复缺口：{{ state.latestSuccess.configuration.gaps.join('；') }}。恢复前需核对相应配置，不能仅凭数据库校验通过启动。
      </p>
      <p class="m-0 text-sm text-muted">配置完整性按本实例的配置文件与对应代码默认值判断；未使用 IDE 不要求 .run。必需密钥必须与数据库配套验证。历史记录保留创建时的判定，不随当前配置重写。</p>
      <div v-if="state.points.length" class="max-h-80 overflow-auto rounded-xl border border-border">
        <table class="w-full text-left text-sm">
          <caption class="p-3 text-left font-semibold">已完成恢复点 · {{ state.points.length }} 份</caption>
          <thead class="bg-surface-alt"><tr><th class="p-3">完成时间 / 标识</th><th class="p-3">原因 / 版本</th><th class="p-3">结果</th></tr></thead>
          <tbody><tr v-for="point in state.points" :key="point.id" class="border-t border-border">
            <td class="p-3 align-top">{{ date(point.completedAt) }}<div class="break-all font-mono text-xs text-muted">{{ point.id }}</div></td>
            <td class="p-3 align-top">{{ reason(point.reason) }}<div class="text-xs text-muted">数据库 {{ point.schemaVersions.at(-1) || '无迁移标记' }} · {{ point.codeVersion.slice(0, 12) }}</div><div class="text-xs text-muted break-all">来源实例 {{ point.instanceId }}</div></td>
            <td class="p-3 align-top">完整性 / 外键通过 · {{ size(point.bytes) }}<div class="text-xs text-muted">{{ point.configuration.complete ? '配置材料与默认值已覆盖' : '创建时配置有缺口，恢复前需核对' }} · {{ Math.round(point.timings.totalMs) }} ms</div><div v-if="point.configuration.gaps.length" class="text-xs break-words">{{ point.configuration.gaps.join('；') }}</div></td>
          </tr></tbody>
        </table>
      </div>
      <p class="m-0 text-sm text-muted">恢复必须先停止写入、保留当前现场，在隔离目录核对应用版本、配置密钥及备份后的文件变动。这里不提供覆盖主库、下载密钥或自动重跑历史任务的操作。</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth';
import { createApplicationRecoveryPoint, fetchApplicationRecoveryStatus, type ApplicationRecoveryStatus } from '../api/application-recovery';
const auth = useAuthStore();
const state = ref<ApplicationRecoveryStatus | null>(null);
const error = ref<string | null>(null);
const loading = ref(false), creating = ref(false);
let generation = 0, disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
function cancelTimer() { if (timer) clearTimeout(timer); timer = undefined; }
function current(token: number) { return !disposed && auth.capabilities.canAccessSettings && token === generation; }
function poll() { cancelTimer(); if (!disposed && state.value?.active && auth.capabilities.canAccessSettings) timer = setTimeout(() => { void load(); }, 2000); }
async function load() {
  if (disposed || !auth.capabilities.canAccessSettings || creating.value) return;
  cancelTimer(); const token = ++generation; loading.value = true;
  try { const result = await fetchApplicationRecoveryStatus(); if (current(token)) { state.value = result; error.value = null; poll(); } }
  catch (e) { if (current(token)) error.value = e instanceof Error ? e.message : '读取恢复点状态失败'; }
  finally { if (current(token)) loading.value = false; }
}
async function create() {
  if (creating.value || loading.value || !state.value || state.value.active || !auth.capabilities.canAccessSettings) return;
  cancelTimer(); const token = ++generation; creating.value = true; error.value = null;
  try { const result = await createApplicationRecoveryPoint(); if (current(token)) { state.value = result; poll(); } }
  catch (e) { if (current(token)) error.value = e instanceof Error ? e.message : '创建恢复点失败'; }
  finally { if (current(token)) creating.value = false; }
}
function date(value: string) { const d = new Date(value); return Number.isNaN(d.getTime()) ? '时间未知' : d.toLocaleString(); }
function size(bytes: number) { return `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }
function reason(value: string) { return ({ manual: '手动', daily: '日常', 'pre-migration': '升级 / 修复前', 'pre-rebuild': '重建索引前', maintenance: '维护操作前' } as Record<string,string>)[value] ?? value; }
watch(() => [auth.capabilities.canAccessSettings, auth.role, auth.authenticated] as const, () => {
  ++generation; cancelTimer(); state.value = null; error.value = null; loading.value = false; creating.value = false;
  if (auth.capabilities.canAccessSettings) void load();
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; ++generation; cancelTimer(); });
</script>
