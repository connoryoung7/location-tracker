import { test, expect, describe } from 'bun:test';
import { buildAreaMapView, type AreaMapView } from '@/application/build-area-map-view.ts';
import { buildArea, buildAreaCategory } from '@/test/factories.ts';

const EARTH_RADIUS_METERS = 6_371_008.8;

/** Great-circle distance in meters, used to assert ring vertices sit on the circle. */
function haversineMeters([lonA, latA]: [number, number], [lonB, latB]: [number, number]): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(latB - latA);
  const deltaLon = toRadians(lonB - lonA);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(latA)) * Math.cos(toRadians(latB)) * Math.sin(deltaLon / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

describe('buildAreaMapView', () => {
  test('empty input yields no features and no bounds', () => {
    const view = buildAreaMapView([]);

    expect(view.featureCollection).toEqual({ type: 'FeatureCollection', features: [] });
    expect(view.bounds).toBeUndefined();
  });

  test('an area becomes a closed ring whose vertices sit at the requested radius', () => {
    const area = buildArea({ lat: 42.3601, lon: -71.0589, radius: 500 });

    const [feature] = buildAreaMapView([area]).featureCollection.features;
    const ring = feature!.geometry.coordinates[0]!;

    expect(ring[0]).toEqual(ring[ring.length - 1]!);
    expect(ring.length).toBeGreaterThan(16);

    for (const vertex of ring) {
      const distance = haversineMeters([area.lon, area.lat], vertex);
      // The ring is a flat-earth approximation, so allow a small tolerance.
      expect(Math.abs(distance - area.radius)).toBeLessThan(area.radius * 0.01);
    }
  });

  test('longitude span widens with latitude for an equal radius', () => {
    const radius = 1000;
    const spanAt = (lat: number) => {
      const view = buildAreaMapView([buildArea({ lat, lon: 0, radius })]);
      const ring = view.featureCollection.features[0]!.geometry.coordinates[0]!;
      const longitudes = ring.map(([lon]) => lon);
      return Math.max(...longitudes) - Math.min(...longitudes);
    };

    expect(spanAt(60)).toBeGreaterThan(spanAt(0) * 1.5);
  });

  test("each circle takes its category's colour key and name", () => {
    const gym = buildAreaCategory({ id: 'gym', name: 'Gym', color: 'orange' });
    const view = buildAreaMapView(
      [buildArea({ id: 'a1', name: 'Climbing wall', categoryId: 'gym' })],
      [gym],
    );

    expect(view.featureCollection.features[0]!.properties).toMatchObject({
      areaId: 'a1',
      userId: 'AB',
      name: 'Climbing wall',
      colorKey: 'orange',
      categoryName: 'Gym',
    });
  });

  test('uncategorised circles are neutral, including ones whose category is unknown', () => {
    const view = buildAreaMapView([
      buildArea({ id: 'a1' }),
      // E.g. a category deleted between reading the areas and the categories.
      buildArea({ id: 'a2', categoryId: 'deleted' }),
    ]);

    for (const feature of view.featureCollection.features) {
      expect(feature.properties).toMatchObject({ colorKey: 'none', categoryName: '' });
    }
  });

  test('recolouring a category recolours every circle in it', () => {
    const areas = [
      buildArea({ id: 'a1', categoryId: 'gym' }),
      buildArea({ id: 'a2', categoryId: 'gym' }),
    ];
    const keys = (view: AreaMapView) =>
      view.featureCollection.features.map((feature) => feature.properties.colorKey);

    expect(
      keys(buildAreaMapView(areas, [buildAreaCategory({ id: 'gym', color: 'blue' })])),
    ).toEqual(['blue', 'blue']);
    expect(
      keys(buildAreaMapView(areas, [buildAreaCategory({ id: 'gym', color: 'aqua' })])),
    ).toEqual(['aqua', 'aqua']);
  });

  test('features carry their centre and radius, so the map popup can open one for editing', () => {
    const view = buildAreaMapView([buildArea({ lat: 42.3601, lon: -71.0589, radius: 120 })]);

    expect(view.featureCollection.features[0]!.properties).toMatchObject({
      lat: 42.3601,
      lon: -71.0589,
      radius: 120,
    });
  });

  test('bounds enclose each full circle, not just the center points', () => {
    const area = buildArea({ lat: 42.3601, lon: -71.0589, radius: 1000 });

    const [west, south, east, north] = buildAreaMapView([area]).bounds!;

    expect(west).toBeLessThan(area.lon);
    expect(east).toBeGreaterThan(area.lon);
    expect(south).toBeLessThan(area.lat);
    expect(north).toBeGreaterThan(area.lat);

    // The northern edge must clear the center by roughly the full radius.
    expect(haversineMeters([area.lon, area.lat], [area.lon, north])).toBeGreaterThan(
      area.radius * 0.99,
    );
  });
});
