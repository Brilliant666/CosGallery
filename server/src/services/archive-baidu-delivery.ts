import {z} from 'zod';

const shareUrlSchema=z.string().url().refine(value=>{
  const url=new URL(value);
  return url.protocol==='https:' && url.hostname==='pan.baidu.com' && !url.username && !url.password
    && /^\/s\/[^/]+\/?$/u.test(url.pathname);
},'必须是百度原分享地址');

export const directShareDeliverySchema=z.object({
  transport:z.literal('direct-share'),status:z.literal('share-verified'),shareUrl:shareUrlSchema,
  sourceFolderName:z.string().trim().min(1).refine(value=>!/[\\/]/u.test(value) && !['.','..'].includes(value)),
  verification:z.object({method:z.literal('share-read'),checkedAt:z.string().datetime({offset:true}),
    checkRoundId:z.string().min(1),complete:z.literal(true),files:z.array(z.string().min(1))})
}).passthrough().superRefine((value,context)=>{
  for(const field of ['destinationPath','sourceDirectory','transferredAt']) {
    if(value[field]!=null && value[field]!=='') context.addIssue({code:z.ZodIssueCode.custom,message:'原分享只读核验不能声称已转存',path:[field]});
  }
});

export function directShareMetadata(value:string|null|undefined) {
  try {const parsed=directShareDeliverySchema.safeParse(JSON.parse(value??'null'));return parsed.success?parsed.data:null;}
  catch{return null;}
}

// Existing deliveries keep the historical owned-folder contract. Direct shares
// must carry explicit read-only proof; no destination path is invented for them.
export function directShareDeliverySql(alias:string):string {
  const json=`CASE WHEN json_valid(${alias}.metadata_json) THEN ${alias}.metadata_json ELSE '{}' END`;
  return `(${alias}.status='share-verified' AND json_extract(${json},'$.transport')='direct-share'
    AND json_extract(${json},'$.verification.method')='share-read' AND json_extract(${json},'$.verification.complete')=1
    AND LENGTH(COALESCE(json_extract(${json},'$.verification.checkRoundId'),''))>0
    AND LENGTH(COALESCE(json_extract(${json},'$.verification.checkedAt'),''))>0
    AND LENGTH(COALESCE(json_extract(${json},'$.shareUrl'),''))>0
    AND json_type(${json},'$.verification.files')='array'
    AND TRIM(COALESCE(${alias}.source_folder_name,''))<>'')`;
}

export function usableBaiduDeliverySql(alias:string,filenameSql?:string):string {
  const files=filenameSql ? ` AND (SELECT COUNT(*) FROM json_each(CASE WHEN json_valid(${alias}.metadata_json) THEN ${alias}.metadata_json ELSE '{}' END,'$.verification.files') verified_file WHERE LOWER(verified_file.value)=LOWER(${filenameSql}))=1` : '';
  return `((${alias}.status IN ('saved','already-saved') AND TRIM(COALESCE(${alias}.source_folder_name,''))<>'' AND TRIM(COALESCE(${alias}.destination_path,''))<>'') OR (${directShareDeliverySql(alias)}${files}))`;
}

export function currentBaiduDeliverySql(alias:string,filenameSql?:string):string {
  return `(${usableBaiduDeliverySql(alias,filenameSql)} AND ${alias}.id=(SELECT latest_delivery.id FROM archive_catalog_deliveries latest_delivery
    WHERE latest_delivery.collection_id=${alias}.collection_id AND latest_delivery.provider=${alias}.provider
    ORDER BY latest_delivery.last_seen_at DESC,latest_delivery.id DESC LIMIT 1))`;
}
