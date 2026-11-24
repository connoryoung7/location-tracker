import { describe, expect, test } from 'bun:test';

import { isDateKey, zonedDayRange } from '@/application/zoned-day.ts';

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

describe('zonedDayRange', () => {
  test('an ordinary day runs midnight to midnight in the zone', () => {
    const { from, to } = zonedDayRange('2026-11-22', 'America/New_York');

    expect(iso(from)).toBe('2026-11-22T05:00:00.000Z');
    expect(iso(to)).toBe('2026-11-23T05:00:00.000Z');
    expect(to - from).toBe(24 * 3600);
  });

  test('the day clocks spring forward is 23 hours long', () => {
    const { from, to } = zonedDayRange('2026-03-08', 'America/New_York');

    expect(iso(from)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(to)).toBe('2026-03-09T04:00:00.000Z');
    expect(to - from).toBe(23 * 3600);
  });

  test('the day clocks fall back is 25 hours long', () => {
    const { from, to } = zonedDayRange('2026-11-01', 'America/New_York');

    expect(iso(from)).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(to)).toBe('2026-11-02T05:00:00.000Z');
    expect(to - from).toBe(25 * 3600);
  });

  test('works for zones ahead of UTC and with half-hour offsets', () => {
    expect(iso(zonedDayRange('2026-11-22', 'Asia/Kolkata').from)).toBe('2026-11-21T18:30:00.000Z');
    expect(iso(zonedDayRange('2026-11-22', 'UTC').from)).toBe('2026-11-22T00:00:00.000Z');
  });

  test('rolls over month and year ends', () => {
    expect(iso(zonedDayRange('2026-12-31', 'UTC').to)).toBe('2027-01-01T00:00:00.000Z');
  });

  test('rejects anything that is not a real date', () => {
    expect(() => zonedDayRange('2026-02-30', 'UTC')).toThrow(RangeError);
    expect(() => zonedDayRange('today', 'UTC')).toThrow(RangeError);
  });
});

describe('isDateKey', () => {
  test.each([
    ['2026-11-22', true],
    ['2024-02-29', true],
    ['2026-02-29', false],
    ['2026-13-01', false],
    ['2026-1-01', false],
    ['', false],
  ])('%s is %p', (value, expected) => {
    expect(isDateKey(value)).toBe(expected);
  });
});
