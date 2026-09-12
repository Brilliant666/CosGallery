import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import IngestPerformance from './IngestPerformance.vue';
describe('IngestPerformance', () => {
  it('shows only valid measured stages of the latest run', () => {
    const wrapper=mount(IngestPerformance,{props:{performance:{version:1,latest:{operation:'run',status:'ingested',durationMs:3456,phases:{source_hash:1000,gallery_index:0,outer_extract:-1,cleanup:Infinity,unknown:999}},history:[{durationMs:90000}]}}});
    expect(wrapper.text()).toContain('3.46 秒');
    expect(wrapper.text()).toContain('源压缩包哈希');
    expect(wrapper.text()).toContain('0.00 秒');
    expect(wrapper.text()).not.toContain('外层解压');
    expect(wrapper.text()).not.toContain('90.00');
  });
  it.each([undefined,null,{}, {version:2,latest:{durationMs:10}}, {version:1,latest:{durationMs:NaN}}])('does not invent missing history (%j)', performance => {
    expect(mount(IngestPerformance,{props:{performance}}).text()).toContain('旧任务未记录分阶段耗时');
  });
  it('distinguishes same-volume moves from historical copies', () => {
    const wrapper = mount(IngestPerformance, {props: {performance: {version: 1, latest: {operation: 'run', durationMs: 500, phases: {staging_move: 120}}}}});
    expect(wrapper.text()).toContain('同卷暂存移动');
    expect(wrapper.text()).toContain('0.12 秒');
    expect(wrapper.text()).not.toContain('暂存文件复制');
  });
});
