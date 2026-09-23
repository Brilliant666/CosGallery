<template>
  <component :is="expanded?'section':'details'" v-if="rows.length" class="batch-ads" aria-label="本批附件集中选择">
    <component :is="expanded?'h3':'summary'">广告附件 · 已勾选 {{ count }} 个具体文件</component>
    <p>新选择接纳的目录，清单内全部广告候选默认勾选（含 TXT / URL 和已识别的广告图片），可按同名或逐项取消。跨本次全部博主、分页和分组；跳过和暂缓目录不处理。</p>
    <p>手动取消及已有批次的选择不因刷新被重新勾选。{{ recycleAds?'本次新确认将在完成索引后送入Windows回收站，不长期保留专用广告附件区':'历史重试保留原确认方式，具体处置见最终清单' }}，清单外文件和已入库历史文件不处理。</p>
    <fieldset :disabled="locked"><div class="actions"><button data-test="ads-select-all" :disabled="!rows.length" @click="choose(true)">勾选全部候选</button><button data-test="ads-clear-all" :disabled="!count" @click="choose(false)">清空本批勾选</button></div>
      <div v-for="ad in rows" :key="ad.filename" class="ad-summary-row" :data-ad-filename="ad.filename"><label><input type="checkbox" :aria-label="`广告候选：${ad.filename}`" :checked="ad.selected===ad.files" :indeterminate="ad.selected>0&&ad.selected<ad.files" @change="choose(($event.target as HTMLInputElement).checked,ad.filename)" /><span><strong>{{ ad.filename }}</strong><small>{{ ad.type }} · {{ ad.directories }} 个接纳目录 / {{ ad.files }} 个文件 · 已选 {{ ad.selected }}<template v-if="ad.automatic"> · 全局已确认广告</template></small></span></label></div>
    </fieldset>
  </component>
  <p v-else-if="expanded">当前已选入库的目录没有广告候选；跳过和暂缓目录不处理。</p>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { admissionAdSummary, selectAdmissionAds, type AdmissionEntry } from '../utils/admission-ui';
const props=defineProps<{entries:AdmissionEntry[];locked:boolean;recycleAds?:boolean;expanded?:boolean}>(),emit=defineEmits<{change:[]}>();
const rows=computed(()=>admissionAdSummary(props.entries)),count=computed(()=>rows.value.reduce((n,row)=>n+row.selected,0));
function choose(selected:boolean,filename?:string){if(props.locked)return;selectAdmissionAds(props.entries,selected,filename);emit('change');}
</script>
<style scoped>
.batch-ads{border:1px solid #8883;border-radius:.8rem;padding:1rem;margin:1rem 0}summary{cursor:pointer;font-weight:600}p,small{font-size:.8rem;opacity:.8;line-height:1.6}small{display:block}.actions{display:flex;flex-wrap:wrap;gap:.5rem}.ad-summary-row{display:flex;justify-content:space-between;align-items:center;gap:.8rem;flex-wrap:wrap;border-top:1px solid #8883;padding:.6rem 0;overflow-wrap:anywhere}fieldset{border:0;padding:0;min-width:0}button{font:inherit;padding:.5rem .7rem;border:1px solid #8884;border-radius:.5rem;background:var(--bg);color:inherit;cursor:pointer}button:disabled{opacity:.4;cursor:default}
.ad-summary-row label{display:flex;align-items:flex-start;gap:.7rem;cursor:pointer}.ad-summary-row input{margin-top:.4rem}
</style>
