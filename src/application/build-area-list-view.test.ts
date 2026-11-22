import { describe, expect, test } from 'bun:test';
import { buildAreaListView } from '@/application/build-area-list-view.ts';
import { buildAreaMapView } from '@/application/build-area-map-view.ts';
import { pickAreaCategoryColor } from '@/application/pick-area-category-color.ts';
import { buildArea, buildAreaCategory } from '@/test/factories.ts';

const gym = buildAreaCategory({ id: 'gym', name: 'Gym', color: 'orange' });
const work = buildAreaCategory({ id: 'work', name: 'Work', color: 'blue' });

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

  test("each row carries its category, and the same colour key as the area's circle", () => {
    const areas = [
      buildArea({ id: 'a1', name: 'Climbing wall', categoryId: 'gym' }),
      buildArea({ id: 'a2', name: 'Park' }),
    ];

    const mapKeys = Object.fromEntries(
      buildAreaMapView(areas, [gym]).featureCollection.features.map((feature) => [
        feature.properties.areaId,
        feature.properties.colorKey,
      ]),
    );
    const rows = buildAreaListView(areas, [gym]).rows;

    expect(rows.map((row) => [row.name, row.categoryId, row.categoryName, row.colorKey])).toEqual([
      ['Climbing wall', 'gym', 'Gym', 'orange'],
      ['Park', null, null, 'none'],
    ]);
    for (const row of rows) expect(row.colorKey).toBe(mapKeys[row.areaId]!);
  });

  test('groups areas under their categories in the order given, uncategorised last', () => {
    const view = buildAreaListView(
      [
        buildArea({ id: 'a1', name: 'Park' }),
        buildArea({ id: 'a2', name: 'Office', categoryId: 'work' }),
        buildArea({ id: 'a3', name: 'Pool', categoryId: 'gym' }),
        buildArea({ id: 'a4', name: 'Climbing wall', categoryId: 'gym' }),
      ],
      [gym, work],
    );

    expect(
      view.groups.map((group) => [group.category?.name ?? null, group.rows.map((row) => row.name)]),
    ).toEqual([
      ['Gym', ['Climbing wall', 'Pool']],
      ['Work', ['Office']],
      [null, ['Park']],
    ]);
  });

  test('leaves out categories with no areas, and the uncategorised group when it is empty', () => {
    const view = buildAreaListView([buildArea({ id: 'a1', categoryId: 'work' })], [gym, work]);

    expect(view.groups.map((group) => group.category?.id ?? null)).toEqual(['work']);
  });

  test('lists every category with how many areas it holds, empty ones included', () => {
    const view = buildAreaListView(
      [buildArea({ id: 'a1', categoryId: 'work' }), buildArea({ id: 'a2', categoryId: 'work' })],
      [gym, work],
    );

    expect(view.categories.map((category) => [category.name, category.areaCount])).toEqual([
      ['Gym', 0],
      ['Work', 2],
    ]);
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
    const view = buildAreaListView([]);
    expect(view.rows).toEqual([]);
    expect(view.groups).toEqual([]);
  });
});

describe('pickAreaCategoryColor', () => {
  const withColors = (...colors: ('blue' | 'orange' | 'aqua')[]) =>
    colors.map((color, index) => buildAreaCategory({ id: `c${index}`, color }));

  test('the first three categories get three different colours, in palette order', () => {
    expect(pickAreaCategoryColor([])).toBe('blue');
    expect(pickAreaCategoryColor(withColors('blue'))).toBe('orange');
    expect(pickAreaCategoryColor(withColors('blue', 'orange'))).toBe('aqua');
  });

  test('after that, colours repeat as evenly as they can', () => {
    expect(pickAreaCategoryColor(withColors('blue', 'orange', 'aqua'))).toBe('blue');
    expect(pickAreaCategoryColor(withColors('blue', 'orange', 'aqua', 'blue'))).toBe('orange');
  });

  test('a colour freed by a recolour or delete is used next', () => {
    // The user recoloured their second category from orange to blue.
    expect(pickAreaCategoryColor(withColors('blue', 'blue', 'aqua'))).toBe('orange');
  });
});
