<template>
  <aside v-if="mediaLoadNotice" class="fixed bottom-5 right-5 z-[100] max-w-[min(30rem,calc(100vw-2.5rem))] rounded-xl border border-border bg-surface p-4 text-sm text-text shadow-xl" role="alert" aria-live="polite" data-test="media-load-notice">
    <strong>{{ mediaLoadNotice.code === 'SOURCE_INDEX_OUTDATED' ? '源文件已变化，索引待更新' : '媒体地址已过期' }}</strong>
    <p v-if="mediaLoadNotice.code === 'SOURCE_INDEX_OUTDATED'" class="my-2">
      受影响的缩略图或预览尚未修复；即使原图回退可显示，也不表示缓存已修复。
      {{ auth.canManageLibrary ? '请在设置的图库控制中核对路径，手动运行“扫描图库”；索引更新后重新打开图集。' : '请联系管理员更新图库索引，再重新打开图集。' }}
    </p>
    <p v-else class="my-2">索引版本已经更新，请重新打开当前图集取得新媒体地址。本提示不会自动刷新或重复执行任务。</p>
    <div class="flex items-center gap-4">
      <RouterLink v-if="mediaLoadNotice.code === 'SOURCE_INDEX_OUTDATED' && auth.canManageLibrary" to="/settings" class="text-accent" @click="clearMediaDiagnostics">打开图库设置</RouterLink>
      <button type="button" class="ml-auto text-muted" @click="clearMediaDiagnostics">关闭提示</button>
    </div>
  </aside>
</template>
<script setup lang="ts">
import { watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { clearMediaDiagnostics, mediaAccessKey, mediaLoadNotice } from '../utils/media-load-diagnostics';
const auth = useAuthStore();
watch(mediaAccessKey, clearMediaDiagnostics);
</script>
