import { describe, expect, mock, test } from 'bun:test';

import { inferVisitedPlaces } from '@/application/infer-visited-places.ts';
import type { PlaceFinder } from '@/domain/ports.ts';
import type { Area, LocationPayload, PointOfInterest } from '@/domain/types.ts';
import { buildArea } from '@/test/factories.ts';
import { mockLogger } from '@/test/mocks.ts';

const METERS_PER_DEGREE_LAT = 111_320;
const HOME = { lat: 42.3601, lon: -71.0589 };
const GROCERY = { lat: 42.37, lon: -71.04 };
const CAFE = { lat: 42.35, lon: -71.08 };

function offset(point: { lat: number; lon: number }, north: number, east = 0) {
  return {
    lat: point.lat + north / METERS_PER_DEGREE_LAT,
    lon: point.lon + east / (METERS_PER_DEGREE_LAT * Math.cos((point.lat * Math.PI) / 180)),
  };
}

/** A fix every minute at `point` for `minutes`, starting at `from`. */
function stayAt(point: { lat: number; lon: number }, from: number, minutes: number) {
  const fixes: LocationPayload[] = [];
  for (let minute = 0; minute <= minutes; minute += 1) {
    fixes.push({ _type: 'location', tid: 'u', tst: from + minute * 60, ...point });
  }
  return fixes;
}

/** Two fixes far from everywhere, so the previous stay is closed. */
function travel(tst: number): LocationPayload[] {
  return [
    { _type: 'location', tid: 'u', tst, lat: 43, lon: -72 },
    { _type: 'location', tid: 'u', tst: tst + 60, lat: 44, lon: -73 },
  ];
}

function poi(name: string, category: string, point: { lat: number; lon: number }): PointOfInterest {
  return { id: `node/${name}`, name, category, ...point };
}

/**
 * Two grocery trips, a café stop, and an evening at home. The far-away fixes
 * between stays close each one; they are a minute apart, so they never form a
 * visit themselves.
 */
const HISTORY: LocationPayload[] = [
  ...stayAt(GROCERY, 0, 30),
  ...travel(1_860),
  ...stayAt(CAFE, 1_980, 10),
  ...travel(2_640),
  ...stayAt(offset(GROCERY, 20), 2_760, 20),
  ...travel(4_020),
  ...stayAt(HOME, 4_140, 120),
];

function setup(
  options: { history?: LocationPayload[]; areas?: Area[]; placeFinder?: PlaceFinder } = {},
) {
  const history = options.history ?? HISTORY;
  const listLocations = mock(async function* () {
    yield* history;
  });
  const logger = mockLogger();
  const deps = {
    repo: { listLocations },
    areaRepo: { listAreas: mock(async () => options.areas ?? []) },
    // An explicit `placeFinder: undefined` means "no finder configured".
    placeFinder:
      'placeFinder' in options
        ? options.placeFinder
        : { findNearbyPlaces: mock(async (): Promise<PointOfInterest[]> => []) },
    logger,
  };
  return { deps, listLocations, logger };
}

describe('inferVisitedPlaces', () => {
  test('groups repeat visits into places, busiest first', async () => {
    const { deps } = setup({ placeFinder: undefined });

    const places = await inferVisitedPlaces('u', deps);

    expect(places.map((place) => place.visits.length)).toEqual([2, 1, 1]);
    const [grocery, home, cafe] = places;
    expect(grocery!.lat).toBeCloseTo(GROCERY.lat, 3);
    expect(grocery!.totalSeconds).toBe(50 * 60);
    expect(grocery!.visits.map((visit) => visit.arrivedAt)).toEqual([0, 2_760]);
    // With one visit each, more time spent ranks higher.
    expect(home!.totalSeconds).toBe(120 * 60);
    expect(cafe!.totalSeconds).toBe(10 * 60);
  });

  test('reads only the requested range', async () => {
    const { deps, listLocations } = setup();

    await inferVisitedPlaces('u', deps, { range: { from: 50, to: 500 } });

    expect(listLocations).toHaveBeenCalledWith('u', { from: 50, to: 500 });
  });

  test("names a place after the user's own area and never looks it up", async () => {
    const findNearbyPlaces = mock(async (): Promise<PointOfInterest[]> => []);
    const { deps } = setup({
      areas: [
        buildArea({ id: 'big', name: 'Neighbourhood', ...HOME, radius: 1_000 }),
        buildArea({ id: 'home', name: 'Home', ...HOME, radius: 150 }),
      ],
      placeFinder: { findNearbyPlaces },
    });

    const places = await inferVisitedPlaces('u', deps);

    const home = places.find((place) => place.area);
    expect(home!.area).toEqual({ id: 'home', name: 'Home' });
    expect(home!.lookup).toBe('area');
    expect(findNearbyPlaces).toHaveBeenCalledTimes(2);
    for (const [lat] of findNearbyPlaces.mock.calls as unknown as [number][]) {
      expect(lat).not.toBeCloseTo(HOME.lat, 3);
    }
  });

  test('ranks nearby places nearest first and drops duplicates', async () => {
    const { deps } = setup({
      placeFinder: {
        findNearbyPlaces: async (lat, lon) =>
          lat > 42.36 && lon > -71.05
            ? [
                poi('Bakery', 'Bakery', offset(GROCERY, 60)),
                poi('Fresh Market', 'Grocery store', offset(GROCERY, 5)),
                poi('Fresh Market', 'Grocery store', offset(GROCERY, 30)),
              ]
            : [],
      },
    });

    const [grocery, home] = await inferVisitedPlaces('u', deps);

    expect(grocery!.lookup).toBe('found');
    expect(grocery!.candidates.map((candidate) => candidate.name)).toEqual([
      'Fresh Market',
      'Bakery',
    ]);
    expect(grocery!.candidates[0]!.distanceMeters).toBeLessThan(10);
    expect(home!.lookup).toBe('none');
    expect(home!.candidates).toEqual([]);
  });

  test('keeps at most `maxCandidates` nearby places', async () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      poi(`Shop ${index}`, 'Shop', offset(GROCERY, -index * 5)),
    );
    const { deps } = setup({ placeFinder: { findNearbyPlaces: async () => many } });

    const [grocery] = await inferVisitedPlaces('u', deps, { maxCandidates: 3 });

    expect(grocery!.candidates.map((candidate) => candidate.name)).toEqual([
      'Shop 0',
      'Shop 1',
      'Shop 2',
    ]);
  });

  test('looks up only the busiest places within the budget', async () => {
    const findNearbyPlaces = mock(async (): Promise<PointOfInterest[]> => []);
    const { deps } = setup({ placeFinder: { findNearbyPlaces } });

    const places = await inferVisitedPlaces('u', deps, { maxLookups: 1 });

    expect(findNearbyPlaces).toHaveBeenCalledTimes(1);
    expect(places.map((place) => place.lookup)).toEqual(['none', 'skipped', 'skipped']);
  });

  test('stops looking up after a failure, keeping the places it found', async () => {
    const findNearbyPlaces = mock(async (): Promise<PointOfInterest[]> => {
      throw new Error('429 Too Many Requests');
    });
    const { deps, logger } = setup({ placeFinder: { findNearbyPlaces } });

    const places = await inferVisitedPlaces('u', deps);

    expect(findNearbyPlaces).toHaveBeenCalledTimes(1);
    expect(places.map((place) => place.lookup)).toEqual(['failed', 'skipped', 'skipped']);
    expect(places.every((place) => place.visits.length > 0)).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('stops starting lookups once the time budget is spent', async () => {
    let clock = 0;
    const findNearbyPlaces = mock(async (): Promise<PointOfInterest[]> => {
      clock += 12_000;
      return [];
    });
    const { deps } = setup({ placeFinder: { findNearbyPlaces } });

    const places = await inferVisitedPlaces(
      'u',
      { ...deps, now: () => clock },
      { lookupBudgetMs: 20_000 },
    );

    // 0 s and 12 s are inside the budget; by the third, 24 s have passed.
    expect(findNearbyPlaces).toHaveBeenCalledTimes(2);
    expect(places.map((place) => place.lookup)).toEqual(['none', 'none', 'skipped']);
  });

  test('without a place finder, places outside an area are marked as off', async () => {
    const { deps } = setup({
      areas: [buildArea({ name: 'Home', ...HOME, radius: 150 })],
      placeFinder: undefined,
    });

    const places = await inferVisitedPlaces('u', deps);

    expect(places.map((place) => place.lookup)).toEqual(['off', 'area', 'off']);
  });

  test('no history means no places', async () => {
    const { deps } = setup({ history: [] });

    expect(await inferVisitedPlaces('u', deps)).toEqual([]);
  });
});
