import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CollectionSummary } from '../types/api';
import { useCollectionsStore } from '../stores/collections';
import CollectionView from './CollectionView.vue';

vi.mock('vue-router', () => ({
  RouterLink: {
    template: '<a><slot /></a>'
  },
  useRouter: () => ({
    push: vi.fn()
  })
}));

function createCollection(slug: string, name: string, isDefault = false): CollectionSummary {
  return {
    id: isDefault ? 1 : Math.abs(slug.length * 17),
    slug,
    name,
    isDefault,
    itemCount: 0,
    coverImage: null,
    previewImages: [],
    createdAt: '2026-04-28T00:00:00.000Z',
    updatedAt: '2026-04-28T00:00:00.000Z'
  };
}

function createFeedItem(id: number) {
  return {
    id,
    folderId: 11,
    folderSlug: 'album',
    folderName: 'Album',
    folderPath: 'album',
    folderBreadcrumb: null,
    filename: `photo-${id}.jpg`,
    width: 1200,
    height: 1500,
    mediaType: 'image' as const,
    durationMs: null,
    isAnimated: false,
    thumbnailUrl: `/thumbnails/${id}.webp`,
    previewUrl: `/previews/${id}.webp`,
    sortTimestamp: 1_800_000_000_000 + id,
    takenAt: 1_800_000_000_000 + id,
    isSaved: true
  };
}

describe('CollectionView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('uses All saved as the default collection title and Collections as the back label', async () => {
    const collectionsStore = useCollectionsStore();
    collectionsStore.$patch({
      currentCollection: createCollection('saved', 'Saved', true),
      currentImages: [],
      loadingCollection: false,
      collectionError: null
    });
    vi.spyOn(collectionsStore, 'loadCollection').mockResolvedValue(undefined);

    const wrapper = mount(CollectionView, {
      props: {
        slug: 'saved'
      },
      global: {
        stubs: {
          EmptyState: {
            props: ['title', 'description'],
            template: '<div data-test="empty-state"><h2>{{ title }}</h2><p>{{ description }}</p></div>'
          },
          ErrorState: {
            template: '<div data-test="error-state" />'
          },
          FolderGrid: {
            props: ['columns', 'variant'],
            template: '<div data-test="folder-grid" :data-columns="columns" :data-variant="variant" />'
          },
          InfiniteLoader: {
            template: '<div data-test="infinite-loader" />'
          }
        }
      }
    });

    await flushPromises();

    expect(wrapper.text()).toContain('Collections');
    expect(wrapper.text()).toContain('All saved');
    expect(wrapper.text()).toContain('Use the bookmark action on any media entry to save it here.');
    expect(wrapper.find('.collection-page__menu-button').exists()).toBe(false);
  });

  it('renders collection items in a three-column portrait grid', async () => {
    const collectionsStore = useCollectionsStore();
    collectionsStore.$patch({
      currentCollection: createCollection('saved', 'Saved', true),
      currentImages: [createFeedItem(1)],
      loadingCollection: false,
      collectionError: null
    });
    vi.spyOn(collectionsStore, 'loadCollection').mockResolvedValue(undefined);

    const wrapper = mount(CollectionView, {
      props: {
        slug: 'saved'
      },
      global: {
        stubs: {
          EmptyState: {
            template: '<div data-test="empty-state" />'
          },
          ErrorState: {
            template: '<div data-test="error-state" />'
          },
          FolderGrid: {
            props: ['columns', 'variant'],
            template: '<div data-test="folder-grid" :data-columns="columns" :data-variant="variant" />'
          },
          InfiniteLoader: {
            template: '<div data-test="infinite-loader" />'
          }
        }
      }
    });

    await flushPromises();

    expect(wrapper.find('[data-test="folder-grid"]').attributes('data-columns')).toBe('three');
    expect(wrapper.find('[data-test="folder-grid"]').attributes('data-variant')).toBe('posts');
  });

  it('returns from a delete confirmation to the stable options button without deleting the collection', async () => {
    const collectionsStore = useCollectionsStore();
    collectionsStore.$patch({ currentCollection: createCollection('portraits', 'Portraits'), currentImages: [] });
    vi.spyOn(collectionsStore, 'loadCollection').mockResolvedValue(undefined);
    const remove = vi.spyOn(collectionsStore, 'deleteCollection').mockResolvedValue(undefined);
    const wrapper = mount(CollectionView, {
      attachTo: document.body,
      props: { slug: 'portraits' },
      global: { stubs: { FolderGrid: true, InfiniteLoader: true } },
    });
    await flushPromises();
    const opener = wrapper.get('.collection-page__menu-button');
    (opener.element as HTMLElement).focus();
    await opener.trigger('click'); await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('.collection-action-sheet').element);
    await wrapper.get('.collection-action-sheet__item--danger').trigger('click'); await flushPromises();
    const dialog = wrapper.get('.collection-delete-dialog');
    expect(document.activeElement).toBe(dialog.element);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(dialog.findAll('button')[1].element);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flushPromises();
    expect(wrapper.find('[role=dialog]').exists()).toBe(false);
    expect(document.activeElement).toBe(opener.element);
    expect(remove).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
