import { describe, expect, mock, test } from 'bun:test';

import {
  buildDayTimeline,
  type TimelineStop,
  type TimelineTrip,
} from '@/application/build-day-timeline.ts';
import { distanceMeters } from '@/application/replay-geofence.ts';
import { zonedDayRange } from '@/application/zoned-day.ts';
import type { PlaceFinder } from '@/domain/ports.ts';
import type { Area, LocationPayload } from '@/domain/types.ts';
import { buildArea } from '@/test/factories.ts';
import { mockLogger } from '@/test/mocks.ts';

const DATE = '2026-11-22';
const DAY = zonedDayRange(DATE, 'UTC');
const HOUR = 3600;
const MINUTE = 60;

// Public Boston landmarks, as in the other fixtures.
const HOME = { lat: 42.3467, lon: -71.0972 }; // Fenway
const MARKET = { lat: 42.3603, lon: -71.0554 }; // Faneuil Hall
/** Points between them, each well over 100 m from the last, so none is a stop. */
const ON_THE_WAY: [number, number][] = [
  [42.3495, -71.09],
  [42.3525, -71.0825],
  [42.3555, -71.074],
  [42.357, -71.065],
  [42.358, -71.06],
];

function fix(lat: number, lon: number, tst: number, acc = 10): LocationPayload {
  return { _type: 'location', tid: 'AB', lat, lon, tst, acc } as LocationPayload;
}

/** A fix every `everyMinutes` at one spot, from `from` for `minutes`. */
function stay(at: { lat: number; lon: number }, from: number, minutes: number, everyMinutes = 2) {
  const fixes: LocationPayload[] = [];
  for (let minute = 0; minute <= minutes; minute += everyMinutes) {
    fixes.push(fix(at.lat, at.lon, from + minute * MINUTE));
  }
  return fixes;
}

/** One fix a minute along `points`, starting at `from`. */
function travel(points: [number, number][], from: number) {
  return points.map(([lat, lon], index) => fix(lat, lon, from + index * MINUTE));
}

function setup(
  fixes: LocationPayload[],
  { areas = [], placeFinder }: { areas?: Area[]; placeFinder?: PlaceFinder } = {},
) {
  const listLocations = mock(async function* (
    _userId: string,
    range?: { from?: number; to?: number },
  ) {
    for (const location of [...fixes].sort((a, b) => a.tst - b.tst)) {
      if (location.tst >= (range?.from ?? -Infinity) && location.tst <= (range?.to ?? Infinity)) {
        yield location;
      }
    }
  });
  const deps = {
    repo: { listLocations },
    areaRepo: { listAreas: async () => areas },
    ...(placeFinder ? { placeFinder } : {}),
    logger: mockLogger(),
  };
  return {
    listLocations,
    build: () => buildDayTimeline('AB', deps, { date: DATE, timeZone: 'UTC' }),
  };
}

const stops = (entries: (TimelineStop | TimelineTrip)[]) =>
  entries.filter((entry): entry is TimelineStop => entry.kind === 'stop');
const trips = (entries: (TimelineStop | TimelineTrip)[]) =>
  entries.filter((entry): entry is TimelineTrip => entry.kind === 'trip');

describe('buildDayTimeline', () => {
  test('two stops give one trip, traced through the fixes on the way', async () => {
    const leave = DAY.from + 9 * HOUR;
    const { build } = setup([
      ...stay(HOME, DAY.from + 8 * HOUR, 60),
      ...travel(ON_THE_WAY, leave + MINUTE),
      ...stay(MARKET, leave + 10 * MINUTE, 40),
    ]);

    const { entries } = await build();

    expect(entries.map((entry) => entry.kind)).toEqual(['stop', 'trip', 'stop']);
    const [home, market] = stops(entries);
    const [trip] = trips(entries);
    expect(trip).toMatchObject({
      startedAt: home!.departedAt,
      endedAt: market!.arrivedAt,
      fromLabel: 'Unknown place',
      toLabel: 'Unknown place',
      isPathEstimated: false,
      isOngoing: false,
      isFromOpenStreetMap: false,
    });
    // Both stops' centres, with every fix on the way between them.
    expect(trip!.path).toHaveLength(ON_THE_WAY.length + 2);
    expect(trip!.path[0]).toMatchObject({ lat: home!.lat, lon: home!.lon });
    expect(trip!.path.at(-1)).toMatchObject({ lat: market!.lat, lon: market!.lon });
    // Following the route is longer than the straight line.
    const straight = distanceMeters(HOME, MARKET.lat, MARKET.lon);
    expect(trip!.distanceMeters).toBeGreaterThan(straight);
    expect(trip!.distanceMeters).toBeLessThan(straight * 1.5);
  });

  test('a quiet phone gives a straight, estimated path', async () => {
    const { build } = setup([
      ...stay(HOME, DAY.from + 8 * HOUR, 60),
      ...stay(MARKET, DAY.from + 9 * HOUR + 20 * MINUTE, 40),
    ]);

    const [trip] = trips((await build()).entries);

    expect(trip!.path).toHaveLength(2);
    expect(trip!.isPathEstimated).toBe(true);
    expect(trip!.distanceMeters).toBeCloseTo(distanceMeters(HOME, MARKET.lat, MARKET.lon), 0);
  });

  test('still moving at the last fix gives an ongoing trip', async () => {
    const leave = DAY.from + 9 * HOUR;
    const { build } = setup([
      ...stay(HOME, DAY.from + 8 * HOUR, 60),
      ...travel(ON_THE_WAY, leave + MINUTE),
    ]);

    const { entries } = await build();

    expect(entries.map((entry) => entry.kind)).toEqual(['stop', 'trip']);
    const [trip] = trips(entries);
    expect(trip).toMatchObject({ isOngoing: true, fromLabel: 'Unknown place' });
    expect(trip!.toLabel).toBeUndefined();
    expect(trip!.endedAt).toBe(leave + ON_THE_WAY.length * MINUTE);
  });

  test('an overnight stay is found whole, running past midnight', async () => {
    const leave = DAY.from + 7 * HOUR;
    const { build } = setup([
      ...stay(HOME, DAY.from - 6 * HOUR, 13 * 60, 10),
      ...travel(ON_THE_WAY, leave + MINUTE),
      ...stay(MARKET, leave + 10 * MINUTE, 40),
    ]);

    const [home] = stops((await build()).entries);

    expect(home!.arrivedAt).toBe(DAY.from - 6 * HOUR);
    expect(home!.departedAt).toBeGreaterThanOrEqual(leave);
  });

  test('stops and trips wholly outside the day are left out', async () => {
    const { build } = setup([
      // The evening before: a market visit, then home for the night.
      ...stay(MARKET, DAY.from - 10 * HOUR, 30),
      ...travel([...ON_THE_WAY].reverse(), DAY.from - 9 * HOUR - 20 * MINUTE),
      ...stay(HOME, DAY.from - 9 * HOUR, 20 * 60, 10),
      // Early the next morning, inside the lead-out but not the day.
      ...stay(MARKET, DAY.to + 30 * MINUTE, 30),
    ]);

    const { entries } = await build();

    // Only the stay at home, which began the evening before.
    expect(entries.map((entry) => entry.kind)).toEqual(['stop']);
    const [home] = stops(entries);
    expect(home!.arrivedAt).toBe(DAY.from - 9 * HOUR);
    // The phone went quiet at home, so the user is taken to have stayed until
    // just before the next morning's trip: the stop runs past midnight.
    expect(home!.departedAt).toBeGreaterThan(DAY.to);
  });

  test("names stops from the user's areas, and credits OpenStreetMap only for looked-up names", async () => {
    const findNearbyPlaces = mock(async (lat: number) =>
      Math.abs(lat - MARKET.lat) < 0.001
        ? [{ id: 'node/1', name: 'Fresh Market', category: 'Grocery store', ...MARKET }]
        : [],
    );
    const leave = DAY.from + 9 * HOUR;
    const { build } = setup(
      [
        ...stay(HOME, DAY.from + 8 * HOUR, 60),
        ...travel(ON_THE_WAY, leave + MINUTE),
        ...stay(MARKET, leave + 10 * MINUTE, 40),
      ],
      {
        areas: [buildArea({ id: 'home', userId: 'AB', name: 'Home', ...HOME, radius: 150 })],
        placeFinder: { findNearbyPlaces },
      },
    );

    const { entries } = await build();

    const [home, market] = stops(entries);
    expect(home).toMatchObject({
      label: 'Home',
      category: 'Saved area',
      isFromOpenStreetMap: false,
    });
    expect(market).toMatchObject({
      label: 'Fresh Market',
      category: 'Grocery store',
      isFromOpenStreetMap: true,
    });
    // The trip carries the credit too, for when the looked-up stop is outside the day.
    expect(trips(entries)[0]).toMatchObject({
      fromLabel: 'Home',
      toLabel: 'Fresh Market',
      isFromOpenStreetMap: true,
    });
    // Home is one of the user's areas, so it is never sent to the place finder.
    expect(findNearbyPlaces).toHaveBeenCalledTimes(1);
  });

  test('a date the zone skipped is empty, even with a stay spanning the jump', async () => {
    // Samoa jumped from 2011-12-29 straight to 2011-12-31, at 10:00 UTC on the 30th.
    const jump = Date.UTC(2011, 11, 30, 10) / 1000;
    const listLocations = mock(async function* () {
      yield* stay(HOME, jump - HOUR, 2 * 60, 10);
    });
    const deps = {
      repo: { listLocations },
      areaRepo: { listAreas: async () => [] },
      logger: mockLogger(),
    };

    const timeline = await buildDayTimeline('AB', deps, {
      date: '2011-12-30',
      timeZone: 'Pacific/Apia',
    });

    expect(timeline.entries).toEqual([]);
    expect(listLocations).not.toHaveBeenCalled();
  });

  test('reads only the day, with 12 hours before it and 2 after', async () => {
    const { build, listLocations } = setup([]);

    const timeline = await build();

    expect(listLocations).toHaveBeenCalledWith('AB', {
      from: DAY.from - 12 * HOUR,
      to: DAY.to + 2 * HOUR,
    });
    expect(timeline).toMatchObject({ userId: 'AB', date: DATE, timeZone: 'UTC', day: DAY });
    expect(timeline.entries).toEqual([]);
  });

  test('inaccurate fixes never bend a route', async () => {
    const leave = DAY.from + 9 * HOUR;
    const { build } = setup([
      ...stay(HOME, DAY.from + 8 * HOUR, 60),
      ...travel(ON_THE_WAY.slice(0, 2), leave + MINUTE),
      fix(42.5, -71.5, leave + 3 * MINUTE, 900),
      ...travel(ON_THE_WAY.slice(2), leave + 4 * MINUTE),
      ...stay(MARKET, leave + 10 * MINUTE, 40),
    ]);

    const [trip] = trips((await build()).entries);

    expect(trip!.path.some((point) => point.lat === 42.5)).toBe(false);
    expect(trip!.path).toHaveLength(ON_THE_WAY.length + 2);
  });
});
