<template>
  <aside class="acquisition-policy" aria-label="入库与后续获取规则">
    <template v-if="retry"><strong>本次重试保留原请求的策略和选择</strong><p>不补加新的来源接受决定，不改变已提交的计划。</p></template>
    <template v-else><strong>已入库的同一作品不重复获取</strong>
    <details><summary>条件与例外</summary><p>可靠对应且本地仍有效时复用；身份或版本冲突仍需核对。</p><p>本批确认接纳后，后续来源可靠对应同一作品且本地记录仍有效时，默认复用本地资源，无需另行勾选。这不代表文件完整或与来源逐字节相同。</p><p>本次已有具体来源仍按作品下选定的对应项处理；批次出处不代表每套作品对应。身份、版本存在冲突或本地副本失效时仍需核对，不会把同一博主的所有来源标记为已满足。</p><p>仅在最终确认并执行时保存本批规则，不立即检查网站或下载，不改写已确认的历史计划、排除或撤销决定。</p></details></template>
  </aside>
</template>

<script setup lang="ts">
defineProps<{ retry: boolean }>();
</script>

<style scoped>
.acquisition-policy{display:flex;align-items:baseline;flex-wrap:wrap;gap:.35rem .7rem;margin:.35rem 0}.acquisition-policy p{max-width:85ch}.acquisition-policy details[open]{flex-basis:100%}
strong,summary{font-size:.88rem}summary{cursor:pointer}p{font-size:.82rem;line-height:1.6;opacity:.8;margin:.7rem 0}
</style>
