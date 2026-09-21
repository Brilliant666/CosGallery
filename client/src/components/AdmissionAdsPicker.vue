<template>
  <details class="batch-ads" aria-label="本批附件集中选择">
    <summary>广告附件 · 已勾选 {{ count }} 个具体文件</summary>
    <p>跨本次全部博主、分页和分组，仅处理已选择接纳的目录。TXT / URL 只是候选，不默认当作广告；跳过和暂缓目录不处理。</p>
    <p>492.jpg、009-01.jpg（ecytt02）沿用全局已确认规则，新选择接纳时默认勾选，可逐项取消。确认后可恢复移出，不清理已入库历史文件。</p>
    <fieldset :disabled="locked"><div class="actions"><button data-test="ads-select-all" :disabled="!rows.length" @click="choose(true)">勾选全部候选</button><button data-test="ads-clear-all" :disabled="!count" @click="choose(false)">清空本批勾选</button></div>
      <div v-for="ad in rows" :key="ad.filename" class="ad-summary-row" :data-ad-filename="ad.filename"><span><strong>{{ ad.filename }}</strong><small>{{ ad.type }} · {{ ad.directories }} 个接纳目录 / {{ ad.files }} 个文件 · 已选 {{ ad.selected }}<template v-if="ad.automatic"> · 全局已确认广告</template></small></span><div class="actions"><button :disabled="ad.selected===ad.files" @click="choose(true,ad.filename)">勾选同名候选</button><button :disabled="!ad.selected" @click="choose(false,ad.filename)">取消同名勾选</button></div></div>
    </fieldset><p v-if="!rows.length">没有匹配附件。勾选和预览均不移动文件，执行前仍需另行确认。</p>
  </details>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { admissionAdSummary, selectAdmissionAds, type AdmissionEntry } from '../utils/admission-ui';
const props=defineProps<{entries:AdmissionEntry[];locked:boolean}>(),emit=defineEmits<{change:[]}>();
const rows=computed(()=>admissionAdSummary(props.entries)),count=computed(()=>rows.value.reduce((n,row)=>n+row.selected,0));
function choose(selected:boolean,filename?:string){if(props.locked)return;selectAdmissionAds(props.entries,selected,filename);emit('change');}
</script>
<style scoped>
.batch-ads{border:1px solid #8883;border-radius:.8rem;padding:1rem;margin:1rem 0}summary{cursor:pointer;font-weight:600}p,small{font-size:.8rem;opacity:.8;line-height:1.6}small{display:block}.actions{display:flex;flex-wrap:wrap;gap:.5rem}.ad-summary-row{display:flex;justify-content:space-between;align-items:center;gap:.8rem;flex-wrap:wrap;border-top:1px solid #8883;padding:.6rem 0;overflow-wrap:anywhere}fieldset{border:0;padding:0;min-width:0}button{font:inherit;padding:.5rem .7rem;border:1px solid #8884;border-radius:.5rem;background:var(--bg);color:inherit;cursor:pointer}button:disabled{opacity:.4;cursor:default}
</style>
