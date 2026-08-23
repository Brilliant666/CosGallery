import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeedItem, PlaceDetail, PlaceImagesPayload } from '../types/api';
import { usePlacesStore } from './places';

const {
  fetchPlaceImagesMock,
  fetchPlacesMock,
  fetchPlacesStatusMock,
  preparePlacesGeodataMock,
  rebuildPlacesMock
} = vi.hoisted(() => ({
  fetchPlaceImagesMock: vi.fn(),
  fetchPlacesMock: vi.fn(),
  fetchPlacesStatusMock: vi.fn(),
  preparePlacesGeodataMock: vi.fn(),
  rebuildPlacesMock: vi.fn()
}));

vi.mock('../api/gallery', () => ({
  fetchPlaceImages: fetchPlaceImagesMock,
  fetchPlaces: fetchPlacesMock,
  fetchPlacesStatus: fetchPlacesStatusMock,
  preparePlacesGeodata: preparePlacesGeodataMock,
  rebuildPlaces: rebuildPlacesMock
}));

function createDeferred<T>() {
  let resolve: ((value: T) => void) | null = null;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return {
    promise,
    resolve(value: T) {
      resolve?.(value);
    }
  };
}

function createPlace(slug: string, name: string): PlaceDetail {
  return {
    id: slug === 'alpha' ? 1 : 2,
    slug,
    name,
    kind: 'city',
    isApproximate: true,
    latitude: 31.5,
    longitude: 74.3,
    cityName: name,
    admin1Name: 'Punjab',
    countryName: 'Pakistan',
    countryCode: 'PK',
    description: null,
    postCount: 1
  };
}

function createFeedItem(id: number, place: PlaceDetail): FeedItem {
  return {
    id,
    folderId: 1,
    folderSlug: 'album',
    folderName: 'Album',
    folderPath: 'album',
    folderBreadcrumb: null,
    filename: `image-${id}.jpg`,
    width: 1200,
    height: 1500,
    mediaType: 'image',
    durationMs: null,
    thumbnailUrl: `/thumbnails/${id}.webp`,
    previewUrl: `/previews/${id}.webp`,
    sortTimestamp: 1_778_400_000_000 + id,
    takenAt: 1_778_400_000_000 + id,
    place
  };
}

describe('places store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fetchPlaceImagesMock.mockReset();
    fetchPlacesMock.mockReset();
    fetchPlacesStatusMock.mockReset();
    preparePlacesGeodataMock.mockReset();
    rebuildPlacesMock.mockReset();
  });

  it('caches an empty places response', async () => {
    fetchPlacesMock.mockResolvedValue({
      items: []
    });

    const placesStore = usePlacesStore();
    await placesStore.fetchPlaces();
    await placesStore.fetchPlaces();

    expect(fetchPlacesMock).toHaveBeenCalledTimes(1);
    expect(placesStore.items).toEqual([]);
    expect(placesStore.listError).toBeNull();
  });

  it('clears stale places when the list request fails and allows a retry', async () => {
    const alpha = createPlace('alpha', 'Alpha');
    const beta = createPlace('beta', 'Beta');
    fetchPlacesMock
      .mockResolvedValueOnce({
        items: [alpha]
      })
      .mockRejectedValueOnce(new Error('Temporary places failure'))
      .mockResolvedValueOnce({
        items: [beta]
      });

    const placesStore = usePlacesStore();
    await placesStore.fetchPlaces();

    expect(placesStore.items.map((place) => place.slug)).toEqual(['alpha']);

    await placesStore.fetchPlaces(true);

    expect(placesStore.items).toEqual([]);
    expect(placesStore.listError).toBe('Temporary places failure');

    await placesStore.fetchPlaces();

    expect(fetchPlacesMock).toHaveBeenCalledTimes(3);
    expect(placesStore.items.map((place) => place.slug)).toEqual(['beta']);
    expect(placesStore.listError).toBeNull();
  });

  it('ignores stale place responses after navigating to another place', async () => {
    const alpha = createPlace('alpha', 'Alpha');
    const beta = createPlace('beta', 'Beta');
    const alphaRequest = createDeferred<PlaceImagesPayload>();
    const betaRequest = createDeferred<PlaceImagesPayload>();
    fetchPlaceImagesMock.mockImplementation((slug: string) =>
      slug === 'alpha' ? alphaRequest.promise : betaRequest.promise
    );

    const placesStore = usePlacesStore();
    const alphaLoad = placesStore.loadPlace('alpha', true);
    const betaLoad = placesStore.loadPlace('beta', true);

    expect(fetchPlaceImagesMock).toHaveBeenCalledWith('alpha', 1, 24);
    expect(fetchPlaceImagesMock).toHaveBeenCalledWith('beta', 1, 24);

    betaRequest.resolve({
      place: beta,
      items: [createFeedItem(2, beta)],
      page: 1,
      limit: 24,
      total: 1,
      hasMore: false
    });
    await betaLoad;

    expect(placesStore.currentPlace?.slug).toBe('beta');
    expect(placesStore.currentImages.map((item) => item.id)).toEqual([2]);

    alphaRequest.resolve({
      place: alpha,
      items: [createFeedItem(1, alpha)],
      page: 1,
      limit: 24,
      total: 1,
      hasMore: false
    });
    await alphaLoad;

    expect(placesStore.currentPlace?.slug).toBe('beta');
    expect(placesStore.currentImages.map((item) => item.id)).toEqual([2]);
  });
});
