import { describe, expect, it } from 'vitest';

import {
  buildCostuanWorkCaption,
  parseCostuanSourceOrder
} from '../src/services/costuan-archive-import-service.js';

describe('Costuan archive metadata helpers', () => {
  it('uses only the stable source order to associate local works', () => {
    expect(parseCostuanSourceOrder('rua阮阮/rua阮阮 013 arbitrary local name')).toBe(13);
    expect(parseCostuanSourceOrder('小小奶瓶儿@虎牙 - NO.003 another name')).toBe(3);
    expect(parseCostuanSourceOrder('作品名称中没有平台序号')).toBeNull();
  });

  it('builds the visible label from structured metadata', () => {
    expect(buildCostuanWorkCaption('rua阮阮', '小狗爱神1.0')).toBe('rua阮阮 小狗爱神');
  });
});
