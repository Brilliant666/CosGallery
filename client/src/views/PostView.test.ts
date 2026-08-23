import { defineComponent } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImageDetail } from '../types/api';
import { useViewerStore } from '../stores/viewer';
import PostView from './PostView.vue';

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router');

  return {
    ...actual,
    useRoute: () => ({
      query: {}
    }),
    useRouter: () => ({
      replace: vi.fn()
    })
  };
});

vi.mock('../components/PostViewer.vue', async () => {
  const { defineComponent } = await import('vue');

  return {
    default: defineComponent({
      name: 'PostViewer',
      props: {
        image: {
          type: Object,
          required: true
        }
      },
      template: '<div data-test="post-viewer">{{ image.id }}</div>'
    })
  };
});

vi.mock('../components/ErrorState.vue', async () => {
  const { defineComponent } = await import('vue');

  return {
    default: defineComponent({
      name: 'ErrorState',
      props: {
        title: String,
        message: String
      },
      template: '<div data-test="error-state">{{ title }} {{ message }}</div>'
    })
  };
});

vi.mock('../components/ConfirmDialog.vue', async () => {
  const { defineComponent } = await import('vue');

  return {
    default: defineComponent({
      name: 'ConfirmDialog',
      template: '<div data-test="confirm-dialog"><slot /><slot name="details" /></div>'
    })
  };
});

function createImageDetail(id: number): ImageDetail {
  return {
    id,
    folderId: 7,
    folderSlug: 'peopleplanet',
    folderName: 'PeoplePlanet',
    folderPath: 'PeoplePlanet',
    folderBreadcrumb: null,
    filename: `image-${id}.jpg`,
    width: 1200,
    height: 1500,
    mediaType: 'image',
    durationMs: null,
    isAnimated: false,
    thumbnailUrl: `/thumbnails/${id}.webp`,
    previewUrl: `/previews/${id}.webp`,
    sortTimestamp: 1_777_000_000_000 + id,
    takenAt: 1_777_000_000_000 + id,
    folderAvatarImageId: null,
    relativePath: `PeoplePlanet/image-${id}.jpg`,
    mimeType: 'image/jpeg',
    fileSize: 123_456,
    exif: null,
    originalUrl: `/api/originals/${id}`,
    playbackStrategy: null,
    previousImageId: null,
    nextImageId: null
  };
}

describe('PostView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('does not render the previously loaded post while a new modal image is loading', async () => {
    const viewerStore = useViewerStore();
    viewerStore.$patch({
      image: createImageDetail(1),
      loading: false,
      deleting: false,
      error: null
    });

    let resolveLoad: (() => void) | null = null;
    vi.spyOn(viewerStore, 'loadImage').mockImplementation(async (id: number) => {
      viewerStore.loading = true;
      viewerStore.error = null;

      await new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });

      viewerStore.image = createImageDetail(id);
      viewerStore.loading = false;
    });

    const wrapper = mount(PostView, {
      props: {
        id: '2',
        modal: true
      },
      global: {
        stubs: {
          Transition: false
        }
      }
    });

    expect(wrapper.find('[data-test="post-viewer"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Loading post...');

    resolveLoad?.();
    await flushPromises();

    expect(wrapper.get('[data-test="post-viewer"]').text()).toBe('2');
  });
});
