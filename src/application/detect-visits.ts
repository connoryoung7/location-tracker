import { distanceMeters } from '@/application/replay-geofence.ts';
import type { LocationPayload, Visit } from '@/domain/types.ts';

export type VisitDetectionOptions = {
  /** How far a fix may be from the centre of a stay and still belong to it (meters). */
  radiusMeters: number;
  /** Shortest stay that counts as a visit (seconds). */
  minDurationSeconds: number;
  /** Fixes reporting a worse accuracy than this are ignored (meters). */
  maxAccuracyMeters: number;
  /**
   * Speed assumed when working out when the user left across a reporting gap
   * (meters per second). See `estimateDeparture`.
   */
  travelSpeedMetersPerSecond: number;
};

export const DEFAULT_VISIT_DETECTION_OPTIONS: VisitDetectionOptions = {
  radiusMeters: 100,
  minDurationSeconds: 5 * 60,
  maxAccuracyMeters: 200,
  // Roughly 18 km/h: slower than driving, faster than walking.
  travelSpeedMetersPerSecond: 5,
};

/** The parts of a location fix visit detection reads. */
export type VisitFix = Pick<LocationPayload, 'lat' | 'lon' | 'tst' | 'acc'>;

/** The fixes currently being considered as one stay. */
class Stay {
  private latSum = 0;
  private lonSum = 0;
  count = 0;
  readonly arrivedAt: number;
  lastSeenAt: number;

  constructor(fix: VisitFix) {
    this.arrivedAt = fix.tst;
    this.lastSeenAt = fix.tst;
    this.add(fix);
  }

  add(fix: VisitFix): void {
    this.latSum += fix.lat;
    this.lonSum += fix.lon;
    this.count += 1;
    this.lastSeenAt = fix.tst;
  }

  get centre(): { lat: number; lon: number } {
    return { lat: this.latSum / this.count, lon: this.lonSum / this.count };
  }
}

/**
 * Finds the places a user stopped at: runs of fixes that stay within
 * `radiusMeters` of their centre for at least `minDurationSeconds`.
 *
 * `locations` must be in timestamp order, as `listLocations` returns them.
 * Visits are yielded as soon as the user is seen leaving, so the whole history
 * is never held in memory.
 *
 * Two rules make it tolerant of real phone data:
 *
 * - **A single stray fix does not end a stay.** The user only counts as gone
 *   after two fixes in a row land outside it, so one GPS jump mid-visit does
 *   not split it in two.
 * - **Quiet periods count as time spent.** Phones report rarely while they are
 *   not moving, so a stay may be one fix followed by a long silence. See
 *   `estimateDeparture` for how the departure time is recovered.
 */
export async function* detectVisits(
  locations: AsyncIterable<VisitFix> | Iterable<VisitFix>,
  options: Partial<VisitDetectionOptions> = {},
): AsyncGenerator<Visit> {
  const settings = { ...DEFAULT_VISIT_DETECTION_OPTIONS, ...options };
  const isInside = (stay: Stay, fix: VisitFix) =>
    distanceMeters(stay.centre, fix.lat, fix.lon) <= settings.radiusMeters;

  let stay: Stay | undefined;
  /** The first fix seen outside `stay`, held until the next fix shows whether it was a stray. */
  let stray: VisitFix | undefined;

  for await (const fix of locations) {
    if (fix.acc != null && fix.acc > settings.maxAccuracyMeters) {
      continue;
    }

    if (!stay) {
      stay = new Stay(fix);
      continue;
    }

    if (isInside(stay, fix)) {
      stay.add(fix);
      stray = undefined;
      continue;
    }

    if (!stray) {
      stray = fix;
      continue;
    }

    // Two fixes in a row outside the stay: the user has left.
    const visit = toVisit(stay, stray, settings);
    if (visit) yield visit;

    stay = new Stay(stray);
    stray = undefined;
    if (isInside(stay, fix)) stay.add(fix);
    else stray = fix;
  }

  if (stay) {
    const visit = toVisit(stay, stray, settings);
    if (visit) yield visit;
  }
}

function toVisit(
  stay: Stay,
  next: VisitFix | undefined,
  settings: VisitDetectionOptions,
): Visit | undefined {
  const centre = stay.centre;
  const departedAt = next
    ? estimateDeparture(stay.lastSeenAt, centre, next, settings.travelSpeedMetersPerSecond)
    : stay.lastSeenAt;

  if (departedAt - stay.arrivedAt < settings.minDurationSeconds) {
    return undefined;
  }

  return {
    lat: centre.lat,
    lon: centre.lon,
    arrivedAt: stay.arrivedAt,
    departedAt,
    locationCount: stay.count,
  };
}

/**
 * The user was last seen at the stay at `lastSeenAt` and next seen at `next`,
 * somewhere else. A phone that is not moving often reports nothing at all, so
 * the gap between the two is usually time spent at the stay rather than time
 * travelling. Assume the user left just in time to reach `next` at
 * `speed`, but never before they were last seen there.
 */
function estimateDeparture(
  lastSeenAt: number,
  centre: { lat: number; lon: number },
  next: VisitFix,
  speed: number,
): number {
  const travelSeconds = distanceMeters(centre, next.lat, next.lon) / speed;
  return Math.max(lastSeenAt, Math.round(next.tst - travelSeconds));
}
