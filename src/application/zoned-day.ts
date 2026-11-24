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

/**
 * The first instant (ms) of the given day in `timeZone`: when its wall clock
 * first reads 00:00. In a zone whose clocks jump forward at midnight (Havana,
 * on its daylight-saving day), 00:00 never happens and the day starts at the
 * jump; in one whose clocks fall back across midnight (Amman, 2021-10-29),
 * 00:00 happens twice and the day starts at the first.
 */
function zonedMidnight(year: number, month: number, day: number, timeZone: string): number {
  const wallClock = Date.UTC(year, month - 1, day);
  // Midnight there is the wall-clock reading less the zone's UTC offset. The
  // offset is read near the answer, then re-read at it, in case the zone's
  // offset changes in between (a daylight-saving change that night).
  const guess = wallClock - offsetAt(wallClock, timeZone);
  const midnight = wallClock - offsetAt(guess, timeZone);

  // Date.UTC normalises an overflowing day, so this is the day really meant.
  const dateKey = new Date(wallClock).toISOString().slice(0, 10);
  const isFirstSecond =
    localDateKey(midnight, timeZone) === dateKey &&
    localDateKey(midnight - 1000, timeZone) < dateKey;
  if (isFirstSecond) return midnight;

  // Midnight was skipped, or this is its second occurrence. Either way the day
  // starts at the first second whose local date is `dateKey`. Widen the window
  // until it straddles that second (a zone can skip a whole day, as Samoa did
  // on 2011-12-30), then find it by halving.
  const isOnOrAfter = (instant: number) => localDateKey(instant, timeZone) >= dateKey;
  let span = SEARCH_SPAN_MS;
  while (isOnOrAfter(midnight - span) && span < MAX_SEARCH_SPAN_MS) span *= 2;
  let before = midnight - span;
  span = SEARCH_SPAN_MS;
  while (!isOnOrAfter(midnight + span) && span < MAX_SEARCH_SPAN_MS) span *= 2;
  let after = midnight + span;
  while (after - before > 1000) {
    const middle = before + Math.floor((after - before) / 2000) * 1000;
    if (isOnOrAfter(middle)) after = middle;
    else before = middle;
  }
  return after;
}

/** Where the search for a day's first second starts: wider than any daylight-saving jump. */
const SEARCH_SPAN_MS = 6 * 3600 * 1000;
/** Far wider than any jump a zone has ever made, so a bad zone cannot loop forever. */
const MAX_SEARCH_SPAN_MS = 64 * 24 * 3600 * 1000;

/** The `YYYY-MM-DD` date the wall clock in `timeZone` shows at `instantMs`. */
function localDateKey(instantMs: number, timeZone: string): string {
  // `en-CA` formats dates as YYYY-MM-DD, which also sorts as a string.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instantMs);
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
