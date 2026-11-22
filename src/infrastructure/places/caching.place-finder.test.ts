import { describe, expect, mock, test } from 'bun:test';

import type { PointOfInterest } from '@/domain/types.ts';
import { CachingPlaceFinder } from '@/infrastructure/places/caching.place-finder.ts';

const CAFE: PointOfInterest = { id: 'node/1', name: 'Cafe', category: 'Café', lat: 1, lon: 1 };

function setup(maxEntries?: number) {
  const findNearbyPlaces = mock(async (): Promise<PointOfInterest[]> => [CAFE]);
  const finder = new CachingPlaceFinder({ findNearbyPlaces }, maxEntries);
  return { finder, findNearbyPlaces };
}

describe('CachingPlaceFinder', () => {
  test('answers a repeat lookup from memory', async () => {
    const { finder, findNearbyPlaces } = setup();

    expect(await finder.findNearbyPlaces(42.36, -71.05, 100)).toEqual([CAFE]);
    expect(await finder.findNearbyPlaces(42.36, -71.05, 100)).toEqual([CAFE]);

    expect(findNearbyPlaces).toHaveBeenCalledTimes(1);
  });

  test('treats points a few metres apart as the same lookup', async () => {
    const { finder, findNearbyPlaces } = setup();

    await finder.findNearbyPlaces(42.36001, -71.05001, 100);
    await finder.findNearbyPlaces(42.36004, -71.04996, 100);

    expect(findNearbyPlaces).toHaveBeenCalledTimes(1);
  });

  test('looks up a different spot or radius separately', async () => {
    const { finder, findNearbyPlaces } = setup();

    await finder.findNearbyPlaces(42.36, -71.05, 100);
    await finder.findNearbyPlaces(42.37, -71.05, 100);
    await finder.findNearbyPlaces(42.36, -71.05, 200);

    expect(findNearbyPlaces).toHaveBeenCalledTimes(3);
  });

  test('shares one request between concurrent lookups', async () => {
    const { finder, findNearbyPlaces } = setup();

    await Promise.all([finder.findNearbyPlaces(1, 1, 100), finder.findNearbyPlaces(1, 1, 100)]);

    expect(findNearbyPlaces).toHaveBeenCalledTimes(1);
  });

  test('does not remember failures', async () => {
    const findNearbyPlaces = mock(async (): Promise<PointOfInterest[]> => {
      throw new Error('busy');
    });
    const finder = new CachingPlaceFinder({ findNearbyPlaces });

    await expect(finder.findNearbyPlaces(1, 1, 100)).rejects.toThrow('busy');
    findNearbyPlaces.mockImplementation(async () => [CAFE]);

    expect(await finder.findNearbyPlaces(1, 1, 100)).toEqual([CAFE]);
    expect(findNearbyPlaces).toHaveBeenCalledTimes(2);
  });

  test('evicts the least recently used entry when full', async () => {
    const { finder, findNearbyPlaces } = setup(2);

    await finder.findNearbyPlaces(1, 1, 100);
    await finder.findNearbyPlaces(2, 2, 100);
    await finder.findNearbyPlaces(1, 1, 100); // refreshes (1, 1)
    await finder.findNearbyPlaces(3, 3, 100); // evicts (2, 2)
    await finder.findNearbyPlaces(1, 1, 100);
    await finder.findNearbyPlaces(2, 2, 100);

    expect(findNearbyPlaces).toHaveBeenCalledTimes(4);
  });
});
