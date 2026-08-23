import { defineComponent } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrashItem } from '../types/api';
import { useAppStore } from '../stores/app';
import { useFeedStore } from '../stores/feed';
import { useFoldersStore } from '../stores/folders';
import { useLikesStore } from '../stores/likes';
import { useMomentsStore } from '../stores/moments';
import { useTrashStore } from '../stores/trash';
import TrashView from './TrashView.vue';

const { restoreImageMock, deleteImageMock } = vi.hoisted(() => ({
  restoreImageMock: vi.fn(),
  deleteImageMock: vi.fn()
}));

vi.mock('../api/gallery', async () => {
  const actual = await vi.importActual<typeof import('../api/gallery')>('../api/gallery');

  return {
    ...actual,
    restoreImage: restoreImageMock,
    deleteImage: deleteImageMock
  };
});

vi.mock('../components/ConfirmDialog.vue', async () => {
  const { defineComponent } = await import('vue');

  return {
    default: defineComponent({
      name: 'ConfirmDialog',
      props: {
        title: {
          type: String,
          default: ''
        },
        message: {
          type: String,
          default: ''
        },
        confirmLabel: {
          type: String,
          default: ''
        },
        cancelLabel: {
          type: String,
          default: ''
        },
        loadingLabel: {
          type: String,
          default: ''
        },
        loading: Boolean
      },
      emits: ['cancel', 'confirm'],
      template: `
        <div data-test="confirm-dialog">
          <h2 data-test="confirm-title">{{ title }}</h2>
          <p data-test="confirm-message">{{ message }}</p>
          <button data-test="confirm-button" type="button" :disabled="loading" @click="$emit('confirm')">{{ loading ? loadingLabel : confirmLabel }}</button>
          <button data-test="cancel-button" type="button" @click="$emit('cancel')">{{ cancelLabel }}</button>
          <slot />
          <slot name="details" />
        </div>
      `
    })
  };
});

vi.mock('../components/EmptyState.vue', async () => ({
  default: defineComponent({
    name: 'EmptyState',
    props: {
      title: {
        type: String,
        default: ''
      },
      description: {
        type: String,
        default: ''
      }
    },
    template: '<div data-test="empty-state"><h2>{{ title }}</h2><p>{{ description }}</p></div>'
  })
}));

vi.mock('../components/ErrorState.vue', async () => ({
  default: defineComponent({
    name: 'ErrorState',
    template: '<div data-test="error-state" />'
  })
}));

vi.mock('../components/InfiniteLoader.vue', async () => ({
  default: defineComponent({
    name: 'InfiniteLoader',
    template: '<div data-test="infinite-loader" />'
  })
}));

vi.mock('../components/ResilientImage.vue', async () => ({
  default: defineComponent({
    name: 'ResilientImage',
    template: '<img data-test="resilient-image" />'
  })
}));

function createTrashItem(id: number): TrashItem {
  return {
    id,
    folderId: 12,
    folderSlug: 'trip',
    folderName: 'Trip',
    folderPath: 'trip',
    folderBreadcrumb: null,
    filename: `photo-${id}.jpg`,
    width: 1200,
    height: 800,
    mediaType: 'image',
    durationMs: null,
    isAnimated: false,
    thumbnailUrl: `/thumbnails/${id}.webp`,
    previewUrl: `/previews/${id}.webp`,
    sortTimestamp: 1_777_000_000_000 + id,
    takenAt: 1_777_000_000_000 + id,
    caption: null,
    trashedAt: '2026-04-04T12:00:00.000Z'
  };
}

function createDeferred() {
  let resolve: (() => void) | null = null;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });

  return {
    promise,
    resolve: () => resolve?.()
  };
}

describe('TrashView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    restoreImageMock.mockReset();
    deleteImageMock.mockReset();
  });

  it('closes the restore dialog without waiting for background refreshes', async () => {
    const appStore = useAppStore();
    const trashStore = useTrashStore();
    const foldersStore = useFoldersStore();
    const feedStore = useFeedStore();
    const likesStore = useLikesStore();
    const momentsStore = useMomentsStore();
    const backgroundRefresh = createDeferred();
    const item = createTrashItem(41);

    appStore.$patch({
      stats: {
        folders: 1,
        indexedImages: 1,
        indexedVideos: 0,
        scan: {
          isScanning: false,
          lastCompletedScan: null
        },
        storage: {
          available: true,
          reason: null
        },
        libraryIndex: {
          rebuildRequired: false,
          reason: null,
          ignoredRootMediaCount: 0
        },
        preferences: {
          defaultHomeFeedMode: 'random',
          defaultReelsFeedMode: 'recommended',
          treatStoriesAsFolders: false
        },
        storiesMigration: {
          hasLegacyStoriesCandidates: false,
          decisionPending: false
        }
      } as never
    });

    trashStore.$patch({
      items: [item],
      initialized: true,
      loading: false,
      hasMore: false,
      error: null
    });

    vi.spyOn(trashStore, 'loadInitial').mockResolvedValue(undefined);
    vi.spyOn(foldersStore, 'fetchFolders').mockReturnValue(backgroundRefresh.promise);
    vi.spyOn(feedStore, 'loadInitial').mockReturnValue(backgroundRefresh.promise);
    vi.spyOn(likesStore, 'initialize').mockReturnValue(backgroundRefresh.promise);
    vi.spyOn(momentsStore, 'fetchMoments').mockReturnValue(backgroundRefresh.promise);
    vi.spyOn(appStore, 'fetchStats').mockReturnValue(backgroundRefresh.promise);
    restoreImageMock.mockResolvedValue({
      id: item.id,
      folderSlug: item.folderSlug
    });

    const wrapper = mount(TrashView, {
      global: {
        stubs: {
          RouterLink: {
            template: '<a><slot /></a>'
          }
        }
      }
    });

    await wrapper.get('input[type="checkbox"]').setValue(true);
    const restoreButton = wrapper
      .findAll('button')
      .find((button) => button.text() === 'Restore');

    expect(restoreButton).toBeDefined();

    await restoreButton!.trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-test="confirm-dialog"]').exists()).toBe(true);

    await wrapper.get('[data-test="confirm-button"]').trigger('click');
    await flushPromises();

    expect(restoreImageMock).toHaveBeenCalledWith(item.id);
    expect(foldersStore.fetchFolders).toHaveBeenCalledWith(true);
    expect(wrapper.find('[data-test="confirm-dialog"]').exists()).toBe(false);
    expect(trashStore.items).toEqual([]);

    backgroundRefresh.resolve();
    await flushPromises();
  });

  it('shows the empty state instead of the blocking loader while an initialized empty trash refresh is running', async () => {
    const appStore = useAppStore();
    const trashStore = useTrashStore();

    appStore.$patch({
      stats: {
        folders: 1,
        indexedImages: 1,
        indexedVideos: 0,
        scan: {
          isScanning: false,
          lastCompletedScan: null
        },
        storage: {
          available: true,
          reason: null
        },
        libraryIndex: {
          rebuildRequired: false,
          reason: null,
          ignoredRootMediaCount: 0
        },
        preferences: {
          defaultHomeFeedMode: 'random',
          defaultReelsFeedMode: 'recommended',
          treatStoriesAsFolders: false
        },
        storiesMigration: {
          hasLegacyStoriesCandidates: false,
          decisionPending: false
        }
      } as never
    });

    trashStore.$patch({
      items: [],
      initialized: true,
      loading: true,
      hasMore: false,
      error: null
    });

    vi.spyOn(trashStore, 'loadInitial').mockResolvedValue(undefined);

    const wrapper = mount(TrashView, {
      global: {
        stubs: {
          RouterLink: {
            template: '<a><slot /></a>'
          }
        }
      }
    });

    await flushPromises();

    expect(wrapper.find('[data-test="empty-state"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('Loading trash...');
  });

  it('renders custom captions in trash cards instead of always falling back to filenames', async () => {
    const appStore = useAppStore();
    const trashStore = useTrashStore();

    appStore.$patch({
      stats: {
        folders: 1,
        indexedImages: 1,
        indexedVideos: 0,
        scan: {
          isScanning: false,
          lastCompletedScan: null
        },
        storage: {
          available: true,
          reason: null
        },
        libraryIndex: {
          rebuildRequired: false,
          reason: null,
          ignoredRootMediaCount: 0
        },
        preferences: {
          defaultHomeFeedMode: 'random',
          defaultReelsFeedMode: 'recommended',
          treatStoriesAsFolders: false
        },
        storiesMigration: {
          hasLegacyStoriesCandidates: false,
          decisionPending: false
        }
      } as never
    });

    trashStore.$patch({
      items: [{
        ...createTrashItem(52),
        caption: 'Fog lifting over the ridge'
      }],
      initialized: true,
      loading: false,
      hasMore: false,
      error: null
    });

    vi.spyOn(trashStore, 'loadInitial').mockResolvedValue(undefined);

    const wrapper = mount(TrashView, {
      global: {
        stubs: {
          RouterLink: {
            template: '<a><slot /></a>'
          }
        }
      }
    });

    await flushPromises();

    expect(wrapper.text()).toContain('Fog lifting over the ridge');
    expect(wrapper.text()).not.toContain('photo 52');
  });

  it('localizes the trash page and dialogs after the app language changes', async () => {
    const appStore = useAppStore();
    const trashStore = useTrashStore();
    appStore.setLocale('es');

    appStore.$patch({
      stats: {
        folders: 1,
        indexedImages: 1,
        indexedVideos: 0,
        scan: {
          isScanning: false,
          lastCompletedScan: null
        },
        storage: {
          available: true,
          reason: null
        },
        libraryIndex: {
          rebuildRequired: false,
          reason: null,
          ignoredRootMediaCount: 0
        },
        preferences: {
          defaultHomeFeedMode: 'random',
          defaultReelsFeedMode: 'recommended',
          treatStoriesAsFolders: false
        },
        storiesMigration: {
          hasLegacyStoriesCandidates: false,
          decisionPending: false
        }
      } as never
    });

    trashStore.$patch({
      items: [createTrashItem(73)],
      initialized: true,
      loading: false,
      hasMore: false,
      error: null
    });

    vi.spyOn(trashStore, 'loadInitial').mockResolvedValue(undefined);

    const wrapper = mount(TrashView, {
      global: {
        stubs: {
          RouterLink: {
            template: '<a><slot /></a>'
          }
        }
      }
    });

    await flushPromises();

    expect(wrapper.text()).toContain('Papelera');
    expect(wrapper.text()).toContain('Publicaciones eliminadas');
    expect(wrapper.text()).toContain('0 publicaciones seleccionadas');
    expect(wrapper.text()).toContain('Restaurar');
    expect(wrapper.text()).toContain('Eliminar permanentemente');
    expect(wrapper.text()).toContain('En papelera');
    expect(wrapper.text()).toContain('Abrir carpeta');
    expect(wrapper.text()).not.toContain('Deleted posts');
    expect(wrapper.text()).not.toContain('Permanently Delete');

    await wrapper.get('input[type="checkbox"]').setValue(true);

    const restoreButton = wrapper
      .findAll('button')
      .find((button) => button.text() === 'Restaurar');

    expect(restoreButton).toBeDefined();

    await restoreButton!.trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-test="confirm-title"]').text()).toBe('¿Restaurar las publicaciones seleccionadas?');
    expect(wrapper.get('[data-test="confirm-message"]').text()).toBe('¿Restaurar 1 publicación seleccionada en la app?');
    expect(wrapper.get('[data-test="cancel-button"]').text()).toBe('Cancelar');
  });

  it('shows the backend-provided library unavailable reason on trash', async () => {
    const appStore = useAppStore();
    const trashStore = useTrashStore();

    appStore.$patch({
      stats: {
        folders: 0,
        indexedImages: 0,
        indexedVideos: 0,
        scan: {
          isScanning: false,
          lastCompletedScan: null
        },
        storage: {
          available: false,
          reason: 'Library root /mnt/gallery is unavailable.'
        },
        libraryIndex: {
          rebuildRequired: false,
          reason: null,
          ignoredRootMediaCount: 0
        },
        preferences: {
          defaultHomeFeedMode: 'random',
          defaultReelsFeedMode: 'recommended',
          treatStoriesAsFolders: false
        },
        storiesMigration: {
          hasLegacyStoriesCandidates: false,
          decisionPending: false
        }
      } as never
    });

    vi.spyOn(trashStore, 'loadInitial').mockResolvedValue(undefined);

    const wrapper = mount(TrashView, {
      global: {
        stubs: {
          RouterLink: {
            template: '<a><slot /></a>'
          }
        }
      }
    });

    await flushPromises();

    expect(wrapper.get('[data-test="empty-state"]').text()).toContain('Library storage unavailable');
    expect(wrapper.get('[data-test="empty-state"]').text()).toContain('Library root /mnt/gallery is unavailable.');
    expect(trashStore.loadInitial).not.toHaveBeenCalled();
  });
});
