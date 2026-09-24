<template>
  <div v-if="failure" class="route-recovery-overlay" @keydown.esc.prevent="recovery.cancel()">
    <section ref="dialog" role="alertdialog" aria-modal="true" aria-labelledby="route-recovery-title" aria-describedby="route-recovery-description" class="route-recovery-dialog" @keydown.tab="trapFocus">
      <h2 id="route-recovery-title">{{ title }}</h2>
      <p id="route-recovery-description">{{ description }}</p>
      <p>当前页面仍保留。刷新会离开当前页面；已有本标签页入库草稿会按原规则恢复，但未保存的目录选择、表单或设置可能丢失。可先取消，核对并保存需要保留的内容。</p>
      <p class="text-muted">刷新不会自动提交入库、删除或设置操作。</p>
      <div class="route-recovery-actions">
        <button ref="cancelButton" type="button" @click="recovery.cancel()">取消，留在当前页面</button>
        <button v-if="failure.reason !== 'version'" type="button" :disabled="failure.retrying" @click="recovery.retry()">{{ failure.retrying ? '正在重试…' : '重新尝试打开' }}</button>
        <button type="button" @click="recovery.reload()">刷新并继续前往目标页面</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { RouteLoadRecovery } from '../utils/route-load-recovery';

const props = defineProps<{ recovery: RouteLoadRecovery }>();
const failure = computed(() => props.recovery.state.value);
const cancelButton = ref<HTMLButtonElement>();
const dialog = ref<HTMLElement>();
function trapFocus(event: KeyboardEvent) {
  const buttons = dialog.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
  if (!buttons?.length) return;
  const first = buttons[0], last = buttons[buttons.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
let priorFocus: HTMLElement | null = null;
watch(() => !!failure.value, async visible => {
  if (visible) { priorFocus = document.activeElement as HTMLElement; await nextTick(); cancelButton.value?.focus(); }
  else if (priorFocus?.isConnected) priorFocus.focus();
});
const title = computed(() => failure.value?.reason === 'version' ? '页面资源已更新' : failure.value?.reason === 'offline' ? '当前网络已离线' : '目标页面加载失败');
const description = computed(() => ({
  checking: '正在核对页面资源。尚未进入目标页面，请选择重试或刷新。',
  version: '已确认服务器的页面版本与当前标签页不同。可刷新后继续前往原目标，保留其查询与定位信息。',
  offline: '请恢复网络连接后重试。当前不能判断是否有新版本。',
  network: '页面资源和连接检查未成功。请检查连接后重试；尚不能确认是版本更新。',
  unknown: '未能加载目标页面的程序资源，原因尚未确认。可以重试；若浏览器保留了失败的加载结果，可选择刷新。'
}[failure.value?.reason ?? 'unknown']));
</script>

<style scoped>
.route-recovery-overlay { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; padding: 1.5rem; background: rgb(0 0 0 / 45%); }
.route-recovery-dialog { width: min(100%, 38rem); max-height: 90vh; overflow: auto; border: 1px solid var(--border); border-radius: 1rem; padding: 1.5rem; background: var(--surface, #fff); color: var(--text); box-shadow: 0 12px 40px rgb(0 0 0 / 20%); }
.route-recovery-dialog h2 { margin: 0 0 1rem; font-size: 1.2rem; }
.route-recovery-dialog p { line-height: 1.65; }
.route-recovery-actions { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: 1.25rem; }
.route-recovery-actions button { border: 1px solid var(--border); border-radius: .6rem; padding: .6rem .8rem; }
</style>
