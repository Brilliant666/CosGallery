import { describe, expect, it } from 'vitest';
import { analyzeCostuanDirectoryCoverage, analyzeCostuanRangeInput } from '../src/services/costuan-directory-coverage.js';
import { completeIdentityDirectory } from '../src/services/costuan-identity-evidence.js';
import { parseCostuanDirectoryText } from '../src/services/costuan-numbering-service.js';

describe('source directory range evidence', () => {
  it('synthetic 133 numbered entries cover 142 numbers; appendix is not a numbered Work', () => {
    // Synthetic contract fixture, NOT a current website capture.
    const lines=Array.from({length:142},(_,i)=>i+1).filter(n=>!(n>=19&&n<=26)&&n!==28).map(n=>
      `Fixture ${n===18?'NO.018-NO.26':n===27?'NO.027-NO.028':`NO.${String(n).padStart(3,'0')}`} Title [1P-1MB]`);
    lines.push('Fixture 微博杂图 [138P-212M]');
    const text=lines.join('\n');
    expect(analyzeCostuanDirectoryCoverage(text,142)).toMatchObject({rawEntryCount:134,numberedEntryCount:133,singleEntryCount:131,
      rangeEntryCount:2,uniqueNumberCount:142,numberingComplete:true});
    expect(completeIdentityDirectory(text,'Fixture COSPLAY写真合集[142套+微薄散图][持续更新]')).toBe('Fixture');
    expect(()=>completeIdentityDirectory(text.replace('Fixture 微博杂图','Other 微博杂图'),'Fixture COSPLAY写真合集[142套+微薄散图][持续更新]')).toThrow(/名称写法不一致/);
  });
  it.each(['','Fixture NO.001 正常 [1P-1MB]',undefined])('does not hide ranges in works behind raw text %s', text=>{
    expect(analyzeCostuanRangeInput(text,[{sourceOrder:'NO.018-NO.026',rawTitle:'Fixture NO.018 Title',label:'Title'}],26)?.rangeEntryCount).toBe(1);
  });
  it('checks legacy raw numbering even when canonical numbering was truncated',()=>{
    expect(analyzeCostuanRangeInput('',[{sourceOrder:'NO.018',sourceOrderRaw:'NO.018-NO.26',label:'Title'}],26)?.ranges[0].count).toBe(9);
  });
  it('counts covered numbers without expanding entries or dividing media totals', () => {
    const text='Example NO.001-NO.003 合集 [155P-368M]\nExample NO.004 单套 [20P-157M]';
    const report=analyzeCostuanDirectoryCoverage(text,4);
    expect(report).toMatchObject({rawEntryCount:2,singleEntryCount:1,rangeEntryCount:1,uniqueNumberCount:4,numberingComplete:true});
    expect(report.ranges[0]).toMatchObject({count:3,declaredImageCount:155,declaredSize:'368M'});
    const works=parseCostuanDirectoryText(text);
    expect(works).toHaveLength(2);
    expect(works[0].order).toBeUndefined();
  });
  it('detects duplicate raw entries before parser deduplication', () => {
    const report=analyzeCostuanDirectoryCoverage('X NO.001-NO.003 合集\nX NO.003 相交\nX NO.003 重复',4);
    expect(report.numberingComplete).toBe(false);
    expect(report.overlaps[0].number).toBe(3);
    expect(report.overlaps[0].owners).toHaveLength(3);
    expect(report.missingNumbers).toEqual([4]);
  });
  it('rejects mixed numbering coverage and out of bounds', () => {
    const report=analyzeCostuanDirectoryCoverage('X NO.001-NO.003 合集\nX VOL.004 四',3);
    expect(report.mixedSchemes).toBe(true);
    expect(report.outsideNumbers).toEqual([4]);
    expect(report.numberingComplete).toBe(false);
  });
});
