<template>
  <details class="acquisition-policy">
    <summary>来源补缺策略（可选） · {{ model ? '已启用本地满足' : '仅入库，暂不决定是否需要补充' }}</summary>
    <p>想收进图库，不代表已经认可这份资源完整或足以满足获取需求。不确定时保持关闭即可。</p>
    <label class="check"><input v-model="model" data-test="admission-accept-version" type="checkbox" :disabled="locked" />确认同套后，以本地副本满足获取需求，不重复下载</label>
    <p>关闭不影响本地入库，也不禁止以后关联来源。启用后，本次已有来源仍须逐项勾选；以后来源导入时，仅在可靠匹配和本地有效性校验通过后才自动记录满足。</p>
    <p>此选项不证明文件完整或与来源相同，不会立即检查网站或下载；仅在最终确认并执行时保存，不改写旧批次决定。</p>
  </details>
</template>

<script setup lang="ts">
defineProps<{ locked: boolean }>();
const model = defineModel<boolean>({ required: true });
</script>

<style scoped>
.acquisition-policy{margin:1rem 0;padding:.8rem 1rem;border:1px solid #8883;border-radius:.65rem}
summary{cursor:pointer;font-size:.88rem}p{font-size:.82rem;line-height:1.6;opacity:.8;margin:.7rem 0}
.check{display:flex;align-items:flex-start;gap:.6rem;font-size:.88rem;line-height:1.6}input{margin-top:.3rem;flex:none}
</style>
