import { describe, expect, test } from 'bun:test';

import type { DayTimeline, TimelineStop, TimelineTrip } from '@/application/build-day-timeline.ts';
import { buildDayTimelineView, formatDistance } from '@/application/build-day-timeline-view.ts';
import { zonedDayRange } from '@/application/zoned-day.ts';

const DATE = '2026-11-22';
const TIME_ZONE = 'America/New_York';
const DAY = zonedDayRange(DATE, TIME_ZONE);
const HOUR = 3600;

const HOME = { lat: 42.3467, lon: -71.0972 };
const MARKET = { lat: 42.3603, lon: -71.0554 };

function stop(overrides: Partial<TimelineStop> = {}): TimelineStop {
  return {
    kind: 'stop',
    label: 'Home',
    category: 'Saved area',
    isFromOpenStreetMap: false,
    ...HOME,
    arrivedAt: DAY.from + 8 * HOUR,
    departedAt: DAY.from + 9 * HOUR,
    ...overrides,
  };
}

function trip(overrides: Partial<TimelineTrip> = {}): TimelineTrip {
  const startedAt = DAY.from + 9 * HOUR;
  return {
    kind: 'trip',
    startedAt,
    endedAt: startedAt + 23 * 60,
    path: [
      { ...HOME, tst: startedAt },
      { lat: 42.3525, lon: -71.0825, tst: startedAt + 600 },
      { ...MARKET, tst: startedAt + 23 * 60 },
    ],
    distanceMeters: 3_240,
    isPathEstimated: false,
    isOngoing: false,
    fromLabel: 'Home',
    toLabel: 'Fresh Market',
    ...overrides,
  };
}

function timeline(entries: DayTimeline['entries']): DayTimeline {
  return { userId: 'AB', date: DATE, timeZone: TIME_ZONE, day: DAY, entries };
}

describe('buildDayTimelineView', () => {
  test('lists stops and trips with times in the time zone, durations and distances', () => {
    const view = buildDayTimelineView(
      timeline([
        stop(),
        trip(),
        stop({
          label: 'Fresh Market',
          category: 'Grocery store',
          isFromOpenStreetMap: true,
          ...MARKET,
          arrivedAt: DAY.from + 9 * HOUR + 23 * 60,
          departedAt: DAY.from + 10 * HOUR + 33 * 60,
        }),
      ]),
    );

    expect(view.dayLabel).toBe('Sunday, November 22, 2026');
    expect(
      view.rows.map(({ entryId, kind, label, timeLabel, detail }) => ({
        entryId,
        kind,
        label,
        timeLabel,
        detail,
      })),
    ).toEqual([
      {
        entryId: 'entry-1',
        kind: 'stop',
        label: 'Home',
        timeLabel: '8:00 AM – 9:00 AM',
        detail: 'Saved area · 1h',
      },
      {
        entryId: 'entry-2',
        kind: 'trip',
        label: 'Home → Fresh Market',
        timeLabel: '9:00 AM – 9:23 AM',
        detail: '23 min · 3.2 km',
      },
      {
        entryId: 'entry-3',
        kind: 'stop',
        label: 'Fresh Market',
        timeLabel: '9:23 AM – 10:33 AM',
        detail: 'Grocery store · 1h 10m',
      },
    ]);
    expect(view.usesOpenStreetMap).toBe(true);
  });

  test('clips stops at either end of the day, saying they carry on', () => {
    const view = buildDayTimelineView(
      timeline([
        stop({ arrivedAt: DAY.from - 6 * HOUR, departedAt: DAY.from + 7 * HOUR + 42 * 60 }),
        stop({ arrivedAt: DAY.from + 22 * HOUR, departedAt: DAY.to + 8 * HOUR }),
      ]),
    );

    expect(view.rows[0]).toMatchObject({
      timeLabel: 'Until 7:42 AM',
      detail: 'Saved area · 7h 42m',
      startsAt: DAY.from,
    });
    expect(view.rows[1]).toMatchObject({ timeLabel: 'From 10:00 PM', endsAt: DAY.to });
    expect(
      buildDayTimelineView(
        timeline([stop({ arrivedAt: DAY.from - HOUR, departedAt: DAY.to + HOUR })]),
      ).rows[0]!.timeLabel,
    ).toBe('All day');
  });

  test('labels trips that start or end mid-journey, and estimated or ongoing ones', () => {
    const view = buildDayTimelineView(
      timeline([
        trip({ fromLabel: undefined, isPathEstimated: true, distanceMeters: 650 }),
        trip({ toLabel: undefined, isOngoing: true }),
        trip({ fromLabel: undefined, toLabel: undefined }),
      ]),
    );

    expect(view.rows.map((row) => [row.label, row.detail])).toEqual([
      ['To Fresh Market', '23 min · about 650 m'],
      ['From Home', '23 min · 3.2 km · no stop yet'],
      ['On the move', '23 min · 3.2 km'],
    ]);
    expect(view.rows[0]!.isPathEstimated).toBe(true);
  });

  test('draws stops as points and trips as lines, framed together', () => {
    const view = buildDayTimelineView(timeline([stop(), trip({ isPathEstimated: true })]));

    expect(view.featureCollection.features).toEqual([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [HOME.lon, HOME.lat] },
        properties: { entryId: 'entry-1', kind: 'stop', isPathEstimated: false },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [HOME.lon, HOME.lat],
            [-71.0825, 42.3525],
            [MARKET.lon, MARKET.lat],
          ],
        },
        properties: { entryId: 'entry-2', kind: 'trip', isPathEstimated: true },
      },
    ]);
    expect(view.bounds).toEqual([HOME.lon, HOME.lat, MARKET.lon, MARKET.lat]);
    expect(view.rows[1]!.bounds).toEqual([HOME.lon, HOME.lat, MARKET.lon, MARKET.lat]);
  });

  test('plays back from the day only: a stop holds still, a trip follows its route', () => {
    const view = buildDayTimelineView(
      timeline([stop({ arrivedAt: DAY.from - 6 * HOUR, departedAt: DAY.from + 9 * HOUR }), trip()]),
    );

    expect(view.track).toEqual([
      [HOME.lon, HOME.lat, DAY.from],
      [HOME.lon, HOME.lat, DAY.from + 9 * HOUR],
      [HOME.lon, HOME.lat, DAY.from + 9 * HOUR],
      [-71.0825, 42.3525, DAY.from + 9 * HOUR + 600],
      [MARKET.lon, MARKET.lat, DAY.from + 9 * HOUR + 23 * 60],
    ]);
  });

  test('an empty day has no rows, features or bounds', () => {
    const view = buildDayTimelineView(timeline([]));

    expect(view.rows).toEqual([]);
    expect(view.featureCollection.features).toEqual([]);
    expect(view.bounds).toBeUndefined();
    expect(view.usesOpenStreetMap).toBe(false);
  });
});

describe('formatDistance', () => {
  test.each([
    [12.4, '12 m'],
    [650, '650 m'],
    [3_240, '3.2 km'],
    [14_600, '15 km'],
  ])('%d m is %s', (meters, label) => {
    expect(formatDistance(meters)).toBe(label);
  });
});
