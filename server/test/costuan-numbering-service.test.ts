import { describe, expect, it } from 'vitest';
import { songHanaDirectory } from './fixtures/costuan-song-hana-directory.js';

import {
  mergeCostuanDirectoryWorks,
  areCostuanTitlesCompatible,
  normalizeCostuanTitle,
  parseCostuanCollectionCreator,
  splitCostuanCheckDirectory,
  parseCostuanDirectoryText,
  parseCostuanNumbering
} from '../src/services/costuan-numbering-service.js';

describe('Costuan numbering parser', () => {
  it('preserves all 23 public mixed rows and their outer collection identities',()=>{
    const works=parseCostuanDirectoryText(songHanaDirectory);
    expect(works.map(work=>work.sourceOrderKey)).toEqual(Array.from({length:23},(_,i)=>`NO:${String(i+1).padStart(3,'0')}`));
    expect(works[19]).toMatchObject({sourceOrder:'NO.020',label:'[Bimilstory] Vol.02 Micro bikini'});
  });

  it.each(['Song Hana','Example Creator','예시 이름','Example\tCreator'])('prioritizes a bounded multiword creator prefix: %s', name=>{
    const works=parseCostuanDirectoryText(`${name} 020 [Publisher] Vol.02 First\n${name} 021 [Publisher] Vol.02 Second`);
    expect(works.map(work=>work.sourceOrderKey)).toEqual(['NO:020','NO:021']);
    expect(works.map(work=>work.label)).toEqual(['[Publisher] Vol.02 First','[Publisher] Vol.02 Second']);
    expect(parseCostuanNumbering(`${name} 1001 [Publisher] Vol.02 First`)?.key).toBe('NO:1001');
  });

  it.each([
    ['Song Hana VOL 020 Title','VOL:020'],
    ['Song Hana NO 020 Title','NO:020'],
    ['Song Hana VOL.020 021 Title','VOL:020'],
    ['VOL 020 Title','VOL:020'],
    ['[Bimilstory] Vol.02 Title','VOL:002'],
    ['2023.07.14更新：',undefined],
    ['[200P-1GB]',undefined],
    ['Song\nHana 020 [Publisher] Vol.02 Title','VOL:002']
  ])('does not absorb explicit numbers, dates, sizes or cross-line names: %s',(text,key)=>{
    expect(parseCostuanNumbering(text)?.key).toBe(key);
  });
  it('preserves embedded volume labels when comparing source titles',()=>{
    for(const title of ['自分撮りvol.47','自撮Vol.76','自撮り VOL.63','自摄Vol.102']){
      expect(areCostuanTitlesCompatible(`白银81 NO.065 ${title}[121P3V-789MB]`,title,['白银81'])).toBe(true);
    }
    expect(areCostuanTitlesCompatible('白银81 NO.065 自分撮りvol.47','自分撮りvol.48',['白银81'])).toBe(false);
    expect(areCostuanTitlesCompatible('博主 VOL.013 白蕾丝姐姐','博主 VOL.013 白蕾丝姐姐',['博主'])).toBe(true);
    expect(areCostuanTitlesCompatible('博主 VOL.013 白蕾丝姐姐','VOL.013 白蕾丝姐姐',['博主'])).toBe(true);
  });
  it.each([
    ['白银81写真图片包合集[189套][Cosplay][持续更新]','白银81'],
    ['小仓千代w COSPLAY写真图片包合集[182套+微博图][持续更新]','小仓千代w'],
    ['soso_嗖嗖COSPLAY写真图片包合集[26套][持续更新]','soso_嗖嗖'],
    ['Fixture COS 合集[3套]','Fixture'],
    ['白银81写真图片包合集【189套】【COSPLAY】【持续更新】','白银81'],
    ['其他标题[189套][Cosplay][持续更新]',null],
    ['白银81写真图片包合集[189套][Cosplay][持续更新] 广告',null],
  ])('extracts collection creator without reading category tags as identity: %s',(title,expected)=>{
    expect(parseCostuanCollectionCreator(title)).toBe(expected);
  });

  it('uses the same identity parser for a postposed-category supplemental directory',()=>{
    const result=splitCostuanCheckDirectory('Fixture写真图片包合集[1套+微博图][Cosplay][持续更新]',
      [{sourceOrder:'NO.001',order:1,label:'Work'}],'Fixture 微博图[2P]\nFixture NO.001 Work[1P]');
    expect(result.works).toHaveLength(1);
    expect(result.supplementalContents[0]).toMatchObject({label:'Fixture 微博图',status:'awaiting_review'});
  });

  const weiboLabels=['微博图','微博散图','微博配图'];
  it.each(weiboLabels.flatMap(titleLabel=>weiboLabels.map(directoryLabel=>[titleLabel,directoryLabel])))
    ('separates the limited Weibo appendix aliases %s / %s without rewriting raw evidence',(titleLabel,directoryLabel)=>{
      const rawTitle=`rioko凉凉子 ${directoryLabel}[12P-20MB]`;
      const result=splitCostuanCheckDirectory(`rioko凉凉子COSPLAY写真图片包合集[2套+${titleLabel}][持续更新]`,
        [{sourceOrder:'NO.001',order:1,label:'First'},{sourceOrder:'NO.002',order:2,label:'Second'}],
        `${rawTitle}\nrioko凉凉子 NO.001 First[1P]\nrioko凉凉子 NO.002 Second[1P]`);
      expect(result.works.map(work=>work.sourceOrderKey)).toEqual(['NO:001','NO:002']);
      expect(result.supplementalContents).toHaveLength(1);
      expect(result.supplementalContents[0]).toMatchObject({
        label:`rioko凉凉子 ${directoryLabel}`,rawTitle,status:'awaiting_review',
        sourceOrderKey:parseCostuanDirectoryText(rawTitle)[0].sourceOrderKey
      });
    });

  it('keeps NO and VOL as distinct parts of work identity', () => {
    expect(parseCostuanNumbering('博主 NO.013 黑护士')).toMatchObject({
      scheme: 'NO',
      order: 13,
      key: 'NO:013',
      canonicalLabel: 'NO.013'
    });
    expect(parseCostuanNumbering('博主 Vol.13 白蕾丝姐姐')).toMatchObject({
      scheme: 'VOL',
      order: 13,
      key: 'VOL:013',
      canonicalLabel: 'VOL.013'
    });
    expect(parseCostuanNumbering('NO.013')?.key).not.toBe(parseCostuanNumbering('VOL.013')?.key);
  });

  it('normalizes Costuan separators, casing and local creator prefixes', () => {
    for (const value of [
      '五更百鬼_NO.010 巫女',
      '五更百鬼-NO.010 巫女',
      '五更百鬼 NO 010 巫女',
      '五更百鬼 no_010 巫女',
      '五更百鬼 -NO.010 巫女'
    ]) {
      expect(parseCostuanNumbering(value)?.key).toBe('NO:010');
    }
    expect(parseCostuanNumbering('五更百鬼_NO.010')?.rawLabel).toBe('_NO.010');
    expect(parseCostuanNumbering('五更百鬼-NO.010')?.rawLabel).toBe('-NO.010');
    for (const value of ['VOL.003', 'Vol.3', 'vol 3', 'VOL_003']) {
      expect(parseCostuanNumbering(value)?.key).toBe('VOL:003');
    }
  });

  it('parses pure VOL directories and preserves original declarations', () => {
    const text = Array.from({ length: 44 }, (_, index) => {
      const order = String(index + 1).padStart(3, '0');
      return `佳佳好难啊 VOL.${order} 作品${order} [${index + 1}P-1V-${index + 10}MB]`;
    }).join('\n');
    const works = parseCostuanDirectoryText(text);

    expect(works).toHaveLength(44);
    expect(works[0]).toMatchObject({
      sourceOrder: 'VOL.001',
      sourceOrderRaw: 'VOL.001',
      sourceOrderScheme: 'VOL',
      sourceOrderKey: 'VOL:001',
      label: '作品001',
      declaredImageCount: 1,
      declaredVideoCount: 1,
      declaredSize: '10MB'
    });
    expect(works[43].sourceOrderKey).toBe('VOL:044');
  });

  it('parses mixed NO/VOL sets, qualified volumes and stable special entries', () => {
    const works = parseCostuanDirectoryText([
      '眼酱大魔王w NO.013 黑护士 [12P-20MB]',
      '眼酱大魔王w Vol.13 白蕾丝姐姐 [20P-30MB]',
      '眼酱大魔王w VOL.33 增刊 夏日 [9P-10MB]',
      '眼酱大魔王w VOL增刊OL5 特别篇 [8P-9MB]',
      '眼酱大魔王w 无编号自拍 [7P-8MB]'
    ].join('\n'));

    expect(works.map((work) => work.sourceOrderKey)).toEqual([
      'NO:013',
      'VOL:013',
      'VOL:033:增刊',
      'SPECIAL:vol增刊ol5',
      'SPECIAL:眼酱大魔王w无编号自拍'
    ]);
    expect(works[3]).toMatchObject({
      sourceOrderScheme: 'SPECIAL',
      sourceOrder: 'VOL增刊OL5',
      label: '特别篇'
    });
    expect(works[4]).toMatchObject({
      sourceOrderScheme: 'SPECIAL',
      label: '眼酱大魔王w 无编号自拍',
      rawTitle: '眼酱大魔王w 无编号自拍 [7P-8MB]'
    });
  });

  it('rebuilds lossy works from raw directory text and remains idempotent', () => {
    const raw = [
      '五更百鬼 _NO.010 巫女 [10P-20MB]',
      '五更百鬼 VOL.001 兔玩映画 五更百鬼 白咝JK [10P-26MB]'
    ].join('\n');
    const existing = [{ order: 10, sourceOrder: 'NO.010', label: '巫女' }];
    const first = mergeCostuanDirectoryWorks(existing, raw);
    const second = mergeCostuanDirectoryWorks(first, raw);

    expect(first).toHaveLength(2);
    expect(first.map((work) => work.sourceOrderKey)).toEqual(['NO:010', 'VOL:001']);
    expect(second).toEqual(first);
    expect(first[1].rawTitle).toContain('白咝JK');
    expect(normalizeCostuanTitle(first[1].rawTitle ?? '')).toContain('白丝jk');
  });
});
