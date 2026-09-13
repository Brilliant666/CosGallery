import {DatabaseSync} from 'node:sqlite';
import {it,expect} from 'vitest';
import {schemaSql} from '../src/db/schema.js';
import {elyRangeDirectory} from '../src/services/ely-range-directory.js';
import {ArchiveCatalogService} from '../src/services/archive-catalog-service.js';
import {parseCostuanDirectoryText} from '../src/services/costuan-numbering-service.js';
const title='ElyEE子COSPLAY写真作品合集[225套][持续更新]';
const text=['NO.001-NO.066',...Array.from({length:159},(_,i)=>`ElyEE子 NO.${String(i+67).padStart(3,'0')} 示例作品`)].join('\n');
it('expands only the reviewed declaration, keeping media counts unknown',()=>{
  const result=elyRangeDirectory(54,'638',title,text)!;
  expect(result.works).toHaveLength(225);
  expect(result.works[0]).toMatchObject({sourceOrder:'NO.001',mediaSummary:'',declaredImageCount:null,declaredVideoCount:null});
  expect(result.works[0].label).toContain('来源未提供标题');
  expect(elyRangeDirectory(55,'638',title,text)).toBeNull();
  expect(elyRangeDirectory(54,'639',title,text)).toBeNull();
});
it.each(['duplicate','missing','unknown','overlap'])('refuses %s instead of guessing',mode=>{
  let raw=text;
  if(mode==='duplicate')raw+='\nElyEE子 NO.067 重复';
  if(mode==='missing')raw=raw.replace(/[^\n]*NO\.100[^\n]*/,'');
  if(mode==='unknown')raw+='\n无法解释的附加内容';
  if(mode==='overlap')raw+='\nElyEE子 NO.001 重叠';
  expect(()=>elyRangeDirectory(54,'638',title,raw)).toThrow();
});
it('preflight is read-only; completion requires every actual range file, not just the declaration',()=>{
  const db=new DatabaseSync(':memory:');db.exec(schemaSql);
  try {
    db.prepare("INSERT INTO archive_catalog_creators(id,canonical_name,normalized_name,is_active,seed_source,seed_source_creator_id) VALUES (54,'ElyEE子','elyee子',1,'test','54')").run();
    const service=new ArchiveCatalogService(db);
    const record={creatorName:'ElyEE子',costuan:{postId:'638',title,collectionCount:225,resourceDirectoryText:text,works:parseCostuanDirectoryText(text),directoryVerification:{complete:false,parsedWorkCount:160,checkedAt:'2026-09-12T00:00:00Z'}}};
    const before=db.prepare('SELECT total_changes() n').get();
    const proof=service.validateCompleteCostuanDirectory(record,54);
    expect(proof.canonicalWorks).toHaveLength(225);
    expect(proof.requiredFilenames).toContain('066.7z');
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
    const files=Array.from({length:225},(_,i)=>`${String(i+1).padStart(3,'0')}.7z`);
    const full={...proof.record,baidu:{transport:'direct-share',status:'share-verified',shareUrl:'https://pan.baidu.com/s/1synthetic',sourceFolderName:'638',verification:{method:'share-read',complete:true,checkRoundId:'round',checkedAt:'2026-09-12T00:00:00Z',files}}};
    expect(()=>service.validateCompleteCostuanCheck(full,54,'round')).not.toThrow();
    full.baidu.verification.files=files.slice(1);
    expect(()=>service.validateCompleteCostuanCheck(full,54,'round')).toThrow(/唯一核验/);
    expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
  } finally {db.close();}
});
