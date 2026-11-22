import { describe, expect, test } from 'bun:test';

import { detectVisits, type VisitFix } from '@/application/detect-visits.ts';
import type { Visit } from '@/domain/types.ts';
import {
  drivingCoordinates,
  stationaryCoordinates,
  walkingCoordinates,
} from '@/test/coordinates.ts';

const BASE = { lat: 42.3601, lon: -71.0589 };
const METERS_PER_DEGREE_LAT = 111_320;

/** A fix `north` and `east` meters from BASE at `tst`. */
function fixAt(north: number, east: number, tst: number, acc?: number): VisitFix {
  const lat = BASE.lat + north / METERS_PER_DEGREE_LAT;
  const lon = BASE.lon + east / (METERS_PER_DEGREE_LAT * Math.cos((BASE.lat * Math.PI) / 180));
  return acc === undefined ? { lat, lon, tst } : { lat, lon, tst, acc };
}

/** Fixes every `step` seconds from `from` to `to` (inclusive) at one spot. */
function dwell(north: number, east: number, from: number, to: number, step = 60): VisitFix[] {
  const fixes: VisitFix[] = [];
  for (let tst = from; tst <= to; tst += step) fixes.push(fixAt(north, east, tst));
  return fixes;
}

async function collect(
  fixes: VisitFix[],
  options?: Parameters<typeof detectVisits>[1],
): Promise<Visit[]> {
  const visits: Visit[] = [];
  for await (const visit of detectVisits(fixes, options)) visits.push(visit);
  return visits;
}

describe('detectVisits', () => {
  test('a user sitting still for half an hour is one visit', async () => {
    const visits = await collect(stationaryCoordinates);

    expect(visits).toHaveLength(1);
    const [visit] = visits;
    expect(visit!.arrivedAt).toBe(stationaryCoordinates[0]!.tst);
    expect(visit!.departedAt).toBe(stationaryCoordinates.at(-1)!.tst);
    expect(visit!.locationCount).toBe(stationaryCoordinates.length);
    expect(visit!.lat).toBeCloseTo(42.3636, 3);
    expect(visit!.lon).toBeCloseTo(-71.0544, 3);
  });

  test('walking and driving routes are not visits', async () => {
    expect(await collect(walkingCoordinates)).toEqual([]);
    expect(await collect(drivingCoordinates)).toEqual([]);
  });

  test('a stop shorter than the minimum duration is not a visit', async () => {
    const fixes = [...dwell(0, 0, 0, 240), fixAt(2_000, 0, 300), fixAt(4_000, 0, 360)];

    expect(await collect(fixes)).toEqual([]);
  });

  test('finds each stop on a trip, in order', async () => {
    const fixes = [
      ...dwell(0, 0, 0, 1_200),
      // Drive 3 km away, one fix a minute.
      fixAt(0, 1_000, 1_320),
      fixAt(0, 2_000, 1_380),
      ...dwell(0, 3_000, 1_440, 3_240),
      fixAt(0, 2_000, 3_300),
      fixAt(0, 1_000, 3_360),
    ];

    const visits = await collect(fixes);

    expect(visits.map((visit) => [visit.arrivedAt, visit.locationCount])).toEqual([
      [0, 21],
      [1_440, 31],
    ]);
    // Left in time to cover 1 km at 5 m/s before the next fix, and not before last seen.
    expect(visits[0]!.departedAt).toBe(1_200);
    expect(visits[1]!.departedAt).toBe(3_240);
  });

  test('a single stray fix does not split a visit', async () => {
    const fixes = [
      ...dwell(0, 0, 0, 600),
      fixAt(800, 0, 660),
      ...dwell(0, 0, 720, 1_200),
      fixAt(3_000, 0, 1_260),
      fixAt(6_000, 0, 1_320),
    ];

    const visits = await collect(fixes);

    expect(visits).toHaveLength(1);
    expect(visits[0]!.arrivedAt).toBe(0);
    expect(visits[0]!.departedAt).toBe(1_200);
    // The stray fix is not part of the visit.
    expect(visits[0]!.locationCount).toBe(20);
  });

  test('ignores fixes less accurate than the limit', async () => {
    const fixes = [
      ...dwell(0, 0, 0, 600),
      fixAt(1_500, 0, 660, 900),
      fixAt(1_500, 0, 720, 900),
      ...dwell(0, 0, 780, 1_200),
    ];

    const visits = await collect(fixes);

    expect(visits).toHaveLength(1);
    expect(visits[0]!.departedAt).toBe(1_200);
  });

  test('a quiet phone still counts as being there', async () => {
    // One fix on arrival, nothing for 40 minutes, then a fix 600 m away.
    const fixes = [fixAt(0, 0, 0), fixAt(600, 0, 2_400), fixAt(1_200, 0, 2_460)];

    const visits = await collect(fixes);

    expect(visits).toHaveLength(1);
    // 600 m at 5 m/s is two minutes of travel before the 2 400 s fix.
    expect(visits[0]!.arrivedAt).toBe(0);
    expect(visits[0]!.departedAt).toBe(2_280);
    expect(visits[0]!.locationCount).toBe(1);
  });

  test('never departs before the user was last seen', async () => {
    const fixes = [...dwell(0, 0, 0, 600), fixAt(0, 50_000, 900), fixAt(0, 60_000, 1_200)];

    const visits = await collect(fixes);

    expect(visits[0]!.departedAt).toBe(600);
  });

  test('a visit still in progress ends at the last fix', async () => {
    const visits = await collect(dwell(0, 0, 0, 900));

    expect(visits).toHaveLength(1);
    expect(visits[0]!.departedAt).toBe(900);
  });

  test('accepts tighter thresholds', async () => {
    const fixes = [...dwell(0, 0, 0, 240), fixAt(2_000, 0, 300), fixAt(4_000, 0, 360)];

    const visits = await collect(fixes, { minDurationSeconds: 120 });

    expect(visits).toHaveLength(1);
  });

  test('reads an async stream', async () => {
    async function* stream() {
      yield* dwell(0, 0, 0, 900);
    }

    const visits: Visit[] = [];
    for await (const visit of detectVisits(stream())) visits.push(visit);

    expect(visits).toHaveLength(1);
  });
});
