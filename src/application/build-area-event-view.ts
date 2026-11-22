import type { GeofenceEvent } from '@/domain/events.ts';

/** How an event is labelled in the list and the map popup. */
export type AreaEventKind = 'entered' | 'exited';

/** One row of the events list. Also the properties of that event's map point. */
export type AreaEventListRow = {
  kind: AreaEventKind;
  areaId: string;
  /** The area's name when the event recorded one, otherwise its ID. */
  areaLabel: string;
  lat: number;
  lon: number;
  /** Unix seconds, as OwnTracks reports them. */
  tst: number;
  /** ISO 8601 UTC, for `<time datetime>` and the map popup. */
  isoTime: string;
  /** Time of day in the view's time zone, e.g. `9:05 PM`. */
  timeLabel: string;
};

/** One calendar day of events, in the view's time zone. */
export type AreaEventDay = {
  /** `YYYY-MM-DD`, for `<time datetime>`. */
  dateKey: string;
  /** `Today`, `Yesterday`, or a short date such as `Thu, Nov 19`. */
  label: string;
  /** That day's events, newest first. */
  rows: AreaEventListRow[];
};

export type AreaEventFeature = {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: AreaEventListRow;
};

export type AreaEventFeatureCollection = {
  type: 'FeatureCollection';
  features: AreaEventFeature[];
};

export type AreaEventView = {
  /** The user the events belong to, so the map can tell when the selection changed. */
  userId: string;
  /** The IANA zone days and times were computed in. */
  timeZone: string;
  rows: AreaEventListRow[];
  /** The same rows grouped by day, newest day first. */
  days: AreaEventDay[];
  featureCollection: AreaEventFeatureCollection;
  /** `[west, south, east, north]` around every event, or undefined when there are none. */
  bounds?: [number, number, number, number];
};

export type AreaEventViewOptions = {
  /** IANA zone such as `America/New_York`. Unknown or missing zones fall back to UTC. */
  timeZone?: string;
  /** "Now", for deciding which day is Today. Defaults to the current time. */
  now?: Date;
};

/** Fixed so labels do not depend on the server's locale. */
const LOCALE = 'en-US';
const FALLBACK_TIME_ZONE = 'UTC';
const DAY_MS = 24 * 60 * 60 * 1000;

const KIND_BY_TYPE = {
  'area.entered': 'entered',
  'area.exited': 'exited',
} as const satisfies Record<GeofenceEvent['_type'], AreaEventKind>;

/** Returns the zone when the runtime recognises it, otherwise UTC. */
export function resolveTimeZone(timeZone: string | undefined): string {
  if (!timeZone) {
    return FALLBACK_TIME_ZONE;
  }

  try {
    return new Intl.DateTimeFormat(LOCALE, { timeZone }).resolvedOptions().timeZone;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

/**
 * Turns a user's stored area events into the list rows, day groups, and map
 * points the events panel renders. Keeps the incoming order, which the
 * repository returns newest first, so each day's events are already adjacent.
 */
export function buildAreaEventView(
  userId: string,
  events: GeofenceEvent[],
  options: AreaEventViewOptions = {},
): AreaEventView {
  const timeZone = resolveTimeZone(options.timeZone);
  // `en-CA` formats dates as YYYY-MM-DD, which doubles as a sortable day key.
  const dateKeyFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const timeFormat = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });

  const rows = events.map(
    (event): AreaEventListRow => ({
      kind: KIND_BY_TYPE[event._type],
      areaId: event.areaId,
      areaLabel: event.areaName ?? event.areaId,
      lat: event.lat,
      lon: event.lon,
      tst: event.tst,
      isoTime: new Date(event.tst * 1000).toISOString(),
      timeLabel: timeFormat.format(event.tst * 1000),
    }),
  );

  const todayKey = dateKeyFormat.format(options.now ?? new Date());
  const days: AreaEventDay[] = [];
  for (const row of rows) {
    const dateKey = dateKeyFormat.format(row.tst * 1000);
    const current = days.at(-1);
    if (current?.dateKey === dateKey) {
      current.rows.push(row);
    } else {
      days.push({ dateKey, label: labelForDay(dateKey, todayKey), rows: [row] });
    }
  }

  const features = rows.map(
    (row): AreaEventFeature => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
      properties: row,
    }),
  );

  return {
    userId,
    timeZone,
    rows,
    days,
    featureCollection: { type: 'FeatureCollection', features },
    bounds: boundsOf(rows),
  };
}

/** Noon UTC on a `YYYY-MM-DD` day, so formatting it in UTC can never slip a day. */
function dateKeyToUtcNoon(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!, 12));
}

/**
 * Works on day keys rather than subtracting 24 hours from "now", which would
 * land on the wrong day either side of a daylight-saving change.
 */
function labelForDay(dateKey: string, todayKey: string): string {
  if (dateKey === todayKey) {
    return 'Today';
  }

  const today = dateKeyToUtcNoon(todayKey);
  const yesterdayKey = new Date(today.getTime() - DAY_MS).toISOString().slice(0, 10);
  if (dateKey === yesterdayKey) {
    return 'Yesterday';
  }

  const date = dateKeyToUtcNoon(dateKey);
  return date.toLocaleDateString(LOCALE, {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    // The year only adds noise for dates in the current one.
    ...(date.getUTCFullYear() === today.getUTCFullYear() ? {} : { year: 'numeric' }),
  });
}

function boundsOf(rows: AreaEventListRow[]): [number, number, number, number] | undefined {
  if (rows.length === 0) {
    return undefined;
  }

  const lons = rows.map((row) => row.lon);
  const lats = rows.map((row) => row.lat);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}
