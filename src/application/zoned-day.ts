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
 * first reads 00:00.
 *
 * Midnight is the wall-clock reading less the zone's UTC offset, but which
 * offset? Every offset the zone uses within two days is tried, and the
 * midnights that really happen are kept. The earliest one wins, so where the
 * clocks fall back across midnight (Amman, 2021-10-29), or even roll back into
 * the day before (Casey, 2010-03-05), the day starts at the first 00:00. If no
 * midnight happens at all, the clocks jumped over it (Havana on its
 * daylight-saving day, or a whole skipped day, like Samoa's 2011-12-30), and
 * the day starts at the jump.
 */
function zonedMidnight(year: number, month: number, day: number, timeZone: string): number {
  const wallClock = Date.UTC(year, month - 1, day);

  const offsets = new Set<number>();
  for (let hours = -OFFSET_WINDOW_HOURS; hours <= OFFSET_WINDOW_HOURS; hours += 1) {
    offsets.add(offsetAt(wallClock + hours * HOUR_MS, timeZone));
  }
  const midnights = [...offsets]
    .map((offset) => wallClock - offset)
    .filter((instant) => offsetAt(instant, timeZone) === wallClock - instant);
  if (midnights.length > 0) return Math.min(...midnights);

  return firstSecondOf(wallClock, timeZone);
}

/**
 * The first second whose local date is the day at `wallClock`, for a day whose
 * midnight was jumped over. Across a forward jump the local date only moves
 * forward, so the window is widened until it straddles that second, then halved.
 */
function firstSecondOf(wallClock: number, timeZone: string): number {
  // Date.UTC normalises an overflowing day, so this is the day really meant.
  const dateKey = new Date(wallClock).toISOString().slice(0, 10);
  const isOnOrAfter = (instant: number) => localDateKey(instant, timeZone) >= dateKey;
  const near = wallClock - offsetAt(wallClock, timeZone);

  let span = SEARCH_SPAN_MS;
  while (isOnOrAfter(near - span) && span < MAX_SEARCH_SPAN_MS) span *= 2;
  let before = near - span;
  span = SEARCH_SPAN_MS;
  while (!isOnOrAfter(near + span) && span < MAX_SEARCH_SPAN_MS) span *= 2;
  let after = near + span;
  while (after - before > 1000) {
    const middle = before + Math.floor((after - before) / 2000) * 1000;
    if (isOnOrAfter(middle)) after = middle;
    else before = middle;
  }
  return after;
}

const HOUR_MS = 3600 * 1000;
/** How far either side of a day its zone's offsets are collected: two days covers any change. */
const OFFSET_WINDOW_HOURS = 48;
/** Where the search for a jumped-over midnight starts: wider than any daylight-saving jump. */
const SEARCH_SPAN_MS = 6 * HOUR_MS;
/** Far wider than any jump a zone has ever made, so a bad zone cannot loop forever. */
const MAX_SEARCH_SPAN_MS = 64 * 24 * HOUR_MS;

/** Formatters are costly to build, and a range needs a few hundred readings. */
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(locale: 'en-CA' | 'en-US', timeZone: string): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter =
      locale === 'en-CA'
        ? // `en-CA` formats dates as YYYY-MM-DD, which also sorts as a string.
          new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          })
        : new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
          });
    formatters.set(key, formatter);
  }
  return formatter;
}

/** The `YYYY-MM-DD` date the wall clock in `timeZone` shows at `instantMs`. */
function localDateKey(instantMs: number, timeZone: string): string {
  return formatterFor('en-CA', timeZone).format(instantMs);
}

/** How far ahead of UTC the wall clock in `timeZone` is at `instantMs` (ms). */
function offsetAt(instantMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    formatterFor('en-US', timeZone)
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
