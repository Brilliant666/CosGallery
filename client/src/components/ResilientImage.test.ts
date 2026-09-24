import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ResilientImage from './ResilientImage.vue';
import { clearMediaDiagnostics, mediaLoadNotice } from '../utils/media-load-diagnostics';

describe('ResilientImage', () => {
  afterEach(() => { clearMediaDiagnostics(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('diagnoses an index/source mismatch once and stops automatic broken-image retries', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'SOURCE_INDEX_OUTDATED' }), { status: 409, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const wrapper = mount(ResilientImage, { props: { src: '/thumbnails/source-changed.webp?v=index-A', alt: 'Changed source', retryWhile: true } });
    await wrapper.get('img').trigger('error');
    await flushPromises();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1].headers.Range).toBe('bytes=0-0');
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10000);
    expect(wrapper.find('img').exists()).toBe(false);
    wrapper.unmount();
  });
  it('falls back to the original source when the preview source fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    const wrapper = mount(ResilientImage, {
      props: {
        src: '/previews/NaturePlanet/pexels-photo-2770371.webp',
        fallbackSrc: '/api/originals/2770371',
        alt: 'NaturePlanet preview',
        loading: 'eager'
      }
    });

    expect(wrapper.get('img').attributes('src')).toContain('/previews/NaturePlanet/pexels-photo-2770371.webp');

    await wrapper.get('img').trigger('error');
    await nextTick();

    expect(wrapper.get('img').attributes('src')).toContain('/api/originals/2770371');
    wrapper.unmount();
  });
  it.each(['replace', 'unmount'] as const)('ignores a late source diagnosis after %s', async action => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const wrapper = mount(ResilientImage, { props: { src: '/previews/late.webp?v=A', alt: 'Synthetic' } });
    await wrapper.get('img').trigger('error');
    if (action === 'replace') await wrapper.setProps({ src: '/previews/other.webp?v=B' });
    else wrapper.unmount();
    finish(new Response(JSON.stringify({ code: 'SOURCE_INDEX_OUTDATED' }), { status: 409, headers: { 'content-type': 'application/json' } }));
    await flushPromises();
    expect(mediaLoadNotice.value).toBeNull();
    if (action === 'replace') {
      expect(wrapper.get('img').attributes('src')).toBe('/previews/other.webp?v=B');
      wrapper.unmount();
    }
  });
  it('retains the original fallback but does not call it a repaired derivative', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'SOURCE_INDEX_OUTDATED' }), { status: 409, headers: { 'content-type': 'application/json' } })));
    const wrapper = mount(ResilientImage, { props: { src: '/previews/changed.webp?v=A', fallbackSrc: '/api/originals/3', alt: 'Synthetic' } });
    await wrapper.get('img').trigger('error');
    await wrapper.get('img').trigger('load');
    await flushPromises();
    expect(wrapper.get('img').attributes('src')).toBe('/api/originals/3');
    expect(wrapper.get('img').attributes('data-loaded')).toBe('true');
    expect(mediaLoadNotice.value?.code).toBe('SOURCE_INDEX_OUTDATED');
    wrapper.unmount();
  });
});
