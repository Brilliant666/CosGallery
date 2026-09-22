<template>
  <section class="work-picker" aria-label="选择已有作品">
    <form @submit.prevent="search(1)"><label>搜索已有作品<input v-model="query" placeholder="作品名、目录 NO 或原目录名" /></label><button :disabled="loading">查找作品</button><button type="button" @click="emit('close')">取消选择</button></form>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="loading" role="status">正在读取当前博主的作品…</p>
    <p class="hint">目录 NO 仅用于查找，选择会使用稳定作品身份；不会合并两个既有作品。</p>
    <ul><li v-for="work in page?.items" :key="work.workId"><button type="button" class="work-option" @click="emit('select', work)"><img v-if="work.thumbnailUrl" :src="work.thumbnailUrl" alt="" loading="lazy" /><span><strong>{{ work.catalogNo ? `NO.${String(work.catalogNo).padStart(3, '0')} · ` : '' }}{{ work.title }}</strong><small>{{ work.images }} 图 · {{ work.videos }} 视频 · {{ work.localState }}</small><small>{{ work.originalDirectories.join(' / ') }}</small><small>{{ work.primaryLocalWorkId ? '已有主副本，默认保留' : '当前无主副本' }}</small></span></button></li></ul>
    <p v-if="page && !page.items.length">没有匹配的已有作品。可以保留为独立新作品或暂缓，不强行对应。</p>
    <div v-if="page" class="actions"><button :disabled="loading || page.page <= 1" @click="search(page.page - 1)">上一页作品</button><span>共 {{ page.total }} 套</span><button :disabled="loading || page.page * page.pageSize >= page.total" @click="search(page.page + 1)">下一页作品</button></div>
  </section>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { fetchAdmissionWorks } from '../api/local-admission';
import type { AdmissionPage, AdmissionWork } from '../types/local-admission';
const props = defineProps<{ creatorId: number; initialQuery?: string }>();
const emit = defineEmits<{ select: [work: AdmissionWork]; close: [] }>();
const query = ref(props.initialQuery ?? ''), page = ref<AdmissionPage<AdmissionWork> | null>(null), error = ref(''), loading = ref(false);
let token = 0;
async function search(next: number) { const current = ++token; loading.value = true; error.value = ''; try { const result = await fetchAdmissionWorks(props.creatorId, query.value, next); if (current === token) page.value = result; } catch (cause) { if (current === token) error.value = cause instanceof Error ? cause.message : '作品读取失败'; } finally { if (current === token) loading.value = false; } }
onMounted(() => search(1)); onBeforeUnmount(() => { token++; });
</script>
<style scoped>
.work-picker { padding: 1rem; border: 1px solid var(--border, #ddd); border-radius: 1rem; background: var(--bg, #fafafa); } form,.actions { display:flex; flex-wrap:wrap; align-items:end; gap:.6rem } label { display:grid; gap:.35rem; flex:1 } input,button { border:1px solid #aaa5; border-radius:.6rem; padding:.55rem .8rem; background:var(--surface,white) } button:disabled { opacity:.5 } ul { list-style:none; padding:0; max-height:28rem; overflow:auto } .work-option { display:flex; width:100%; text-align:left; gap:.8rem; margin:.5rem 0 } img { width:3rem; aspect-ratio:2/3; object-fit:cover; border-radius:.3rem } small { display:block; opacity:.75; margin-top:.2rem; word-break:break-word } .hint { font-size:.85rem; opacity:.75 }
</style>
