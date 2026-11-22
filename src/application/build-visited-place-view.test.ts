import { describe, expect, test } from 'bun:test';

import { buildVisitedPlaceView, formatDuration } from '@/application/build-visited-place-view.ts';
import type { NearbyPlace, VisitedPlace } from '@/application/infer-visited-places.ts';

function nearby(name: string, category: string, distanceMeters: number): NearbyPlace {
  return { id: `node/${name}`, name, category, lat: 42.37, lon: -71.04, distanceMeters };
}

function place(overrides: Partial<VisitedPlace> = {}): VisitedPlace {
  return {
    lat: 42.37,
    lon: -71.04,
    visits: [
      {
        lat: 42.37,
        lon: -71.04,
        arrivedAt: 1_700_000_000,
        departedAt: 1_700_001_800,
        locationCount: 30,
      },
    ],
    totalSeconds: 1_800,
    candidates: [],
    lookup: 'none',
    ...overrides,
  };
}

describe('buildVisitedPlaceView', () => {
  test('labels a place with its most likely nearby place and lists the rest', () => {
    const view = buildVisitedPlaceView('u', [
      place({
        lookup: 'found',
        candidates: [
          nearby('Fresh Market', 'Grocery store', 8.4),
          nearby('Corner Café', 'Café', 41.6),
        ],
      }),
    ]);

    expect(view.userId).toBe('u');
    expect(view.rows[0]).toEqual({
      placeId: 'place-1',
      label: 'Fresh Market',
      category: 'Grocery store',
      lookup: 'found',
      lat: 42.37,
      lon: -71.04,
      visitCount: 1,
      totalSeconds: 1_800,
      durationLabel: '30 min',
      lastVisitIso: '2023-11-14T22:43:20.000Z',
      alternatives: [{ name: 'Corner Café', category: 'Café', distanceMeters: 42 }],
      proposedArea: { name: 'Fresh Market', lat: 42.37, lon: -71.04, radius: 100 },
    });
  });

  test("uses the user's area name and offers no alternatives", () => {
    const view = buildVisitedPlaceView('u', [
      place({
        area: { id: 'home', name: 'Home' },
        lookup: 'area',
        candidates: [nearby('Fresh Market', 'Grocery store', 8)],
      }),
    ]);

    expect(view.rows[0]).toMatchObject({ label: 'Home', category: 'Saved area', alternatives: [] });
    expect(view.rows[0]!.note).toBeUndefined();
    // Already an area, so there is nothing to propose.
    expect(view.rows[0]!.proposedArea).toBeUndefined();
  });

  test('proposes an unnamed area for a place with nothing named nearby', () => {
    const [row] = buildVisitedPlaceView('u', [place({ lookup: 'none' })]).rows;

    expect(row!.proposedArea).toEqual({ name: '', lat: 42.37, lon: -71.04, radius: 100 });
  });

  test("proposes a circle wide enough for every visit's stop", () => {
    const [visit] = place().visits;
    const view = buildVisitedPlaceView('u', [
      // 0.0003° of latitude is 33.4 m, so the farthest stop reaches 133.4 m out.
      place({ visits: [visit!, { ...visit!, lat: 42.3703 }, { ...visit!, lon: -71.0401 }] }),
    ]);

    expect(view.rows[0]!.proposedArea!.radius).toBe(140);
  });

  test('rounds the proposed centre to about 0.1 m', () => {
    const [row] = buildVisitedPlaceView('u', [
      place({ lat: 42.360319375, lon: -71.05539999999999 }),
    ]).rows;

    expect(row!.proposedArea).toMatchObject({ lat: 42.360319, lon: -71.0554 });
  });

  test.each([
    ['none', 'Nothing named nearby'],
    ['skipped', 'Not looked up yet; run again to identify more'],
    ['failed', 'Lookup failed; try again later'],
    ['off', 'Nearby lookups are turned off'],
  ] as const)('explains an unnamed place whose lookup was %s', (lookup, note) => {
    const [row] = buildVisitedPlaceView('u', [place({ lookup })]).rows;

    expect(row!.label).toBe('Unknown place');
    expect(row!.category).toBeUndefined();
    expect(row!.note).toBe(note);
  });

  test('adds up visits by category, busiest first, leaving out areas', () => {
    const visits = place().visits;
    const view = buildVisitedPlaceView('u', [
      place({
        visits: [...visits, ...visits, ...visits],
        candidates: [nearby('A', 'Grocery store', 1)],
      }),
      place({ visits: [...visits, ...visits], candidates: [nearby('B', 'Café', 1)] }),
      place({ visits, candidates: [nearby('C', 'Grocery store', 1)] }),
      place({
        visits: [...visits, ...visits, ...visits, ...visits],
        area: { id: 'h', name: 'Home' },
      }),
      place({ visits }),
    ]);

    expect(view.categories).toEqual([
      { category: 'Grocery store', visitCount: 4, placeCount: 2 },
      { category: 'Café', visitCount: 2, placeCount: 1 },
    ]);
  });

  test('reports the end of the latest visit', () => {
    const view = buildVisitedPlaceView('u', [
      place({
        visits: [
          { lat: 1, lon: 1, arrivedAt: 0, departedAt: 600, locationCount: 2 },
          { lat: 1, lon: 1, arrivedAt: 86_400, departedAt: 90_000, locationCount: 2 },
        ],
      }),
    ]);

    expect(view.rows[0]!.lastVisitIso).toBe('1970-01-02T01:00:00.000Z');
  });

  test('puts each point at [lon, lat] and bounds every place', () => {
    const view = buildVisitedPlaceView('u', [place(), place({ lat: 40, lon: -70 })]);

    expect(view.featureCollection.features[0]!.geometry.coordinates).toEqual([-71.04, 42.37]);
    expect(view.featureCollection.features[1]!.properties.placeId).toBe('place-2');
    expect(view.bounds).toEqual([-71.04, 40, -70, 42.37]);
  });

  test('has no rows, categories or bounds without places', () => {
    const view = buildVisitedPlaceView('u', []);

    expect(view.rows).toEqual([]);
    expect(view.categories).toEqual([]);
    expect(view.bounds).toBeUndefined();
  });
});

describe('formatDuration', () => {
  test.each([
    [10, '1 min'],
    [45 * 60, '45 min'],
    [60 * 60, '1h'],
    [200 * 60, '3h 20m'],
    [24 * 3_600, '1d'],
    [52 * 3_600, '2d 4h'],
  ])('%d seconds is %s', (seconds, label) => {
    expect(formatDuration(seconds)).toBe(label);
  });
});
