import { describe, expect, it } from 'vitest';
import type { FeedItem, FolderSummary } from '../../client/src/types/api.js';
import { buildLikedCountByFolder, selectHomeRecommendations } from '../../client/src/utils/home-recommendations.js';
import { creatorIdentity, selectRecentCreators } from '../../client/src/utils/sidebar-folders.js';

const now = new Date('2026-03-12T12:00:00.000Z');
const noLikes = new Map<string, number>();
function folder(id: number, overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id, canonicalCreatorId: id, slug: `creator-${id}`, name: `Creator ${id}`,
    description: null, folderPath: `gallery/${id}`, breadcrumb: null, contentRating: 'R15',
    postCount: 4, imageCount: 4, videoCount: 0, latestImageMtimeMs: now.getTime() - id * 86400000,
    avatarImageId: null, avatarUrl: null, ...overrides
  };
}

const fixtures = Array.from({ length: 20 }, (_, i) => folder(i + 1));

describe('recent creators', () => {
  it('has no recommendation fallback when history is absent or all entries are unavailable', () => {
    expect(selectRecentCreators(fixtures, [])).toEqual([]);
    expect(selectRecentCreators(fixtures, ['missing', 'creator:999'])).toEqual([]);
  });

  it('preserves visit order, resolves legacy slugs, and deduplicates canonical identities', () => {
    const folders = [folder(1), folder(2), folder(11, { canonicalCreatorId: 1, slug: 'old-alias' }), folder(3)];
    const result = selectRecentCreators(folders, ['creator:2', 'old-alias', 'creator:1', 'creator-3']);
    expect(result.map(creatorIdentity)).toEqual(['creator:2', 'creator:1', 'creator:3']);
    expect(result[1].slug).toBe('old-alias');
  });

  it('resolves canonical history after a folder rename and uses folder identity for unlinked entries', () => {
    const renamed = folder(1, { slug: 'new-name' });
    const unlinked = folder(2, { canonicalCreatorId: null });
    const result = selectRecentCreators([renamed, unlinked], ['creator:1', 'creator-2']);
    expect(result.map(creatorIdentity)).toEqual(['creator:1', 'folder:2']);
  });

  it('limits the list to eight valid unique creators without consuming slots for stale entries', () => {
    const history = ['missing', 'creator:1', 'creator-1', ...fixtures.slice(1).map(f => `creator:${f.id}`)];
    expect(selectRecentCreators(fixtures, history).map(f => f.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('includes video-only works, respects explicit zero works, and accepts legacy counts', () => {
    const folders = [
      folder(1, { postCount: 1, imageCount: 0, videoCount: 1 }),
      folder(2, { postCount: 0, imageCount: 99 }),
      folder(3, { postCount: undefined, imageCount: 2 }),
      folder(4, { postCount: undefined, imageCount: 0 })
    ];
    expect(selectRecentCreators(folders, folders.map(f => f.slug)).map(f => f.id)).toEqual([1, 3]);
  });
});

describe('home recommendations', () => {
  it('recommends every eligible creator in a small library without adding an extra top slot', () => {
    const folders = [folder(1), folder(2), folder(3, { postCount: 0 })];
    expect(selectHomeRecommendations(folders, noLikes, now).map(f => f.id).sort()).toEqual([1, 2]);
    expect(selectHomeRecommendations([], noLikes, now)).toEqual([]);
  });
  it('deduplicates creators before forming the ranked pool', () => {
    const duplicateFolders = Array.from({ length: 15 }, (_, i) => folder(101 + i, {
      canonicalCreatorId: 1, postCount: 100, imageCount: 100, latestImageMtimeMs: now.getTime()
    }));
    const result = selectHomeRecommendations([...duplicateFolders, ...fixtures.slice(1, 7)], noLikes, now);
    expect(result).toHaveLength(6);
    expect(new Set(result.map(creatorIdentity)).size).toBe(6);
  });

  it('uses work counts for eligibility, including video-only works and legacy responses', () => {
    const folders = [folder(1, { postCount: 1, imageCount: 0, videoCount: 1 }),
      folder(2, { postCount: 0, imageCount: 9 }), folder(3, { postCount: undefined, imageCount: 1 })];
    expect(selectHomeRecommendations(folders, noLikes, now).map(f => f.id).sort()).toEqual([1, 3]);
  });

  it('keeps the daily order stable without mutating folders', () => {
    const folders = fixtures.map(f => ({ ...f }));
    const before = structuredClone(folders);
    const first = selectHomeRecommendations(folders, noLikes, now);
    const second = selectHomeRecommendations(folders, noLikes, new Date('2026-03-12T18:30:00.000Z'));
    expect(first.map(creatorIdentity)).toEqual(second.map(creatorIdentity));
    expect(first).toHaveLength(6);
    expect(folders).toEqual(before);
  });

  it('uses work favorites as a ranking signal without changing the input map', () => {
    const older = fixtures.map(f => ({ ...f, latestImageMtimeMs: null }));
    const likes = buildLikedCountByFolder([{ folderSlug: 'creator-20' }, { folderSlug: 'creator-20' }] as FeedItem[]);
    expect(likes.get('creator-20')).toBe(2);
    const selectedAcrossDays = new Set<number>();
    for (let day = 12; day < 20; day++) {
      for (const result of selectHomeRecommendations(older, likes, new Date(`2026-03-${day}T12:00:00Z`))) selectedAcrossDays.add(result.id);
    }
    expect(selectedAcrossDays.has(20)).toBe(true);
    expect([...likes]).toEqual([['creator-20', 2]]);
  });
});
