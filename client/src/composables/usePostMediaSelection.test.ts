import { defineComponent, shallowRef } from 'vue';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { galleryTestRouter, workDetail } from '../../test/work-gallery-fixtures';
import { usePostMediaSelection } from './usePostMediaSelection';

describe('usePostMediaSelection', () => {
  enableAutoUnmount(afterEach);
  async function setup(query = '', base = '/post/123') {
    const router = galleryTestRouter();
    await router.push(`${base}${query}`);
    const replace = vi.spyOn(router, 'replace');
    const push = vi.spyOn(router, 'push');
    const image = shallowRef(workDetail());
    let selection!: ReturnType<typeof usePostMediaSelection>;
    const Host = defineComponent({ setup() { selection = usePostMediaSelection(image); return () => null; } });
    mount(Host, { global: { plugins: [router] } });
    await flushPromises();
    return { router, replace, push, selection, image };
  }

  it.each([1, 2, 3, 5])('locates item %i by Image ID, not array index', async (position) => {
    const { selection, replace } = await setup(`?media=${700 + position}&context=work`);
    expect(selection.carouselIndex.value).toBe(position - 1);
    expect(selection.activeMediaItem.value?.imageId).toBe(700 + position);
    expect(replace).not.toHaveBeenCalled();
  });

  it('defaults missing media to the first item without rewriting a valid route', async () => {
    const { selection, replace } = await setup('?context=work');
    expect(selection.carouselIndex.value).toBe(0);
    expect(replace).not.toHaveBeenCalled();
  });

  it.each(['abc', '999', '0', '-1', '1.5', '9007199254740993', '701&media=702', ''])('cleans invalid/foreign query %s using replace only', async (media) => {
    const { selection, replace, push, router } = await setup(`?media=${media}&context=work`);
    expect(selection.carouselIndex.value).toBe(0);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(router.currentRoute.value.query).toEqual({ context: 'work' });
  });

  it('replaces the media query, preserves context, and restores selection after refresh', async () => {
    const { selection, replace, push, router } = await setup('?media=701&context=work');
    selection.carouselIndex.value = 3;
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ context: 'work', media: '704' });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    const refreshed = await setup(router.currentRoute.value.fullPath.replace('/post/123', ''));
    expect(refreshed.selection.activeMediaItem.value?.imageId).toBe(704);
  });

  it('keeps ordinary feed carousel route semantics and clamps internal indices', async () => {
    const { selection, replace, push } = await setup();
    selection.carouselIndex.value = 99;
    expect(selection.carouselIndex.value).toBe(4);
    selection.carouselIndex.value = -5;
    expect(selection.carouselIndex.value).toBe(0);
    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('canonical media uses the route identity, position sequence and replace only, including rapid switches', async () => {
    const { selection, router, push, replace } = await setup('?media=704&q=old&loaded=3', '/library/166/works/123');
    expect(selection.isWorkContext.value).toBe(true);
    expect(selection.activeMediaItem.value?.imageId).toBe(704);
    selection.carouselIndex.value = 2;
    selection.carouselIndex.value = 4;
    await flushPromises();
    expect(selection.activeMediaItem.value?.imageId).toBe(705);
    expect(router.currentRoute.value.path).toBe('/library/166/works/123');
    expect(router.currentRoute.value.query).toEqual({ media: '705', q: 'old', loaded: '3' });
    expect(replace).toHaveBeenCalledTimes(2);
    expect(push).not.toHaveBeenCalled();
  });

  it.each(['999', 'abc', '704&media=705'])('leaves canonical invalid media %s intact for explicit error UI', async media => {
    const { replace, router } = await setup(`?media=${media}`, '/library/166/works/123');
    expect(replace).not.toHaveBeenCalled();
    expect(router.currentRoute.value.fullPath).toContain(`media=${media}`);
  });
});
