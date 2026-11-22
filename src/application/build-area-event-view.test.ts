import { describe, expect, test } from 'bun:test';
import { buildAreaEventView, resolveTimeZone } from '@/application/build-area-event-view.ts';
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
      timeLabel: '10:13 PM',
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

  describe('grouping by day', () => {
    /** Unix seconds for an ISO instant. */
    const at = (iso: string) => Date.parse(iso) / 1000;
    const eventAt = (iso: string): GeofenceEvent => ({ ...entered, tst: at(iso) });
    const now = new Date('2026-11-21T18:00:00Z');

    test('groups newest-first events into one section per day, in order', () => {
      const view = buildAreaEventView(
        'u',
        [
          eventAt('2026-11-21T15:00:00Z'),
          eventAt('2026-11-21T09:00:00Z'),
          eventAt('2026-11-20T12:00:00Z'),
          eventAt('2026-11-17T12:00:00Z'),
          eventAt('2026-11-17T08:00:00Z'),
        ],
        { timeZone: 'UTC', now },
      );

      expect(view.days.map((day) => [day.dateKey, day.label, day.rows.length])).toEqual([
        ['2026-11-21', 'Today', 2],
        ['2026-11-20', 'Yesterday', 1],
        ['2026-11-17', 'Tue, Nov 17', 2],
      ]);
      // Grouping is for the list only; the map still gets every event.
      expect(view.rows).toHaveLength(5);
      expect(view.featureCollection.features).toHaveLength(5);
    });

    test('decides the day in the given time zone, not UTC', () => {
      // 03:00 UTC on the 21st is still the evening of the 20th in New York.
      const view = buildAreaEventView('u', [eventAt('2026-11-21T03:00:00Z')], {
        timeZone: 'America/New_York',
        now,
      });

      expect(view.timeZone).toBe('America/New_York');
      expect(view.days[0]!.dateKey).toBe('2026-11-20');
      expect(view.days[0]!.label).toBe('Yesterday');
      expect(view.rows[0]!.timeLabel).toBe('10:00 PM');
    });

    test('counts Yesterday by calendar day across a daylight-saving change', () => {
      // US clocks went back on 2026-11-01, so that day was 25 hours long.
      const view = buildAreaEventView('u', [eventAt('2026-11-01T23:30:00Z')], {
        timeZone: 'America/New_York',
        now: new Date('2026-11-02T05:30:00Z'), // 00:30 on Nov 2 in New York
      });

      expect(view.days[0]!.label).toBe('Yesterday');
    });

    test('adds the year only for days outside the current one', () => {
      const view = buildAreaEventView('u', [eventAt('2025-12-31T12:00:00Z')], {
        timeZone: 'UTC',
        now,
      });

      expect(view.days[0]!.label).toBe('Wed, Dec 31, 2025');
    });

    test('has no days when there are no events', () => {
      expect(buildAreaEventView('u', [], { now }).days).toEqual([]);
    });
  });
});

describe('resolveTimeZone', () => {
  test('keeps a zone the runtime knows', () => {
    expect(resolveTimeZone('Europe/London')).toBe('Europe/London');
  });

  test('falls back to UTC for a missing or unknown zone', () => {
    expect(resolveTimeZone(undefined)).toBe('UTC');
    expect(resolveTimeZone('')).toBe('UTC');
    expect(resolveTimeZone('Not/AZone')).toBe('UTC');
  });
});
