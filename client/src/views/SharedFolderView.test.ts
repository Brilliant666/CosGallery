import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SharedFolderView from './SharedFolderView.vue';

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router');
  return {
    ...actual,
    useRoute: () => ({
      fullPath: '/share/travel-2024',
      hash: '',
      query: {}
    })
  };
});

describe('SharedFolderView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders password prompt when access is not yet granted and folder requires password', async () => {
    const { useShareStore } = await import('../stores/share');
    const shareStore = useShareStore();
    shareStore.access = {
      exists: true,
      granted: false,
      hasPassword: true,
      publicAccess: false
    };

    const wrapper = mount(SharedFolderView, {
      props: {
        slug: 'travel-2024'
      },
      global: {
        stubs: {
          Avatar: true,
          EmptyState: true,
          ErrorState: true,
          FolderGrid: true,
          InfiniteLoader: true,
          RouterLink: { template: '<a><slot /></a>' }
        }
      }
    });

    expect(wrapper.text()).toContain('Folder Share');
    expect(wrapper.text()).toContain('Enter the reusable folder password to continue.');
    expect(wrapper.find('input[type="password"]').exists()).toBe(true);
    expect(wrapper.find('button[type="submit"]').exists()).toBe(true);
  });

  it('renders expired state when link is expired or revoked', async () => {
    const { useShareStore } = await import('../stores/share');
    const shareStore = useShareStore();
    shareStore.access = {
      exists: true,
      granted: false,
      hasPassword: false,
      publicAccess: false
    };
    shareStore.error = 'This folder share is expired, revoked, or locked.';

    const wrapper = mount(SharedFolderView, {
      props: {
        slug: 'travel-2024'
      },
      global: {
        stubs: {
          Avatar: true,
          EmptyState: true,
          ErrorState: {
            props: ['title', 'message'],
            template: '<div class="error-state"><h1>{{ title }}</h1><p>{{ message }}</p></div>'
          },
          FolderGrid: true,
          InfiniteLoader: true,
          RouterLink: { template: '<a><slot /></a>' }
        }
      }
    });

    expect(wrapper.text()).toContain('Could not open folder share');
    expect(wrapper.text()).toContain('This folder share is expired, revoked, or locked.');
  });

  it('explains password fallback after a share link is rejected', async () => {
    window.history.replaceState(null, '', '/share/travel-2024#token=expired-token');

    const { useShareStore } = await import('../stores/share');
    const shareStore = useShareStore();
    shareStore.unlockLink = vi.fn().mockRejectedValue(new Error('Share link rejected.'));
    shareStore.loadAccess = vi.fn(async () => {
      shareStore.access = {
        exists: true,
        granted: false,
        hasPassword: true,
        publicAccess: false
      };
      return shareStore.access;
    });

    const wrapper = mount(SharedFolderView, {
      props: {
        slug: 'travel-2024'
      },
      global: {
        stubs: {
          Avatar: true,
          EmptyState: true,
          ErrorState: true,
          FolderGrid: true,
          InfiniteLoader: true,
          RouterLink: { template: '<a><slot /></a>' }
        }
      }
    });

    await flushPromises();

    expect(wrapper.text()).toContain('This share link is no longer available.');
    expect(wrapper.text()).toContain('you can still access this folder');
    expect(wrapper.text()).not.toContain('Share link rejected.');
  });

  it('does not display any admin actions or settings controls when viewing shared folder', async () => {
    const { useShareStore } = await import('../stores/share');
    const shareStore = useShareStore();
    shareStore.access = {
      exists: true,
      granted: true,
      hasPassword: false,
      publicAccess: false
    };
    shareStore.folder = {
      id: 1,
      slug: 'travel-2024',
      name: 'Travel 2024',
      description: 'Shared vacation pics',
      imageCount: 5,
      avatarThumbnailUrl: null,
      sortTimestamp: Date.now()
    };
    shareStore.images = [];

    const wrapper = mount(SharedFolderView, {
      props: {
        slug: 'travel-2024'
      },
      global: {
        stubs: {
          Avatar: true,
          EmptyState: true,
          ErrorState: true,
          FolderGrid: true,
          InfiniteLoader: true,
          RouterLink: { template: '<a><slot /></a>' }
        }
      }
    });

    expect(wrapper.find('button[aria-label="Edit folder"]').exists()).toBe(false);
    expect(wrapper.find('button[aria-label="Share folder"]').exists()).toBe(false);
    expect(wrapper.find('button[aria-label="Settings"]').exists()).toBe(false);
  });
});
