import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeedItem } from '../types/api';
import ExploreGrid from './ExploreGrid.vue';

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router');

  return {
    ...actual,
    useRoute: () => ({
      fullPath: '/explore?q=animals',
      query: {
        q: 'animals'
      }
    })
  };
});

function createImageItem(id: number): FeedItem {
  return {
    id,
    folderId: 21,
    folderSlug: 'wildlife',
    folderName: 'Wildlife',
    folderPath: 'wildlife',
    folderBreadcrumb: null,
    filename: `photo-${id}.jpg`,
    width: 1200,
    height: 1500,
    mediaType: 'image',
    durationMs: null,
    isAnimated: false,
    thumbnailUrl: `/thumbs/${id}.webp`,
    previewUrl: `/previews/${id}.webp`,
    sortTimestamp: 1_777_000_000_000 + id,
    takenAt: 1_777_000_000_000 + id
  };
}

describe('ExploreGrid', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('builds named post routes so explore tiles resolve through the canonical viewer path', () => {
    const wrapper = mount(ExploreGrid, {
      props: {
        items: [createImageItem(215)]
      },
      global: {
        stubs: {
          ResilientImage: {
            template: '<img data-test="resilient-image" />'
          },
          RouterLink: {
            props: ['custom', 'to'],
            template: `
              <template v-if="custom">
                <span class="router-link-stub" :data-to="typeof to === 'string' ? to : JSON.stringify(to)">
                  <slot href="#" :navigate="() => {}" />
                </span>
              </template>
              <a v-else :data-to="typeof to === 'string' ? to : JSON.stringify(to)"><slot /></a>
            `
          }
        }
      }
    });

    const tileRoute = wrapper.get('a[data-to]');

    expect(tileRoute.attributes('data-to')).toContain('"name":"image"');
    expect(tileRoute.attributes('data-to')).toContain('"id":"215"');
    expect(tileRoute.attributes('data-to')).toContain('"q":"animals"');
  });
});
