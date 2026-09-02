import { describe, expect, it } from 'vitest';

import {
  buildCostuanWorkCaption,
  parseCostuanSourceKey,
  parseCostuanSourceOrder
} from '../src/services/costuan-archive-import-service.js';

describe('Costuan archive metadata helpers', () => {
  it('uses only the stable source order to associate local works', () => {
    expect(parseCostuanSourceOrder('rua阮阮/rua阮阮 013 arbitrary local name')).toBe(13);
    expect(parseCostuanSourceOrder('小小奶瓶儿@虎牙 - NO.003 another name')).toBe(3);
    expect(parseCostuanSourceOrder('桜桃喵/NO.000 微博配图')).toBe(0);
    expect(parseCostuanSourceOrder('作品名称中没有平台序号')).toBeNull();
    expect(parseCostuanSourceKey('眼酱大魔王w NO.013 黑护士')).toBe('NO:013');
    expect(parseCostuanSourceKey('眼酱大魔王w Vol.13 白蕾丝姐姐')).toBe('VOL:013');
  });

  it('builds the visible label from structured metadata', () => {
    expect(buildCostuanWorkCaption('rua阮阮', '小狗爱神1.0')).toBe('rua阮阮 小狗爱神');
  });
});
