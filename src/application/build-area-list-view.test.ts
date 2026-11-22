import { describe, expect, test } from 'bun:test';
import { buildAreaListView } from '@/application/build-area-list-view.ts';
import { buildAreaMapView } from '@/application/build-area-map-view.ts';
import { buildArea } from '@/test/factories.ts';

describe('buildAreaListView', () => {
  test('groups rows by user, then orders them by name', () => {
    const view = buildAreaListView([
      buildArea({ id: '1', userId: 'CD', name: 'Work' }),
      buildArea({ id: '2', userId: 'AB', name: 'School' }),
      buildArea({ id: '3', userId: 'AB', name: 'Gym' }),
    ]);

    expect(view.rows.map((row) => `${row.userId}/${row.name}`)).toEqual([
      'AB/Gym',
      'AB/School',
      'CD/Work',
    ]);
  });

  test('uses the same user color as the circles on the map', () => {
    const areas = [buildArea({ userId: 'AB' }), buildArea({ id: 'other', userId: 'CD' })];

    const mapColors = Object.fromEntries(
      buildAreaMapView(areas).featureCollection.features.map((feature) => [
        feature.properties.userId,
        feature.properties.color,
      ]),
    );

    for (const row of buildAreaListView(areas).rows) {
      expect(row.color).toBe(mapColors[row.userId]!);
    }
  });

  test('bounds enclose the whole circle around its center', () => {
    const [row] = buildAreaListView([buildArea({ lat: 42.36, lon: -71.06, radius: 250 })]).rows;
    const [west, south, east, north] = row!.bounds;

    expect(west).toBeLessThan(-71.06);
    expect(east).toBeGreaterThan(-71.06);
    expect(south).toBeLessThan(42.36);
    expect(north).toBeGreaterThan(42.36);
    // 250m is about 0.00225 degrees of latitude.
    expect(north - 42.36).toBeCloseTo(0.00225, 4);
  });

  test('is empty when there are no areas', () => {
    expect(buildAreaListView([]).rows).toEqual([]);
  });
});
