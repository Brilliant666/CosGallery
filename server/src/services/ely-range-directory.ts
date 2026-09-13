import {parseCostuanDirectoryText} from './costuan-numbering-service.js';

/** User-reviewed exception: Costuan 638 / creator 54 only. Not a general range expander. */
export function elyRangeDirectory(creatorId:number, postId:string, title:string, text:string|undefined) {
  if(creatorId!==54 || postId!=='638') return null;
  const lines=(text??'').split(/\r?\n/u).map(line=>line.normalize('NFKC').trim()).filter(Boolean);
  const marker=/^NO\.001\s*[-–—]\s*NO\.066$/iu;
  if(!lines.some(line=>marker.test(line))) return null;
  if(!/^ElyEE子\s*COSPLAY/u.test(title) || lines.filter(line=>marker.test(line)).length!==1) throw new Error('Ely 范围声明与已核对合集不符');
  const count=Number(title.match(/\[(\d+)套/u)?.[1]);
  if(!Number.isInteger(count)||count<67||count>10000) throw new Error('Ely 合集声明数量无效');
  const works=lines.filter(line=>!marker.test(line)&&!/^\d{4}[./-]\d{1,2}[./-]\d{1,2}更新\s*[:：]?$/u.test(line)).map(line=>{
    const parsed=parseCostuanDirectoryText(line);
    if(!/^ElyEE子\s+NO\./iu.test(line)||parsed.length!==1||parsed[0].order===undefined||parsed[0].order<67||parsed[0].order>count) throw new Error('Ely 范围以外目录含未知条目或编号，需人工核查');
    return parsed[0];
  });
  if(works.length!==count-66 || new Set(works.map(work=>work.sourceOrderKey)).size!==works.length) throw new Error('Ely 后续目录缺号或重复；未补造作品');
  const placeholders=Array.from({length:66},(_,i)=>{
    const number=String(i+1).padStart(3,'0');
    return parseCostuanDirectoryText(`ElyEE子 NO.${number} NO.${number}（来源未提供标题）`)[0];
  });
  return {works:[...placeholders,...works],supplementalContents:[],acceptedDirectoryRevisions:[]};
}
