import { defineStore } from 'pinia';
import type { CosGalleryCreator, FeedItem } from '../types/api';
export interface CreatorReadingState {
  creator: CosGalleryCreator; items: FeedItem[]; total: number; nextPage: number; hasMore: boolean; scrollY: number;
}
// Bounded navigation state; never persisted to disk.
export const useCreatorReadingStore = defineStore('creator-reading', {
  state: () => ({
    generation: 0,
    pages: {} as Record<string, CreatorReadingState>,
    libraryPages: {} as Record<string, { items: CosGalleryCreator[]; total: number; scrollY: number }>
  }),
  actions: {
    invalidate() { this.pages = {}; this.libraryPages = {}; this.generation += 1; },
    save(key: string, value: CreatorReadingState) {
      delete this.pages[key];
      this.pages[key] = value;
      const keys = Object.keys(this.pages);
      if (keys.length > 10) delete this.pages[keys[0]!];
    }
  }
});
