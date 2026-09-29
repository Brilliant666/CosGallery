import { describe, expect, it } from 'vitest';

import {
  buildReelQueue,
  rankReelCandidates,
  type ReelRecommendationCandidate
} from '../src/utils/reels-utils.js';

function createCandidate(
  id: number,
  overrides: Partial<ReelRecommendationCandidate> = {}
): ReelRecommendationCandidate {
  return {
    id,
    folderId: id,
    folderSlug: `folder-${id}`,
    folderName: `Folder ${id}`,
    folderPath: `gallery/folder-${id}`,
    filename: `clip-${id}.mp4`,
    width: 1080,
    height: 1920,
    mediaType: 'video',
    durationMs: 18_000,
    thumbnailUrl: `thumb-${id}.webp`,
    previewUrl: `preview-${id}.webp`,
    sortTimestamp: 1_778_000_000_000 + id * 1_000,
    takenAt: 1_778_000_000_000 + id * 1_000,
    likedAt: null,
    ...overrides
  };
}

describe('reels utils', () => {
  it('preserves the previous recommendation order while comparing only folder heads', () => {
    function previousQueue(candidates: ReelRecommendationCandidate[], seed: number) {
      const remaining = [...rankReelCandidates(candidates, seed)];
      const queue: ReelRecommendationCandidate[] = [];
      const counts = new Map<string, number>();
      while (remaining.length) {
        let bestIndex = 0;
        let bestScore = Number.NEGATIVE_INFINITY;
        remaining.forEach((entry, index) => {
          const slug = entry.candidate.folderSlug;
          const alternative = remaining.some(other => other.candidate.folderSlug !== slug);
          let score = entry.score;
          if (alternative && queue.at(-1)?.folderSlug === slug) score -= 0.5;
          if (alternative && queue.at(-2)?.folderSlug === slug) score -= 0.15;
          score -= (counts.get(slug) ?? 0) * 0.03;
          if (score > bestScore) { bestIndex = index; bestScore = score; }
        });
        const item = remaining.splice(bestIndex, 1)[0]!.candidate;
        queue.push(item);
        counts.set(item.folderSlug, (counts.get(item.folderSlug) ?? 0) + 1);
      }
      return queue.map(item => item.id);
    }
    for (let seed = 1; seed <= 30; seed++) {
      const candidates = Array.from({ length: 40 }, (_, index) => createCandidate(index + 1, {
        folderSlug: `folder-${(index * 7 + seed) % (seed % 9 + 1)}`,
        takenAt: 1_778_000_000_000 + (index % 7) * 1000,
        likedAt: index % 3 ? null : '2026-03-25T00:00:00Z',
        durationMs: index % 2 ? 15_000 : 180_000
      }));
      expect(buildReelQueue(candidates, seed).map(item => item.id)).toEqual(previousQueue(candidates, seed));
    }
  });

  it('handles a ten-thousand-video queue with every media retained exactly once', () => {
    const candidates = Array.from({ length: 10_000 }, (_, index) => createCandidate(index + 1, {
      folderSlug: `folder-${index % 500}`
    }));
    const queue = buildReelQueue(candidates, 42);
    expect(queue).toHaveLength(candidates.length);
    expect(new Set(queue.map(item => item.id)).size).toBe(candidates.length);
  });

  it('keeps ranking stable for the same seed and affinity inputs', () => {
    const candidates = [
      createCandidate(1, { folderSlug: 'alpha' }),
      createCandidate(2, { folderSlug: 'beta', width: 1280, height: 720 }),
      createCandidate(3, { folderSlug: 'gamma', durationMs: 40_000 })
    ];

    const first = rankReelCandidates(candidates, 42, {
      lastOpenedFolderSlug: 'alpha',
      recentOpenedFolderSlugs: ['alpha', 'gamma']
    });
    const second = rankReelCandidates(candidates, 42, {
      lastOpenedFolderSlug: 'alpha',
      recentOpenedFolderSlugs: ['alpha', 'gamma']
    });

    expect(first.map((entry) => entry.candidate.id)).toEqual(second.map((entry) => entry.candidate.id));
  });

  it('allows different seeds to reshuffle otherwise similar top candidates', () => {
    const candidates = [
      createCandidate(1, { takenAt: 1_778_100_000_000, sortTimestamp: 1_778_100_000_000 }),
      createCandidate(2, { takenAt: 1_778_100_000_000, sortTimestamp: 1_778_100_000_000 }),
      createCandidate(3, { takenAt: 1_778_100_000_000, sortTimestamp: 1_778_100_000_000 })
    ];

    const firstSeedOrder = rankReelCandidates(candidates, 11).map((entry) => entry.candidate.id);
    const secondSeedOrder = rankReelCandidates(candidates, 29).map((entry) => entry.candidate.id);

    expect(firstSeedOrder).not.toEqual(secondSeedOrder);
  });

  it('boosts liked and recently opened folder candidates when other signals are close', () => {
    const candidates = [
      createCandidate(1, {
        folderSlug: 'liked-folder',
        likedAt: '2026-03-25T00:00:00.000Z',
        takenAt: 1_778_200_000_000,
        sortTimestamp: 1_778_200_000_000
      }),
      createCandidate(2, {
        folderSlug: 'recent-folder',
        takenAt: 1_778_200_000_000,
        sortTimestamp: 1_778_200_000_000
      }),
      createCandidate(3, {
        folderSlug: 'neutral-folder',
        takenAt: 1_778_200_000_000,
        sortTimestamp: 1_778_200_000_000
      })
    ];

    const ranked = rankReelCandidates(candidates, 17, {
      lastOpenedFolderSlug: 'recent-folder'
    });

    expect(ranked[0]?.candidate.folderSlug).toBe('liked-folder');
    expect(ranked[1]?.candidate.folderSlug).toBe('recent-folder');
  });

  it('adds a diversity penalty so consecutive reels do not cluster by folder when alternatives exist', () => {
    const queue = buildReelQueue(
      [
        createCandidate(1, {
          folderSlug: 'alpha',
          likedAt: '2026-03-25T00:00:00.000Z',
          takenAt: 1_778_300_003_000,
          sortTimestamp: 1_778_300_003_000
        }),
        createCandidate(2, {
          folderSlug: 'alpha',
          likedAt: '2026-03-25T00:00:00.000Z',
          takenAt: 1_778_300_002_000,
          sortTimestamp: 1_778_300_002_000
        }),
        createCandidate(3, {
          folderSlug: 'beta',
          takenAt: 1_778_300_001_000,
          sortTimestamp: 1_778_300_001_000,
          width: 1280,
          height: 720
        }),
        createCandidate(4, {
          folderSlug: 'gamma',
          takenAt: 1_778_300_000_000,
          sortTimestamp: 1_778_300_000_000,
          width: 1280,
          height: 720
        })
      ],
      77
    );

    expect(queue[0]?.folderSlug).toBe('alpha');
    expect(queue[1]?.folderSlug).not.toBe('alpha');
  });
});
