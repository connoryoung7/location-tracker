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

  test('a day whose midnight is skipped starts at the jump, and is 23 hours long', () => {
    // Havana springs forward at 00:00: the clock goes from 23:59:59 to 01:00.
    const { from, to } = zonedDayRange('2026-03-08', 'America/Havana');

    expect(iso(from)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(to)).toBe('2026-03-09T04:00:00.000Z');
    expect(to - from).toBe(23 * 3600);
    // The day before ends where this one starts, so no hour is in both.
    expect(zonedDayRange('2026-03-07', 'America/Havana').to).toBe(from);
  });

  test('a day whose midnight happens twice starts at the first, and is 25 hours long', () => {
    // Amman fell back from 01:00 to 00:00 on 2021-10-29, so 00:00 came round twice.
    const { from, to } = zonedDayRange('2021-10-29', 'Asia/Amman');

    expect(iso(from)).toBe('2021-10-28T21:00:00.000Z');
    expect(iso(to)).toBe('2021-10-29T22:00:00.000Z');
    expect(to - from).toBe(25 * 3600);
    expect(zonedDayRange('2021-10-28', 'Asia/Amman').to).toBe(from);
  });

  test('a zone that skips a whole day keeps the days around it whole', () => {
    // Samoa crossed the date line: 2011-12-29 ended, and 2011-12-31 began.
    const before = zonedDayRange('2011-12-29', 'Pacific/Apia');
    const skipped = zonedDayRange('2011-12-30', 'Pacific/Apia');
    const after = zonedDayRange('2011-12-31', 'Pacific/Apia');

    expect(iso(before.from)).toBe('2011-12-29T10:00:00.000Z');
    expect(iso(before.to)).toBe('2011-12-30T10:00:00.000Z');
    // A date that never happened there is empty, not a stray slice of its neighbours.
    expect(skipped.to - skipped.from).toBe(0);
    expect(after.from).toBe(before.to);
    expect(after.to - after.from).toBe(24 * 3600);
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
