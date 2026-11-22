import { describe, expect, test } from 'bun:test';
import { buildAreaEventView } from '@/application/build-area-event-view.ts';
import type { GeofenceEvent } from '@/domain/events.ts';

const entered: GeofenceEvent = {
  _type: 'area.entered',
  userId: 'u',
  areaId: 'home-id',
  areaName: 'Home',
  lat: 42.36,
  lon: -71.06,
  tst: 1_700_000_000,
};

describe('buildAreaEventView', () => {
  test('maps events to list rows and points, keeping the newest-first order', () => {
    const exited: GeofenceEvent = { ...entered, _type: 'area.exited', tst: 1_700_000_600 };

    const view = buildAreaEventView('u', [exited, entered]);

    expect(view.userId).toBe('u');
    expect(view.rows.map((row) => row.kind)).toEqual(['exited', 'entered']);
    expect(view.rows[1]).toEqual({
      kind: 'entered',
      areaId: 'home-id',
      areaLabel: 'Home',
      lat: 42.36,
      lon: -71.06,
      tst: 1_700_000_000,
      isoTime: '2023-11-14T22:13:20.000Z',
    });
  });

  test('puts each point at [lon, lat], as GeoJSON requires', () => {
    const view = buildAreaEventView('u', [entered]);

    expect(view.featureCollection.features[0]!.geometry).toEqual({
      type: 'Point',
      coordinates: [-71.06, 42.36],
    });
    expect(view.featureCollection.features[0]!.properties).toEqual(view.rows[0]!);
  });

  test('labels an event with its area ID when no name was recorded', () => {
    const { areaName: _areaName, ...unnamed } = entered;

    expect(buildAreaEventView('u', [unnamed]).rows[0]!.areaLabel).toBe('home-id');
  });

  test('bounds enclose every event', () => {
    const view = buildAreaEventView('u', [entered, { ...entered, lat: 40, lon: -70 }]);

    expect(view.bounds).toEqual([-71.06, 40, -70, 42.36]);
  });

  test('has no bounds when there are no events', () => {
    const view = buildAreaEventView('u', []);

    expect(view.rows).toEqual([]);
    expect(view.featureCollection.features).toEqual([]);
    expect(view.bounds).toBeUndefined();
  });
});
