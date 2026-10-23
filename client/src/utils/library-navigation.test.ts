import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFoldersStore } from '../stores/folders';
import { useCreatorReadingStore } from '../stores/creator-reading';
import type { FolderSummary } from '../types/api';
import { canonicalCreatorRoute, canonicalWorkGalleryRoute, folderReadingRoute, libraryReadingQuery, libraryReturnRoute } from './work-gallery';
import { sanitizedGalleryQuery } from './creator-gallery-labels';

describe('unified library navigation state', () => {
  beforeEach(() => setActivePinia(createPinia()));
  it('uses a bridge identity rather than Folder ID or slug digits', () => {
    useFoldersStore().items = [{ id: 836, slug: 'folder-10', canonicalCreatorId: 2 } as FolderSummary];
    expect(folderReadingRoute('folder-10')).toEqual(canonicalCreatorRoute(2));
    expect(folderReadingRoute('unlinked')).toEqual({ name: 'folder', params: { slug: 'unlinked' } });
  });
  it('carries flat search, classification and loaded-range state through the work and back', () => {
    const creator = canonicalCreatorRoute(166, '/library?q=lunananya&rating=R15&page=2');
    expect(creator.query).toEqual({ q: 'lunananya', rating: 'R15', libraryPage: '2' });
    const work = canonicalWorkGalleryRoute(166, 123, '/library/166?q=lunananya&rating=R15&libraryPage=2&loaded=3');
    expect(work.query).toEqual({ q: 'lunananya', rating: 'R15', libraryPage: '2', loaded: '3' });
    expect(work.query).not.toHaveProperty('returnTo');
    expect(libraryReturnRoute(work.query!)).toEqual({ name: 'library', query: { q: 'lunananya', rating: 'R15', page: '2' } });
  });
  it('rejects external, protocol-relative and backslash return targets', () => {
    for (const target of ['https://evil.invalid/library', '//evil.invalid/library', '/library\\evil']) expect(libraryReadingQuery(target)).toEqual({});
  });
  it('retains the joint preference through creator, work and library return links', () => {
    const creator = canonicalCreatorRoute(166, '/library?q=alias&rating=R18&preference=kept&page=2');
    expect(creator.query).toEqual({ q: 'alias', rating: 'R18', preference: 'kept', libraryPage: '2' });
    const work = canonicalWorkGalleryRoute(166, 123, '/library/166?q=alias&rating=R18&preference=kept&libraryPage=2');
    expect(libraryReturnRoute(work.query!)).toEqual({ name: 'library', query: { q: 'alias', rating: 'R18', preference: 'kept', page: '2' } });
  });
  it('keeps one category across creator and viewer return state without carrying a rating', () => {
    const creator = canonicalCreatorRoute(12, '/library?label=portrait&rating=R18&q=alias&page=2');
    expect(creator.query).toEqual({ label: 'portrait', q: 'alias', libraryPage: '2' });
    const work = canonicalWorkGalleryRoute(12, 123, '/library/12?label=portrait&rating=R18&q=alias&libraryPage=2&loaded=3');
    expect(work.query).toEqual({ label: 'portrait', q: 'alias', libraryPage: '2', loaded: '3' });
    expect(libraryReturnRoute(work.query!)).toEqual({ name: 'library', query: { label: 'portrait', q: 'alias', page: '2' } });
  });
  it('removes private filters from visitor return links including old nested reading URLs', () => {
    expect(libraryReturnRoute({ label: 'selfie', preference: 'kept', rating: 'R18', libraryPage: '2' }, false)).toEqual({
      name: 'library', query: { label: 'selfie', q: undefined, page: '2' }
    });
    expect(sanitizedGalleryQuery({ label: 'cosplay', preference: 'liked', rating: 'R18', returnTo: '/library?rating=R18&preference=liked&page=2' }, false)).toEqual({
      label: 'cosplay', returnTo: '/library?page=2'
    });
    expect(sanitizedGalleryQuery({ label: ['cosplay', 'portrait'], rating: 'R15' }, true)).toEqual({ rating: 'R15' });
  });
  it('invalidates reading state after a media mutation and retains only bounded navigation state', () => {
    const reading = useCreatorReadingStore();
    reading.libraryPages['/library'] = { items: [], total: 1, scrollY: 400 };
    useFoldersStore().removeFolder('gone');
    expect(reading.libraryPages).toEqual({});
    expect(reading.generation).toBe(1);
  });
});
