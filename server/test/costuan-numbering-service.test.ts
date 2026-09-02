import { describe, expect, it } from 'vitest';

import {
  mergeCostuanDirectoryWorks,
  normalizeCostuanTitle,
  parseCostuanDirectoryText,
  parseCostuanNumbering
} from '../src/services/costuan-numbering-service.js';

describe('Costuan numbering parser', () => {
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
