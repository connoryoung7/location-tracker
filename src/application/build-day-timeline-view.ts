import type { DayTimeline, TimelineEntry, TimelineTrip } from '@/application/build-day-timeline.ts';
import { formatDuration } from '@/application/build-visited-place-view.ts';

const LOCALE = 'en-US';

type Bounds = [number, number, number, number];
type Position = [number, number];

/** One row of the timeline list. Also what the playback reads to caption a moment. */
export type TimelineRow = {
  /** Stable within one view; ties a list row to its map feature. */
  entryId: string;
  kind: 'stop' | 'trip';
  /** A stop's place, or a trip's `From → To`. */
  label: string;
  /** e.g. `Grocery store · 1h 10m`, or `23 min · 3.2 km`. */
  detail: string;
  /** e.g. `7:42 AM – 9:10 AM`, `Until 7:42 AM`, or `All day`, in the view's time zone. */
  timeLabel: string;
  /** The part of the entry within the day, as Unix epoch seconds. */
  startsAt: number;
  endsAt: number;
  /** Trips only: drawn dashed when no fixes were reported on the way. */
  isPathEstimated: boolean;
  /** `[west, south, east, north]` to frame the entry on the map. */
  bounds: Bounds;
};

export type TimelineFeature = {
  type: 'Feature';
  geometry:
    | { type: 'LineString'; coordinates: Position[] }
    | { type: 'Point'; coordinates: Position };
  properties: { entryId: string; kind: 'stop' | 'trip'; isPathEstimated: boolean };
};

export type DayTimelineView = {
  userId: string;
  date: string;
  /** e.g. `Sunday, November 22, 2026`. */
  dayLabel: string;
  day: { from: number; to: number };
  rows: TimelineRow[];
  featureCollection: { type: 'FeatureCollection'; features: TimelineFeature[] };
  /** Around every stop and route, or undefined when the day is empty. */
  bounds?: Bounds;
  /** `[lon, lat, tst]`, oldest first, for playing the day back on the map. */
  track: [number, number, number][];
  /** Whether any place name came from OpenStreetMap, which must then be credited. */
  usesOpenStreetMap: boolean;
};

/** Turns a day timeline into the list rows, map features and playback track the panel renders. */
export function buildDayTimelineView(timeline: DayTimeline): DayTimelineView {
  const { day } = timeline;
  const time = new Intl.DateTimeFormat(LOCALE, {
    timeZone: timeline.timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
  const at = (seconds: number) => time.format(seconds * 1000);

  const rows = timeline.entries.map((entry, index): TimelineRow => {
    const entryId = `entry-${index + 1}`;
    if (entry.kind === 'stop') {
      const startsAt = Math.max(entry.arrivedAt, day.from);
      const endsAt = Math.min(entry.departedAt, day.to);
      const isFromBefore = entry.arrivedAt < day.from;
      const isIntoNext = entry.departedAt > day.to;
      return {
        entryId,
        kind: 'stop',
        label: entry.label,
        detail: [entry.category, formatDuration(endsAt - startsAt)].filter(Boolean).join(' · '),
        timeLabel:
          isFromBefore && isIntoNext
            ? 'All day'
            : isFromBefore
              ? `Until ${at(entry.departedAt)}`
              : isIntoNext
                ? `From ${at(entry.arrivedAt)}`
                : `${at(entry.arrivedAt)} – ${at(entry.departedAt)}`,
        startsAt,
        endsAt,
        isPathEstimated: false,
        bounds: [entry.lon, entry.lat, entry.lon, entry.lat],
      };
    }

    const distance = `${entry.isPathEstimated ? 'about ' : ''}${formatDistance(entry.distanceMeters)}`;
    return {
      entryId,
      kind: 'trip',
      label: tripLabel(entry),
      detail: [
        formatDuration(entry.endedAt - entry.startedAt),
        distance,
        entry.isOngoing ? 'no stop yet' : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
      timeLabel: `${at(entry.startedAt)} – ${at(entry.endedAt)}`,
      startsAt: Math.max(entry.startedAt, day.from),
      endsAt: Math.min(entry.endedAt, day.to),
      isPathEstimated: entry.isPathEstimated,
      bounds: boundsOf(entry.path.map((point): Position => [point.lon, point.lat]))!,
    };
  });

  const features = timeline.entries.map(
    (entry, index): TimelineFeature => ({
      type: 'Feature',
      geometry:
        entry.kind === 'stop'
          ? { type: 'Point', coordinates: [entry.lon, entry.lat] }
          : {
              type: 'LineString',
              coordinates: entry.path.map((point): Position => [point.lon, point.lat]),
            },
      properties: {
        entryId: rows[index]!.entryId,
        kind: entry.kind,
        isPathEstimated: entry.kind === 'trip' && entry.isPathEstimated,
      },
    }),
  );

  return {
    userId: timeline.userId,
    date: timeline.date,
    dayLabel: formatDayLabel(timeline.date),
    day,
    rows,
    featureCollection: { type: 'FeatureCollection', features },
    bounds: boundsOf(features.flatMap(positionsOf)),
    track: trackOf(timeline.entries, day),
    // A trip's label can name a stop from outside the day, so trips count too.
    usesOpenStreetMap: timeline.entries.some((entry) => entry.isFromOpenStreetMap),
  };
}

function tripLabel(trip: Extract<TimelineEntry, { kind: 'trip' }>): string {
  if (trip.fromLabel && trip.toLabel) return `${trip.fromLabel} → ${trip.toLabel}`;
  if (trip.fromLabel) return `From ${trip.fromLabel}`;
  if (trip.toLabel) return `To ${trip.toLabel}`;
  return 'On the move';
}

/** `650 m`, `3.2 km`, `14 km`. */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const kilometers = meters / 1000;
  return kilometers < 10 ? `${kilometers.toFixed(1)} km` : `${Math.round(kilometers)} km`;
}

/** `YYYY-MM-DD` as `Sunday, November 22, 2026`, read at noon UTC so it can never slip a day. */
function formatDayLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day, 12)).toLocaleDateString(LOCALE, {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Where the user was through the day, oldest first: a stop holds still from
 * arrival to departure, and a trip follows its route. Only the day is kept, so
 * playback runs from midnight to midnight; a route crossing either end gets a
 * point where it crosses, so playback has a position right from midnight.
 */
function trackOf(
  entries: TimelineEntry[],
  day: { from: number; to: number },
): [number, number, number][] {
  const points = entries.flatMap((entry): [number, number, number][] =>
    entry.kind === 'stop'
      ? [
          [entry.lon, entry.lat, Math.max(entry.arrivedAt, day.from)],
          [entry.lon, entry.lat, Math.min(entry.departedAt, day.to)],
        ]
      : clipPath(entry.path, day.from, day.to).map((point): [number, number, number] => [
          point.lon,
          point.lat,
          point.tst,
        ]),
  );
  return points.sort((a, b) => a[2] - b[2]);
}

type PathPoint = TimelineTrip['path'][number];

/** The part of `path` from `from` to `to`, with a point added wherever it crosses either. */
function clipPath(path: PathPoint[], from: number, to: number): PathPoint[] {
  const clipped: PathPoint[] = [];
  path.forEach((point, index) => {
    const previous = path[index - 1];
    if (previous) {
      for (const edge of [from, to]) {
        if (previous.tst < edge && point.tst > edge) {
          clipped.push(pointAt(previous, point, edge));
        }
      }
    }
    if (point.tst >= from && point.tst <= to) clipped.push(point);
  });
  return clipped;
}

/** Where a straight line from `a` to `b` is at `tst`. */
function pointAt(a: PathPoint, b: PathPoint, tst: number): PathPoint {
  const share = (tst - a.tst) / (b.tst - a.tst);
  return { lat: a.lat + (b.lat - a.lat) * share, lon: a.lon + (b.lon - a.lon) * share, tst };
}

function positionsOf(feature: TimelineFeature): Position[] {
  return feature.geometry.type === 'Point'
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates;
}

function boundsOf(positions: Position[]): Bounds | undefined {
  if (positions.length === 0) return undefined;
  const lons = positions.map(([lon]) => lon);
  const lats = positions.map(([, lat]) => lat);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}
