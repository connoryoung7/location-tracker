/**
 * Calendar days in a time zone, for views that show one of the viewer's days.
 * Works from the zone's own clock, so a day is 23 or 25 hours long on a
 * daylight-saving change instead of always 24.
 */

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `value` is a real calendar date written `YYYY-MM-DD`, e.g. `2026-11-22`. */
export function isDateKey(value: string): boolean {
  const match = DATE_KEY.exec(value);
  if (!match) return false;

  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 2026-02-30 over to March, so a round trip rejects it.
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * When a calendar day starts and ends in `timeZone`, as Unix epoch seconds:
 * `from` is that day's midnight and `to` the next day's, exclusive.
 *
 * `dateKey` must pass {@link isDateKey}, and `timeZone` must be valid (see
 * `resolveTimeZone`).
 */
export function zonedDayRange(dateKey: string, timeZone: string): { from: number; to: number } {
  if (!isDateKey(dateKey)) {
    throw new RangeError(`Not a YYYY-MM-DD date: ${dateKey}`);
  }

  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  return {
    from: zonedMidnight(year, month, day, timeZone) / 1000,
    // Date.UTC rolls day + 1 over into the next month or year.
    to: zonedMidnight(year, month, day + 1, timeZone) / 1000,
  };
}

/** The instant (ms) the wall clock in `timeZone` reads 00:00 on the given day. */
function zonedMidnight(year: number, month: number, day: number, timeZone: string): number {
  const wallClock = Date.UTC(year, month - 1, day);
  // Midnight there is the wall-clock reading less the zone's UTC offset. The
  // offset is read near the answer, then re-read at it, in case the zone's
  // offset changes in between (a daylight-saving change that night).
  const guess = wallClock - offsetAt(wallClock, timeZone);
  return wallClock - offsetAt(guess, timeZone);
}

/** How far ahead of UTC the wall clock in `timeZone` is at `instantMs` (ms). */
function offsetAt(instantMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(instantMs)
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;

  const wallClock = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wallClock - Math.floor(instantMs / 1000) * 1000;
}
