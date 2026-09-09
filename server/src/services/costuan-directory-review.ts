import {createHash} from 'node:crypto';
import {z} from 'zod';
import {parseCostuanDirectoryText,parseCostuanNumbering} from './costuan-numbering-service.js';

export const costuanDirectoryReviewSchema=z.object({
  collectionTitle:z.string().min(1),
  numberingKey:z.string().min(1),
  originalRawTitle:z.string().min(1),
  selectedRawTitle:z.string().min(1),
  supplementalRawTitles:z.array(z.string().min(1)).min(1).max(20),
  approvedAt:z.string().datetime({offset:true})
}).strict();
export type CostuanDirectoryReview=z.infer<typeof costuanDirectoryReviewSchema>;
const normalized=(text:string)=>text.normalize('NFKC').replace(/\s+/gu,' ').trim();
export const directoryReviewKey=(creatorId:number)=>`archive.costuan-directory-review.${creatorId}`;

// Explicit server-owned human decision, not a client flag or a general last-entry-wins rule.
export function applyCostuanDirectoryReview(review:CostuanDirectoryReview,title:string,
  input:Array<{sourceOrder:string;rawTitle?:string}>,text:string|undefined) {
  const fail=()=>{throw new Error('来源目录与已确认的人工审核记录不一致；保留原文，需重新人工确认。');};
  if(normalized(title)!==normalized(review.collectionTitle) || !text) return fail();
  const lines=text.split(/\r?\n/u).flatMap(line=>parseCostuanDirectoryText(line));
  const grouped=new Map<string,typeof lines>();
  for(const line of lines)grouped.set(line.sourceOrderKey,[...(grouped.get(line.sourceOrderKey)??[]),line]);
  const revisions=grouped.get(review.numberingKey);
  if(!revisions || revisions.length!==2 || revisions.some(line=>line.order===undefined)
    || normalized(revisions[0].rawTitle)!==normalized(review.originalRawTitle)
    || normalized(revisions[1].rawTitle)!==normalized(review.selectedRawTitle))return fail();
  for(const [key,entries] of grouped)if(entries.length>1 && key!==review.numberingKey)return fail();
  const supplementalContents=lines.filter(line=>line.order===undefined);
  if(supplementalContents.length!==review.supplementalRawTitles.length
    || new Set(review.supplementalRawTitles.map(normalized)).size!==review.supplementalRawTitles.length
    || supplementalContents.some(line=>!review.supplementalRawTitles.some(raw=>normalized(raw)===normalized(line.rawTitle))))return fail();
  const rawNumbered=lines.filter(line=>line.order!==undefined);
  const works=rawNumbered.filter(line=>line!==revisions[0]);
  const signatures=(items:Array<{sourceOrder:string;rawTitle?:string}>)=>items.map(item=>
    `${parseCostuanNumbering(item.sourceOrder)?.key??''}|${normalized(item.rawTitle??'')}`).sort();
  const supplied=JSON.stringify(signatures(input));
  if(supplied!==JSON.stringify(signatures(rawNumbered)) && supplied!==JSON.stringify(signatures(works)))return fail();
  const reviewId=createHash('sha256').update(JSON.stringify(review)).digest('hex');
  return {works,supplementalContents:supplementalContents.map(line=>({...line,status:'awaiting_review' as const})),
    acceptedDirectoryRevisions:[{reviewId,numberingKey:review.numberingKey,originalRawTitle:revisions[0].rawTitle,
      selectedRawTitle:revisions[1].rawTitle,approvedAt:review.approvedAt}]};
}
