import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_LOCALE, i18n } from '../locales';
import type { FeedItem, MomentCapsule } from '../types/api';
import { useMomentsStore } from './moments';

function createFeedItem(id: number): FeedItem {
  return {
    id,
    folderId: 2,
    folderSlug: 'weekend-trip',
    folderName: 'Weekend Trip',
    folderPath: 'weekend-trip',
    folderBreadcrumb: null,
    filename: `capsule-${id}.jpg`,
    width: 1080,
    height: 1080,
    mediaType: 'image',
    durationMs: null,
    isAnimated: false,
    thumbnailUrl: `/thumbs/${id}.webp`,
    previewUrl: `/previews/${id}.webp`,
    sortTimestamp: 1_777_100_000_000 + id,
    takenAt: 1_777_100_000_000 + id
  };
}

function createCapsule(
  id: string,
  title: string,
  subtitle: string,
  dateContext: string,
  momentDate?: MomentCapsule['momentDate']
): MomentCapsule {
  return {
    id,
    title,
    subtitle,
    dateContext,
    imageCount: 2,
    coverImage: createFeedItem(1),
    ...(momentDate ? { momentDate } : {})
  };
}

function formatRange(locale: string, startDate: Date, endDate: Date) {
  const formatter = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  if (typeof formatter.formatRange === 'function') {
    return formatter.formatRange(startDate, endDate);
  }

  return `${formatter.format(startDate)} - ${formatter.format(endDate)}`;
}

describe('useMomentsStore localization', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    i18n.global.locale.value = DEFAULT_LOCALE;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('localizes highlight rails and static capsule titles from their ids', () => {
    const store = useMomentsStore();

    store.$patch({
      railKind: 'highlights',
      items: [
        createCapsule('highlight-recent-batches', 'Recent Batches', 'Latest runs gathered into one set', '2 batches'),
        createCapsule('highlight-lucky-dip', 'Lucky Dip', 'A playful mix from across the library', 'Stable for today')
      ],
      currentMoment: createCapsule(
        'highlight-recent-batches',
        'Recent Batches',
        'Latest runs gathered into one set',
        '2 batches'
      )
    });

    i18n.global.locale.value = 'zh';

    expect(store.displayRailTitle).toBe('故事');
    expect(store.displayRailSingularLabel).toBe('故事');
    expect(store.localizedItems[0]?.title).toBe('近期批次');
    expect(store.localizedItems[0]?.subtitle).toBe('将最近几次拍摄合并为一个合集');
    expect(store.localizedItems[0]?.dateContext).toBe('2 个批次');
    expect(store.currentCapsule?.title).toBe('近期批次');
  });

  it('localizes date-based moment capsules without leaving English subtitle or date copy behind', () => {
    vi.setSystemTime(new Date('2026-05-31T12:00:00.000Z'));

    const store = useMomentsStore();

    store.$patch({
      railKind: 'moments',
      items: [
        createCapsule('on-this-day', 'On This Day', 'May 29 across previous years', 'May 29', {
          type: 'on-this-day',
          date: {
            year: 2026,
            month: 5,
            day: 29
          }
        }),
        createCapsule('this-week-previous-years', 'This Week', 'May 22-Jun 5, 2026 from previous years', 'May 22-Jun 5, 2026', {
          type: 'this-week-previous-years',
          startDate: {
            year: 2026,
            month: 5,
            day: 22
          },
          endDate: {
            year: 2026,
            month: 6,
            day: 5
          }
        }),
        createCapsule('from-last-year', 'Last Year Around Now', 'A revisit to May 2025', 'Apr 14, 2025 to Jul 13, 2025', {
          type: 'from-last-year',
          referenceDate: {
            year: 2025,
            month: 5,
            day: 29
          },
          startDate: {
            year: 2025,
            month: 4,
            day: 14
          },
          endDate: {
            year: 2025,
            month: 7,
            day: 13
          }
        })
      ],
      currentMoment: createCapsule(
        'from-last-year',
        'Last Year Around Now',
        'A revisit to May 2025',
        'Apr 14, 2025 to Jul 13, 2025',
        {
          type: 'from-last-year',
          referenceDate: {
            year: 2025,
            month: 5,
            day: 29
          },
          startDate: {
            year: 2025,
            month: 4,
            day: 14
          },
          endDate: {
            year: 2025,
            month: 7,
            day: 13
          }
        }
      )
    });

    i18n.global.locale.value = 'zh';

    const expectedMonthDay = new Intl.DateTimeFormat('zh', {
      month: 'long',
      day: 'numeric'
    }).format(new Date(2026, 4, 29));
    const expectedThisWeekRange = formatRange('zh', new Date(2026, 4, 22), new Date(2026, 5, 5));
    const expectedLastYearMonth = new Intl.DateTimeFormat('zh', {
      month: 'long',
      year: 'numeric'
    }).format(new Date(2025, 4, 29));
    const expectedLastYearRange = formatRange('zh', new Date(2025, 3, 14), new Date(2025, 6, 13));

    expect(store.localizedItems[0]).toMatchObject({
      title: '历史上的今天',
      subtitle: `${expectedMonthDay} 在往年此日`,
      dateContext: expectedMonthDay
    });
    expect(store.localizedItems[1]).toMatchObject({
      title: '本周回顾',
      subtitle: `${expectedThisWeekRange} 的往年回顾`,
      dateContext: expectedThisWeekRange
    });
    expect(store.currentCapsule).toMatchObject({
      title: '去年此时',
      subtitle: `重温 ${expectedLastYearMonth}`,
      dateContext: expectedLastYearRange
    });
  });

  it('preserves the server-selected capsule copy when momentDate is missing instead of recomputing from the client clock', () => {
    vi.setSystemTime(new Date('2026-05-31T12:00:00.000Z'));

    const store = useMomentsStore();

    store.$patch({
      railKind: 'moments',
      items: [createCapsule('on-this-day', 'On This Day', 'May 29 across previous years', 'May 29')],
      currentMoment: createCapsule('from-last-year', 'Last Year Around Now', 'A revisit to May 2025', 'Apr 14, 2025 to Jul 13, 2025')
    });

    i18n.global.locale.value = 'zh';

    expect(store.localizedItems[0]).toMatchObject({
      title: 'On This Day',
      subtitle: 'May 29 across previous years',
      dateContext: 'May 29'
    });
    expect(store.currentCapsule).toMatchObject({
      title: 'Last Year Around Now',
      subtitle: 'A revisit to May 2025',
      dateContext: 'Apr 14, 2025 to Jul 13, 2025'
    });
  });

  it('ignores malformed momentDate payloads without throwing during localization', () => {
    const store = useMomentsStore();

    store.$patch({
      railKind: 'moments',
      items: [
        createCapsule('from-last-year', 'Last Year Around Now', 'A revisit to May 2025', 'Apr 14, 2025 to Jul 13, 2025', {
          type: 'from-last-year',
          referenceDate: {
            year: 2025,
            month: 13,
            day: 29
          },
          startDate: {
            year: 2025,
            month: 4,
            day: 14
          },
          endDate: {
            year: 2025,
            month: 7,
            day: 13
          }
        })
      ],
      currentMoment: createCapsule('on-this-day', 'On This Day', 'May 29 across previous years', 'May 29', {
        type: 'on-this-day',
        date: {
          year: 2026,
          month: 2,
          day: 31
        }
      })
    });

    i18n.global.locale.value = 'zh';

    expect(() => store.localizedItems[0]).not.toThrow();
    expect(() => store.currentCapsule).not.toThrow();
    expect(store.localizedItems[0]).toMatchObject({
      title: 'Last Year Around Now',
      subtitle: 'A revisit to May 2025',
      dateContext: 'Apr 14, 2025 to Jul 13, 2025'
    });
    expect(store.currentCapsule).toMatchObject({
      title: 'On This Day',
      subtitle: 'May 29 across previous years',
      dateContext: 'May 29'
    });
  });
});
