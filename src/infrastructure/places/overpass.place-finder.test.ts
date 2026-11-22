import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import {
  buildQuery,
  categorize,
  OverpassPlaceFinder,
} from '@/infrastructure/places/overpass.place-finder.ts';

const ENDPOINT = 'https://overpass.example/api/interpreter';
const fetchSpy = spyOn(globalThis, 'fetch');

// Other test files use real HTTP; do not leak this global spy into them.
afterAll(() => fetchSpy.mockRestore());

beforeEach(() => {
  fetchSpy.mockReset();
});

function jsonResponse(body: object) {
  return new Response(JSON.stringify(body));
}

describe('OverpassPlaceFinder', () => {
  test('posts the query to the configured endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ elements: [] }));
    const finder = new OverpassPlaceFinder(ENDPOINT);

    await finder.findNearbyPlaces(42.3601, -71.0589, 100);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(init?.method).toBe('POST');
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('data')).toBe(buildQuery(42.3601, -71.0589, 100));
  });

  test('maps nodes and ways to points of interest', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        elements: [
          {
            type: 'node',
            id: 1,
            lat: 42.36,
            lon: -71.05,
            tags: { name: 'Fresh Market', shop: 'supermarket' },
          },
          {
            type: 'way',
            id: 2,
            center: { lat: 42.37, lon: -71.06 },
            nodes: [10, 11, 12],
            tags: { name: 'Riverside Park', leisure: 'park' },
          },
        ],
      }),
    );

    const places = await new OverpassPlaceFinder(ENDPOINT).findNearbyPlaces(42.36, -71.05, 100);

    expect(places).toEqual([
      { id: 'node/1', name: 'Fresh Market', category: 'Grocery store', lat: 42.36, lon: -71.05 },
      { id: 'way/2', name: 'Riverside Park', category: 'Park', lat: 42.37, lon: -71.06 },
    ]);
  });

  test('drops unnamed, unplaced, and ignored features', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        elements: [
          { type: 'node', id: 1, lat: 1, lon: 1, tags: { amenity: 'cafe' } },
          { type: 'way', id: 2, tags: { name: 'No Centre', shop: 'bakery' } },
          { type: 'node', id: 3, lat: 1, lon: 1, tags: { name: 'Lot 4', amenity: 'parking' } },
          { type: 'node', id: 4, lat: 1, lon: 1 },
        ],
      }),
    );

    expect(await new OverpassPlaceFinder(ENDPOINT).findNearbyPlaces(1, 1, 100)).toEqual([]);
  });

  test('throws on an error status so the caller can back off', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('busy', { status: 429, statusText: 'Too Many Requests' }),
    );

    await expect(new OverpassPlaceFinder(ENDPOINT).findNearbyPlaces(1, 1, 100)).rejects.toThrow(
      'Overpass query failed: 429 Too Many Requests',
    );
  });

  test('treats a response without elements as nothing found', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}));

    expect(await new OverpassPlaceFinder(ENDPOINT).findNearbyPlaces(1, 1, 100)).toEqual([]);
  });
});

describe('buildQuery', () => {
  test('searches named place features around the point', () => {
    expect(buildQuery(42.3601, -71.0589, 99.6)).toBe(
      '[out:json][timeout:10];nwr(around:100,42.360100,-71.058900)[name]' +
        '[~"^(shop|amenity|healthcare|leisure|tourism|office|craft)$"~"."];out center 100;',
    );
  });

  test('never prints coordinates in exponent form', () => {
    expect(buildQuery(1e-7, -1e-7, 50)).toContain('around:50,0.000000,-0.000000');
  });
});

describe('categorize', () => {
  test.each([
    [{ shop: 'supermarket' }, 'Grocery store'],
    [{ shop: 'greengrocer' }, 'Grocery store'],
    [{ amenity: 'cafe' }, 'Café'],
    [{ leisure: 'fitness_centre' }, 'Gym'],
    [{ amenity: 'fuel' }, 'Gas station'],
    [{ office: 'company' }, 'Office'],
    [{ shop: 'car_parts' }, 'Car parts'],
    [{ shop: 'yes' }, 'Shop'],
    [{ shop: 'bakery;cafe' }, 'Bakery'],
  ])('%o is %s', (tags, category) => {
    expect(categorize(tags)).toBe(category);
  });

  test('prefers the shop over the amenity when both are tagged', () => {
    expect(categorize({ amenity: 'cafe', shop: 'books' })).toBe('Bookstore');
  });

  test('skips an ignored tag in favour of a meaningful one', () => {
    expect(categorize({ amenity: 'parking', leisure: 'park' })).toBe('Park');
  });

  test('is undefined when nothing meaningful is tagged', () => {
    expect(categorize({ amenity: 'bench' })).toBeUndefined();
    expect(categorize({ highway: 'bus_stop' })).toBeUndefined();
  });
});
