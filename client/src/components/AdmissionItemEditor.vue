<template>
  <article class="item-card" :data-test="'admission-item-'+item.key">
    <div class="item-heading"><div><small>{{ item.group }} · {{ admissionGroups[item.group] }}</small><h3>{{ item.displayTitle }}</h3><p class="path">{{ item.sourceRelativePath }}</p></div><span>{{ item.summary.images }} 图 · {{ item.summary.videos }} 视频<small>{{ mediaSize(item.summary.bytes) }} · {{ item.summary.other }} 附件 / 其他</small></span></div>
    <p v-if="item.group==='A'" class="hint">目前未找到已有作品候选，不等于已证明从未收录。可查找已有作品；确认独立时仍可选择新作品。</p>
    <ul v-if="item.reviewIssues?.length" class="review-issues" aria-label="本项核对原因"><li v-for="issue in item.reviewIssues" :key="issue">{{ admissionReviewIssueLabels[issue] }}</li></ul>
    <p v-for="warning in item.conflicts" :key="warning" class="warning">{{ warning==='target exists'?'目标路径已占用，不能覆盖；请核对现有目录，不要仅靠改名消除提示。':warning }}</p>
    <div v-if="item.structureWarnings?.length" class="warning"><strong>目录边界提示</strong><p v-for="warning in item.structureWarnings" :key="warning">{{ warning }}</p><small>先核对是否属于一套；若确认保留整组，可明确选择新独立作品。本页不自动拆合。</small></div>
    <AdmissionCurrentDisposition :disposition="item.currentDisposition" :creator-id="creatorId" />
    <fieldset v-if="!isAdmissionCompletedLater(item)" :disabled="locked">
      <label>本次处理<select :value="model.action" @change="changeKind"><option value="defer">暂缓，保留等待区文件</option><option value="new">接纳为新独立作品</option><option value="existing">对应已有作品</option><option value="same-as">与本批另一目录同套</option><option value="skip">跳过本次导入，保留等待区文件</option></select></label>
      <button v-if="model.selectionOrigin==='scope-review'&&model.action==='defer'" type="button" data-test="scope-review-keep-deferred" @click="keepDeferred">本项保留暂缓</button>
      <section v-if="item.candidates.length||item.candidatesTruncated" class="candidate-review" aria-label="已有作品候选及依据">
        <strong>已有作品候选 · {{ item.candidates.length }} 项{{ item.candidatesTruncated?'（仅展示部分）':'' }}</strong>
        <p class="hint">标题、原目录名及文件数量只能辅助核对，未比较媒体内容；精确命中也不代表同一套。版本、副标题或内部编号不同需人工判断，外站 NO 不作为作品身份。</p>
        <p v-if="item.candidatesTruncated" class="warning">候选超过展示上限，请使用“查找已有作品”缩小范围，不自动确认。</p>
        <ul class="candidate-list"><li v-for="candidate in item.candidates" :key="candidate.workId" :data-work-candidate="candidate.workId">
          <strong>{{ candidate.title }}</strong><span class="match-label">{{ candidate.matchEvidence?admissionMatchLabels[candidate.matchEvidence.level]:'历史候选，依据需重新核对' }}</span>
          <p v-for="reason in candidate.matchEvidence?.reasons" :key="reason" class="hint">{{ reason }}</p>
          <p v-if="candidate.originalDirectories.length" class="path">原目录：{{ candidate.originalDirectories.join(' / ') }}</p>
          <div class="actions"><small>{{ candidate.images }} 图 · {{ candidate.videos }} 视频</small><button type="button" @click="selectWork(candidate)">选择此已有作品</button></div>
        </li></ul>
      </section>
      <section v-if="item.peerCandidates?.length||item.peerCandidatesTruncated" class="candidate-review" aria-label="本批相关目录及依据">
        <strong>本批相关目录 · {{ item.peerCandidates?.length||0 }} 项{{ item.peerCandidatesTruncated?'（仅展示部分）':'' }}</strong>
        <p class="hint">仅核对本博主同一父目录下本次选中的图集，不代表内容相同；版本、合集和额外内容仍需人工判断。确认同套且希望保留两份时，先为其中一项选择新作品或已有作品，再将另一项设为“与本批另一目录同套”；不需再次收录可跳过，不能确定则暂缓。</p>
        <p v-if="item.peerCandidatesTruncated" class="warning">本批候选超过展示上限，请缩小导入范围后重新核对，不自动批准。</p>
        <ul class="candidate-list"><li v-for="peer in item.peerCandidates" :key="peer.sourceRelativePath">
          <strong class="path">{{ peer.sourceRelativePath }}</strong>
          <p v-for="reason in peer.reasons" :key="reason" class="hint">{{ reason }}</p>
        </li></ul>
      </section>
      <template v-if="model.action==='new'"><label>展示名称<input v-model="model.displayTitle" maxlength="500" @input="markManual" /></label><p class="hint">保留原目录名与内部结构；允许以后可靠来源关联，不自动建立来源对应。</p></template>
      <template v-if="model.action==='existing'">
        <div class="actions"><button type="button" @click="showPicker=!showPicker">{{ selectedWork?'改选已有作品':'查找已有作品' }}</button></div>
        <AdmissionWorkPicker v-if="showPicker" :creator-id="creatorId" @select="selectWork" @close="showPicker=false" />
        <div v-if="selectedWork" class="work-selection"><img v-if="selectedWork.thumbnailUrl" :src="selectedWork.thumbnailUrl" alt="所选作品封面" loading="lazy" /><div><strong>对应：{{ selectedWork.title }}</strong><p>{{ selectedWork.images }} 图 · {{ selectedWork.videos }} 视频 · {{ selectedWork.originalDirectories.join(' / ') }}</p></div></div>
        <p v-else-if="model.workId" class="hint">对应作品 #{{ model.workId }}（展示资料未缓存；原选择不变）</p>
        <label class="check"><input v-model="model.primary" type="checkbox" />本目录作为主副本（不选则保留已有主副本）</label>
        <div v-if="acceptExistingVersion&&selectedWork?.sources.length"><p>本次明确以本地副本满足以下来源的获取需求（仅限勾选项，不证明内容完整或相同）：</p><label v-for="source in selectedWork.sources" :key="source.sourceWorkId" class="check"><input v-model="model.acceptSourceIds" type="checkbox" :value="source.sourceWorkId" />{{ source.sourceOrder }} {{ source.title }} · {{ source.mediaSummary||'来源数量未声明' }}</label></div>
      </template>
      <template v-if="model.action==='same-as'"><label>同套的本博主目录<select v-model="model.sameAsKey"><option :value="undefined">选择目录，不以同名自动确认</option><option v-for="peer in peers.filter(peer=>!isAdmissionCompletedLater(peer.item)&&peer.item.key!==item.key&&['new','existing'].includes(peer.action.action))" :key="peer.item.key" :value="peer.item.key">{{ peer.item.sourceRelativePath }}</option></select></label><label class="check"><input v-model="model.primary" type="checkbox" />使用本目录作为这一套的主副本，另一份保留</label></template>
      <details v-if="!['new','defer'].includes(model.action)"><summary>选择依据 / 备注</summary><label>备注<input v-model="model.reason" maxlength="2000" placeholder="记录本次依据，不默认声称逐字节相同" /></label></details>
      <details class="item-ads" v-if="item.ads.length&&isAdmissionSelected(model)"><summary>附件候选 · {{ item.ads.length }} 项（已选 {{ model.approvedAds?.length||0 }} 项）</summary><p class="hint">首次选择接纳时默认勾选全部候选；需要保留的文件请取消，重新核对后仍保留取消选择。最终确认后，勾选的具体文件{{ recycleAds?'完成索引后送入Windows回收站':'按原确认方式移至可恢复附件区' }}，不永久删除，不打开链接。</p><label v-for="ad in item.ads" :key="ad.relativePath" class="check"><input v-model="model.approvedAds" type="checkbox" :value="ad.relativePath" @change="changeAds" />{{ ad.relativePath }} · {{ mediaSize(ad.size) }}<small v-if="ad.automatic">全局已确认广告（可取消）</small></label></details>
    </fieldset><p v-if="!isAdmissionCompletedLater(item)&&isAdmissionSelected(model)" class="path">实际目标：{{ item.targetPath }}</p>
  </article>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import AdmissionWorkPicker from './AdmissionWorkPicker.vue';
import AdmissionCurrentDisposition from './AdmissionCurrentDisposition.vue';
import { admissionAction,admissionGroups,admissionMatchLabels,admissionReviewIssueLabels,admissionScopeReviewReason,isAdmissionCompletedLater,isAdmissionSelected,mediaSize,rememberAdmissionAdCancellations,type AdmissionEntry } from '../utils/admission-ui';
import type { AdmissionAction,AdmissionActionKind,AdmissionItem,AdmissionWork } from '../types/local-admission';
const props=defineProps<{item:AdmissionItem;creatorId:number;peers:AdmissionEntry[];locked:boolean;acceptExistingVersion:boolean;selectedWork?:AdmissionWork;recycleAds?:boolean}>();
const model=defineModel<AdmissionAction>({required:true}),emit=defineEmits<{'select-work':[work:AdmissionWork];change:[]}>(),showPicker=ref(false);
function markManual(){if(props.locked)return;if(model.value.selectionOrigin==='scope-review'&&model.value.reason===admissionScopeReviewReason)delete model.value.reason;model.value.selectionOrigin='manual';emit('change');}
function changeAds(){if(props.locked)return;rememberAdmissionAdCancellations(props.item,model.value);emit('change');}
function keepDeferred(){if(props.locked)return;model.value={...admissionAction(props.item,'defer',model.value),reason:'用户明确保留本项暂缓，不随范围确认预选'};emit('change');}
function changeKind(event:Event){if(props.locked)return;const value=(event.target as HTMLSelectElement).value;if(!['new','existing','same-as','skip','defer'].includes(value))return;model.value=admissionAction(props.item,value as AdmissionActionKind,model.value);emit('change');}
function selectWork(work:AdmissionWork){if(props.locked)return;model.value={...admissionAction(props.item,'existing',model.value),workId:work.workId,reason:'用户在确认页选择对应已有作品'};showPicker.value=false;emit('select-work',work);emit('change');}
</script>
<style scoped>
.review-issues{display:flex;flex-wrap:wrap;gap:.4rem;list-style:none;padding:0}.review-issues li,.match-label{font-size:.78rem;border:1px solid #aa773344;padding:.2rem .45rem;border-radius:.3rem}.candidate-review{margin:.7rem 0;padding:.8rem;background:#8881;border-radius:.5rem}.candidate-list{list-style:none;margin:.6rem 0 0;padding:0;max-height:24rem;overflow:auto}.candidate-list li{padding:.7rem 0;border-top:1px solid #8883;overflow-wrap:anywhere}.candidate-list .match-label{display:inline-block;margin-left:.5rem}.candidate-list p{margin:.35rem 0}
.item-card{padding:1rem;border:1px solid #8883;border-radius:.85rem;margin:1rem 0;min-width:0}.item-heading{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}h3{font-size:1rem;margin:.4rem 0}small,.hint{font-size:.78rem;line-height:1.6;opacity:.76}span small{display:block}.path{font-size:.82rem;overflow-wrap:anywhere;opacity:.8}.warning{color:#996211;background:#eeaa1110;padding:.65rem;border-radius:.5rem}.actions{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center}label{display:grid;gap:.4rem;margin:.7rem 0}.check{display:flex;gap:.6rem;align-items:flex-start}fieldset{border:0;padding:0;min-width:0}button,input,select{font:inherit;border:1px solid #8884;border-radius:.5rem;padding:.55rem .75rem;background:var(--bg,#fafafa);color:inherit;max-width:100%}button{cursor:pointer}button:disabled{opacity:.4}summary{cursor:pointer}details{margin:.7rem 0}.work-selection{display:flex;gap:.8rem;margin:.8rem 0}.work-selection div{min-width:0;overflow-wrap:anywhere}.work-selection img{width:3.5rem;aspect-ratio:2/3;object-fit:cover;border-radius:.3rem}
</style>
