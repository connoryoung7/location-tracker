import { labelForPlace } from '@/application/build-visited-place-view.ts';
import {
  DEFAULT_VISIT_DETECTION_OPTIONS,
  type VisitDetectionOptions,
} from '@/application/detect-visits.ts';
import { inferVisitedPlaces, type VisitedPlace } from '@/application/infer-visited-places.ts';
import { distanceMeters } from '@/application/replay-geofence.ts';
import { zonedDayRange } from '@/application/zoned-day.ts';
import type {
  AreaRepository,
  LocationHistoryRepository,
  Logger,
  PlaceFinder,
} from '@/domain/ports.ts';
import type { LocationPayload, Trip, Visit } from '@/domain/types.ts';

/**
 * How long before the day locations are read from, so a stay that began the
 * evening before (home overnight) is found whole rather than starting at
 * midnight.
 */
const LEAD_IN_SECONDS = 12 * 3600;
/** How long past the day, so its last stop or trip can see how it ended. */
const LEAD_OUT_SECONDS = 2 * 3600;

/** Somewhere the user stopped. Times are not clipped to the day; the view does that. */
export type TimelineStop = {
  kind: 'stop';
  label: string;
  /** What kind of place it probably is, e.g. `Grocery store`, or `Saved area`. */
  category?: string;
  /** Whether `label` came from OpenStreetMap, which must then be credited. */
  isFromOpenStreetMap: boolean;
  lat: number;
  lon: number;
  arrivedAt: number;
  departedAt: number;
};

/** A stretch of travel, with where it set off from and went to when known. */
export type TimelineTrip = Trip & {
  kind: 'trip';
  /**
   * Whether a name in the trip's label came from OpenStreetMap. Kept on the
   * trip itself, since the stop it names may lie outside the day and be left out.
   */
  isFromOpenStreetMap: boolean;
  /** Absent when the trip was already under way when the history starts. */
  fromLabel?: string;
  /** Absent when the user had not stopped again by the last fix. */
  toLabel?: string;
};

export type TimelineEntry = TimelineStop | TimelineTrip;

export type DayTimeline = {
  userId: string;
  /** `YYYY-MM-DD` in `timeZone`. */
  date: string;
  timeZone: string;
  /** The day itself, as Unix epoch seconds; `to` is exclusive. */
  day: { from: number; to: number };
  /** Every stop and trip that overlaps the day, oldest first. The first and last may run past it. */
  entries: TimelineEntry[];
};

export type DayTimelineDeps = {
  repo: Pick<LocationHistoryRepository, 'listLocations'>;
  areaRepo: Pick<AreaRepository, 'listAreas'>;
  placeFinder?: PlaceFinder;
  logger: Logger;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
};

/**
 * Works out one of a user's days: the stops they made, named as in the places
 * panel, and the trips between them, each with its route, distance and time.
 *
 * Stops come from `inferVisitedPlaces`, so they are found and named exactly as
 * the places panel finds and names them, and places inside the user's areas
 * are never looked up online. A trip is the movement from one stop's
 * departure to the next stop's arrival.
 */
export async function buildDayTimeline(
  userId: string,
  deps: DayTimelineDeps,
  { date, timeZone }: { date: string; timeZone: string },
  options: { visitDetection?: Partial<VisitDetectionOptions> } = {},
): Promise<DayTimeline> {
  const day = zonedDayRange(date, timeZone);

  // One day is at most a few thousand fixes, so they are held in memory: read
  // once, then used both to find stops and to trace the trips between them.
  const fixes: LocationPayload[] = [];
  for await (const fix of deps.repo.listLocations(userId, {
    from: day.from - LEAD_IN_SECONDS,
    to: day.to + LEAD_OUT_SECONDS,
  })) {
    fixes.push(fix);
  }

  const places = await inferVisitedPlaces(
    userId,
    {
      ...deps,
      repo: {
        async *listLocations() {
          yield* fixes;
        },
      },
    },
    { visitDetection: options.visitDetection },
  );
  const stops = places
    .flatMap((place) => place.visits.map((visit) => toStop(visit, place)))
    .sort((a, b) => a.arrivedAt - b.arrivedAt);

  const { maxAccuracyMeters } = { ...DEFAULT_VISIT_DETECTION_OPTIONS, ...options.visitDetection };
  // The same accuracy cut-off visit detection uses, so a cell-tower fix miles
  // off never bends a route.
  const usable = fixes.filter((fix) => fix.acc == null || fix.acc <= maxAccuracyMeters);

  return {
    userId,
    date,
    timeZone,
    day,
    entries: withTrips(stops, usable).filter((entry) => overlaps(entry, day)),
  };
}

function toStop(visit: Visit, place: VisitedPlace): TimelineStop {
  const [likely] = place.candidates;
  const category = place.area ? 'Saved area' : likely?.category;
  return {
    kind: 'stop',
    label: labelForPlace(place),
    ...(category ? { category } : {}),
    isFromOpenStreetMap: !place.area && likely !== undefined,
    lat: visit.lat,
    lon: visit.lon,
    arrivedAt: visit.arrivedAt,
    departedAt: visit.departedAt,
  };
}

type PathPoint = Trip['path'][number];

/** Interleaves the trips between `stops`, traced through `fixes` (both oldest first). */
function withTrips(stops: TimelineStop[], fixes: LocationPayload[]): TimelineEntry[] {
  const pointsBetween = (after: number, before: number): PathPoint[] =>
    fixes
      .filter((fix) => fix.tst > after && fix.tst < before)
      .map(({ lat, lon, tst }) => ({ lat, lon, tst }));

  if (stops.length === 0) {
    // Moving, or too sparse to stop, the whole time.
    const points = pointsBetween(-Infinity, Infinity);
    return points.length >= 2 ? [toTrip(points, { isOngoing: true })] : [];
  }

  const entries: TimelineEntry[] = [];
  const first = stops[0]!;
  const lead = pointsBetween(-Infinity, first.arrivedAt);
  if (lead.length > 0) {
    // Already under way when the history starts.
    entries.push(toTrip([...lead, at(first, first.arrivedAt)], { to: first }));
  }

  stops.forEach((stop, index) => {
    entries.push(stop);
    const next = stops[index + 1];
    const between = pointsBetween(stop.departedAt, next ? next.arrivedAt : Infinity);
    if (next) {
      entries.push(
        toTrip([at(stop, stop.departedAt), ...between, at(next, next.arrivedAt)], {
          from: stop,
          to: next,
          isPathEstimated: between.length === 0,
        }),
      );
    } else if (between.length > 0) {
      entries.push(
        toTrip([at(stop, stop.departedAt), ...between], { from: stop, isOngoing: true }),
      );
    }
  });
  return entries;
}

function at(stop: TimelineStop, tst: number): PathPoint {
  return { lat: stop.lat, lon: stop.lon, tst };
}

function toTrip(
  path: PathPoint[],
  {
    from,
    to,
    isPathEstimated = false,
    isOngoing = false,
  }: { from?: TimelineStop; to?: TimelineStop; isPathEstimated?: boolean; isOngoing?: boolean },
): TimelineTrip {
  let distance = 0;
  for (let index = 1; index < path.length; index += 1) {
    distance += distanceMeters(path[index - 1]!, path[index]!.lat, path[index]!.lon);
  }
  return {
    kind: 'trip',
    startedAt: path[0]!.tst,
    endedAt: path.at(-1)!.tst,
    path,
    distanceMeters: distance,
    isPathEstimated,
    isOngoing,
    isFromOpenStreetMap: Boolean(from?.isFromOpenStreetMap || to?.isFromOpenStreetMap),
    ...(from ? { fromLabel: from.label } : {}),
    ...(to ? { toLabel: to.label } : {}),
  };
}

function overlaps(entry: TimelineEntry, day: { from: number; to: number }): boolean {
  const [start, end] =
    entry.kind === 'stop' ? [entry.arrivedAt, entry.departedAt] : [entry.startedAt, entry.endedAt];
  return start < day.to && end > day.from;
}
