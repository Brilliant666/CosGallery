import {expect,it} from 'vitest';
import {parseCostuanDirectoryText} from '../src/services/costuan-numbering-service.js';
import {completeIdentityDirectory} from '../src/services/costuan-identity-evidence.js';
it('prioritizes creator collection order over publisher numbering, with unknown media allowed',()=>{
  const text='Maruemon 001 [ARTGRAVIA] Vol.150\nMaruemon 002 [DJAWA] Rider No69\nMaruemon 003 Miku [137P-1.48GB]';
  const works=parseCostuanDirectoryText(text);
  expect(works.map(w=>w.sourceOrder)).toEqual(['NO.001','NO.002','NO.003']);
  expect(works[0]).toMatchObject({label:'[ARTGRAVIA] Vol.150',declaredImageCount:null,declaredVideoCount:null});
  expect(completeIdentityDirectory(text,'Maruemon合集[3套]',name=>name==='Maruemon')).toBe('Maruemon');
});
it('preserves all dotted directory labels and media without treating dates as works',()=>{
  const rows=Array.from({length:94},(_,i)=>`${String(i+1).padStart(3,'0')}.妮是老虎-陈妮妮UNI 示例[15P2V-111MB]`);
  const works=parseCostuanDirectoryText(['2023.07.14更新：',...rows].join('\n'));
  expect(works).toHaveLength(94);
  expect(works[0]).toMatchObject({sourceOrder:'NO.001',label:'妮是老虎-陈妮妮UNI 示例',mediaSummary:'[15P2V-111MB]'});
  expect(new Set(works.map(w=>w.sourceOrderKey)).size).toBe(94);
  expect(parseCostuanDirectoryText('001.23 数字小数\n2023.07.14更新：')).toHaveLength(0);
});
