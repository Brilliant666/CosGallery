import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FolderSummary } from '../types/api';
import FolderShareModal from './FolderShareModal.vue';

function createFolder(overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id: 1,
    slug: 'travel-2024',
    name: 'Travel 2024',
    description: 'Vacation photos.',
    folderPath: 'travel-2024',
    breadcrumb: 'Travel 2024',
    imageCount: 10,
    videoCount: 2,
    latestImageMtimeMs: Date.now(),
    avatarImageId: null,
    avatarUrl: null,
    ...overrides
  };
}

describe('FolderShareModal', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders modal in protected mode with link and password controls', () => {
    const wrapper = mount(FolderShareModal, {
      props: {
        folder: createFolder()
      }
    });

    expect(wrapper.text()).toContain('Share Folder');
    expect(wrapper.text()).toContain('Share links and password access work independently');
    expect(wrapper.text()).toContain('Share links');
    expect(wrapper.text()).toContain('Password access');
    expect(wrapper.text()).toContain('does not add password protection to share links');
  });

  it('summarizes simultaneous link and password access', async () => {
    const { useFoldersStore } = await import('../stores/folders');
    const foldersStore = useFoldersStore();
    foldersStore.shareLinks = [
      {
        id: 7,
        folderId: 1,
        tokenPrefix: 'abcdefgh',
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        status: 'active'
      }
    ];
    foldersStore.sharePassword = { enabled: true, updatedAt: new Date().toISOString() };
    foldersStore.loadShareLinks = vi.fn().mockResolvedValue(undefined);

    const wrapper = mount(FolderShareModal, {
      props: {
        folder: createFolder()
      }
    });

    expect(wrapper.text()).toContain('Active share links: 1. Password access: enabled.');
    expect(wrapper.text()).toContain('Copy Folder Address');
  });

  it('renders public mode information when global public access is enabled', async () => {
    const { useFoldersStore } = await import('../stores/folders');
    const foldersStore = useFoldersStore();
    foldersStore.shareLinks = [];
    foldersStore.sharePassword = { enabled: false, updatedAt: null };
    foldersStore.sharePublicFolderUrl = '/folders/travel-2024';
    foldersStore.sharePublicAccess = true;

    const wrapper = mount(FolderShareModal, {
      props: {
        folder: createFolder()
      }
    });

    expect(wrapper.text()).toContain('Public folder URL');
    expect((wrapper.find('input.share-url-input').element as HTMLInputElement).value).toContain('/folders/travel-2024');
  });

  it('copies share link to clipboard when copy button is clicked', async () => {
    const { vi } = await import('vitest');
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true
    });

    const { useFoldersStore } = await import('../stores/folders');
    const foldersStore = useFoldersStore();
    foldersStore.shareLinks = [];
    foldersStore.sharePassword = { enabled: false, updatedAt: null };
    foldersStore.sharePublicAccess = false;
    foldersStore.loadShareLinks = vi.fn().mockResolvedValue(undefined);
    foldersStore.lastCreatedShareUrl = '/share/travel-2024#token=test-token';

    const wrapper = mount(FolderShareModal, {
      props: {
        folder: createFolder()
      }
    });

    const expectedShareUrl = new URL('/share/travel-2024#token=test-token', window.location.origin).toString();
    const createdLinkInput = wrapper
      .findAll('input.share-url-input')
      .find((input) => (input.element as HTMLInputElement).value === expectedShareUrl);
    expect(createdLinkInput).toBeDefined();

    const copyButton = wrapper
      .findAll('button.share-icon-button')
      .find((button) => createdLinkInput!.element.parentElement?.contains(button.element));
    expect(copyButton).toBeDefined();

    await copyButton!.trigger('click');
    expect(writeTextMock).toHaveBeenCalledWith(expectedShareUrl);
  });
});
