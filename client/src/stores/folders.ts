import { defineStore } from 'pinia';

import {
  createFolderShareLink,
  fetchFolderImages,
  fetchFolderShareLinks,
  fetchFolders,
  removeFolderSharePassword,
  revokeFolderShareLink,
  setFolderCover,
  setFolderSharePassword,
  updateFolderProfile
} from '../api/gallery';
import type {
  CreateFolderShareLinkInput,
  FeedItem,
  FolderShareLink,
  FolderSharePasswordStatus,
  FolderSummary
} from '../types/api';
import { updateCaptionInItems } from '../utils/caption';
import { useCreatorReadingStore } from './creator-reading';

type FolderMediaFilter = 'all' | 'video';

interface FoldersState {
  items: FolderSummary[];
  hasLoadedList: boolean;
  listGeneration: number;
  loadingList: boolean;
  pendingListRefresh: boolean;
  listError: string | null;
  currentFolder: FolderSummary | null;
  currentImages: FeedItem[];
  currentFilter: FolderMediaFilter;
  currentPage: number;
  currentLimit: number;
  currentHasMore: boolean;
  loadingFolder: boolean;
  folderError: string | null;
  shareLinks: FolderShareLink[];
  sharePassword: FolderSharePasswordStatus;
  sharePublicFolderUrl: string | null;
  sharePublicAccess: boolean;
  loadingShare: boolean;
  shareError: string | null;
  lastCreatedShareUrl: string | null;
}

// Per-store, ephemeral request ownership: a reset detaches old consumers without
// letting their eventual response repopulate a different access context.
const listRequests = new WeakMap<object, Promise<void>>();

export const useFoldersStore = defineStore('folders', {
  state: (): FoldersState => ({
    items: [],
    hasLoadedList: false,
    listGeneration: 0,
    loadingList: false,
    pendingListRefresh: false,
    listError: null,
    currentFolder: null,
    currentImages: [],
    currentFilter: 'all',
    currentPage: 1,
    currentLimit: 24,
    currentHasMore: true,
    loadingFolder: false,
    folderError: null,
    shareLinks: [],
    sharePassword: {
      enabled: false,
      updatedAt: null
    },
    sharePublicFolderUrl: null,
    sharePublicAccess: false,
    loadingShare: false,
    shareError: null,
    lastCreatedShareUrl: null
  }),
  actions: {
    removeImage(imageId: number, folderSlug: string, mediaType: FeedItem['mediaType'] = 'image') {
      useCreatorReadingStore().invalidate();
      let removedFolder = false;

      this.items = this.items.flatMap((folder) => {
        if (folder.slug !== folderSlug) {
          return [folder];
        }

        const nextPostCount = Math.max(0, (folder.postCount ?? folder.imageCount) - 1);
        const nextImageCount = Math.max(0, folder.imageCount - 1);
        if (nextPostCount === 0) {
          removedFolder = true;
          return [];
        }

        return [
          {
            ...folder,
            ...(folder.postCount === undefined ? {} : { postCount: nextPostCount }),
            imageCount: nextImageCount,
            videoCount: mediaType === 'video' ? Math.max(0, folder.videoCount - 1) : folder.videoCount
          }
        ];
      });

      if (this.currentFolder?.slug === folderSlug) {
        if (this.currentFilter === 'all' || mediaType === 'video') {
          this.currentImages = this.currentImages.filter((item) => item.id !== imageId);
        }

        const nextPostCount = Math.max(0, (this.currentFolder.postCount ?? this.currentFolder.imageCount) - 1);
        const nextImageCount = Math.max(0, this.currentFolder.imageCount - 1);
        if (nextPostCount === 0) {
          this.currentFolder = null;
          this.currentPage = 1;
          this.currentHasMore = false;
        } else {
          this.currentFolder = {
            ...this.currentFolder,
            ...(this.currentFolder.postCount === undefined ? {} : { postCount: nextPostCount }),
            imageCount: nextImageCount,
            videoCount: mediaType === 'video' ? Math.max(0, this.currentFolder.videoCount - 1) : this.currentFolder.videoCount
          };
        }
      }

      return removedFolder;
    },

    removeFolder(slug: string) {
      useCreatorReadingStore().invalidate();
      this.items = this.items.filter((folder) => folder.slug !== slug);

      if (this.currentFolder?.slug === slug) {
        this.currentFolder = null;
        this.currentImages = [];
        this.currentPage = 1;
        this.currentHasMore = false;
      }
    },

    updateImageCaption(id: number, caption: string | null) {
      useCreatorReadingStore().invalidate();
      this.currentImages = updateCaptionInItems(this.currentImages, id, caption);
    },

    resetForRebuild() {
      this.listGeneration += 1;
      listRequests.delete(this);
      this.items = [];
      this.hasLoadedList = false;
      this.loadingList = false;
      this.pendingListRefresh = false;
      this.listError = null;
      this.currentFolder = null;
      this.currentImages = [];
      this.currentFilter = 'all';
      this.currentPage = 1;
      this.currentHasMore = true;
      this.loadingFolder = false;
      this.folderError = null;
      this.shareLinks = [];
      this.sharePassword = {
        enabled: false,
        updatedAt: null
      };
      this.sharePublicFolderUrl = null;
      this.sharePublicAccess = false;
      this.loadingShare = false;
      this.shareError = null;
      this.lastCreatedShareUrl = null;
    },

    async fetchFolders(force = false) {
      const running = listRequests.get(this);
      if (running) {
        this.pendingListRefresh = this.pendingListRefresh || force;
        return running;
      }

      if (!force && this.hasLoadedList) {
        return;
      }
      const generation = this.listGeneration;
      this.loadingList = true;
      this.listError = null;
      const request = (async () => {
        do {
          this.pendingListRefresh = false;
          try {
            const items = await fetchFolders();
            if (generation !== this.listGeneration) return;
            this.items = items;
            this.hasLoadedList = true;
            this.listError = null;
          } catch (error) {
            if (generation !== this.listGeneration) return;
            this.hasLoadedList = false;
            this.listError = error instanceof Error ? error.message : 'Unable to load folders';
          }
        } while (generation === this.listGeneration && this.pendingListRefresh);
      })();
      listRequests.set(this, request);
      try { await request; }
      finally {
        if (generation === this.listGeneration) {
          this.loadingList = false;
          listRequests.delete(this);
        }
      }
    },

    async loadFolder(slug: string, reset = true, mediaType?: FeedItem['mediaType']) {
      if (this.loadingFolder) {
        return;
      }

      const nextFilter: FolderMediaFilter = mediaType === 'video' ? 'video' : 'all';
      const filterChanged = this.currentFilter !== nextFilter;

      if (reset || filterChanged) {
        this.currentFolder = null;
        this.currentImages = [];
        this.currentFilter = nextFilter;
        this.currentPage = 1;
        this.currentHasMore = true;
      }

      this.loadingFolder = true;
      this.folderError = null;

      try {
        const payload = await fetchFolderImages(slug, this.currentPage, this.currentLimit, mediaType);
        this.currentFolder = payload.folder;
        this.currentImages.push(...payload.items);
        this.currentPage += 1;
        this.currentHasMore = payload.hasMore;
      } catch (error) {
        this.currentFolder = null;
        this.folderError = error instanceof Error ? error.message : 'Unable to load folder';
      } finally {
        this.loadingFolder = false;
      }
    },

    async updateFolderProfile(slug: string, name: string, description: string | null) {
      const updated = await updateFolderProfile(slug, name, description);
      useCreatorReadingStore().invalidate();
      this.items = this.items.map((folder) => (folder.slug === slug ? updated : folder));
      
      if (this.currentFolder?.slug === slug) {
        this.currentFolder = updated;
      }
    },

    async setFolderCover(slug: string, imageId: number) {
      await setFolderCover(slug, imageId);
      useCreatorReadingStore().invalidate();
      await this.fetchFolders(true);
      
      if (this.currentFolder?.slug === slug) {
        const payload = await fetchFolderImages(slug, 1, this.currentLimit, this.currentFilter === 'video' ? 'video' : undefined);
        this.currentFolder = payload.folder;
      }
    },

    async loadShareLinks(slug: string) {
      this.loadingShare = true;
      this.shareError = null;
      this.lastCreatedShareUrl = null;

      try {
        const payload = await fetchFolderShareLinks(slug);
        this.shareLinks = payload.links;
        this.sharePassword = payload.password;
        this.sharePublicFolderUrl = payload.publicFolderUrl;
        this.sharePublicAccess = payload.publicAccess;
      } catch (error) {
        this.shareError = error instanceof Error ? error.message : 'Unable to load folder sharing';
        throw error;
      } finally {
        this.loadingShare = false;
      }
    },

    async createShareLink(slug: string, input: CreateFolderShareLinkInput) {
      this.loadingShare = true;
      this.shareError = null;

      try {
        const payload = await createFolderShareLink(slug, input);
        this.shareLinks = [payload.link, ...this.shareLinks.filter((link) => link.id !== payload.link.id)];
        this.lastCreatedShareUrl = payload.shareUrl;
        return payload;
      } catch (error) {
        this.shareError = error instanceof Error ? error.message : 'Unable to create share link';
        throw error;
      } finally {
        this.loadingShare = false;
      }
    },

    async revokeShareLink(slug: string, linkId: number) {
      this.loadingShare = true;
      this.shareError = null;

      try {
        const payload = await revokeFolderShareLink(slug, linkId);
        this.shareLinks = this.shareLinks.map((link) => (link.id === payload.link.id ? payload.link : link));
        if (this.lastCreatedShareUrl) {
          this.lastCreatedShareUrl = null;
        }
      } catch (error) {
        this.shareError = error instanceof Error ? error.message : 'Unable to revoke share link';
        throw error;
      } finally {
        this.loadingShare = false;
      }
    },

    async setSharePassword(slug: string, password: string) {
      this.loadingShare = true;
      this.shareError = null;

      try {
        const payload = await setFolderSharePassword(slug, password);
        this.sharePassword = payload.password;
      } catch (error) {
        this.shareError = error instanceof Error ? error.message : 'Unable to save folder password';
        throw error;
      } finally {
        this.loadingShare = false;
      }
    },

    async removeSharePassword(slug: string) {
      this.loadingShare = true;
      this.shareError = null;

      try {
        const payload = await removeFolderSharePassword(slug);
        this.sharePassword = payload.password;
      } catch (error) {
        this.shareError = error instanceof Error ? error.message : 'Unable to remove folder password';
        throw error;
      } finally {
        this.loadingShare = false;
      }
    }
  }
});
