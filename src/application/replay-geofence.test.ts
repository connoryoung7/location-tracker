import { expect, test } from 'bun:test';
import { ReplayGeofence, distanceMeters } from '@/application/replay-geofence.ts';
import type { Area, LocationPayload } from '@/domain/types.ts';

const area: Area = { id: 'home', userId: 'u', name: 'Home', lat: 0, lon: 0, radius: 100 };
const point = (tst: number, lon = 0): LocationPayload => ({
  _type: 'location',
  tid: 'u',
  lat: 0,
  lon,
  tst,
});
test('exit requires a second outside fix at the threshold; returning cancels pending exit', () => {
  const replay = new ReplayGeofence([area], 30);
  expect(replay.evaluate(point(0))[0]?._type).toBe('area.entered');
  expect(replay.evaluate(point(10, 1))).toEqual([]);
  expect(replay.evaluate(point(39, 1))).toEqual([]);
  expect(replay.evaluate(point(40, 1))[0]?._type).toBe('area.exited');
  expect(replay.evaluate(point(50))[0]?._type).toBe('area.entered');
  replay.evaluate(point(60, 1));
  replay.evaluate(point(70));
  expect(replay.pendingExit.size).toBe(0);
  expect(replay.evaluate(point(100, 1))).toEqual([]);
});
test('boundary is inclusive and zero threshold still needs two outside fixes', () => {
  const boundary = { ...area, radius: distanceMeters(area, 0, 0.001) };
  const replay = new ReplayGeofence([boundary], 0);
  expect(replay.evaluate(point(1, 0.001))).toHaveLength(1);
  expect(replay.evaluate(point(2, 1))).toEqual([]);
  expect(replay.evaluate(point(2, 1))[0]?._type).toBe('area.exited');
});
