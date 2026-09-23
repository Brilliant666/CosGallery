import { defineComponent, ref } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import CreatorAdmissionView from './CreatorAdmissionView.vue';

describe('creator admission container', () => {
  it('retains module state and exact route when switching, with distinct navigation hierarchy', async () => {
    const Local = defineComponent({ setup() { return { choice: ref('') }; }, template: '<section><h2>本地入库</h2><input aria-label="未提交选择" v-model="choice" /></section>' });
    const Costuan = defineComponent({ template: '<section><h2>Costuan入库</h2></section>' });
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/creator-admission', name: 'creator-admission', component: CreatorAdmissionView, children: [
      { path: 'local', name: 'local-admission-workspace', component: Local },
      { path: 'costuan', name: 'costuan-admission', component: Costuan },
      { path: 'review', name: 'local-review', component: Costuan }
    ] }, { path: '/archive-catalog', name: 'archive-catalog', component: Local }] });
    await router.push('/creator-admission/local?collection=confirmed#results');
    const wrapper = mount(RouterView, { global: { plugins: [router] } });
    await flushPromises();
    await wrapper.get('input').setValue('人工暂缓保留');
    await wrapper.get('a[href="/creator-admission/costuan?workspace=source"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('h1').text()).toBe('博主入库');
    expect(wrapper.findAll('h1')).toHaveLength(1);
    await router.push('/creator-admission/costuan?workspace=ingest&jobId=42');
    await flushPromises();
    await wrapper.get('a[href="/creator-admission/local?collection=confirmed#results"]').trigger('click');
    await flushPromises();
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('人工暂缓保留');
    expect(router.currentRoute.value.query.collection).toBe('confirmed');
    expect(wrapper.get('a[href="/creator-admission/costuan?workspace=ingest&jobId=42"]').exists()).toBe(true);
    await router.push('/creator-admission/review?kind=stage3&jobId=42');
    await flushPromises();
    expect(wrapper.get('nav[aria-label="入库方式"] a[aria-current="page"]').text()).toBe('Costuan');
    wrapper.unmount();
  });
});
