import { detectVisits, type VisitDetectionOptions } from '@/application/detect-visits.ts';
import { distanceMeters } from '@/application/replay-geofence.ts';
import type {
  AreaRepository,
  LocationHistoryRepository,
  Logger,
  PlaceFinder,
} from '@/domain/ports.ts';
import type { Area, PointOfInterest, Visit } from '@/domain/types.ts';

/** A point of interest near a visited place, with how far it is from the place's centre. */
export type NearbyPlace = PointOfInterest & { distanceMeters: number };

/**
 * How a place was identified:
 *
 * - `area` — it lies inside one of the user's own areas, so it was not looked up.
 * - `found` — the place finder returned named places nearby.
 * - `none` — the place finder found nothing named nearby.
 * - `skipped` — not looked up this run: the lookup or time budget ran out, or
 *   an earlier lookup failed. Lookups are cached, so another run gets further.
 * - `failed` — the lookup for this place failed.
 * - `off` — no place finder is configured.
 */
export type PlaceLookupStatus = 'area' | 'found' | 'none' | 'skipped' | 'failed' | 'off';

/** Somewhere a user stopped one or more times. */
export type VisitedPlace = {
  /** Mean of the visits' centres (degrees). */
  lat: number;
  lon: number;
  /** Oldest first. */
  visits: Visit[];
  /** Time spent across every visit (seconds). */
  totalSeconds: number;
  /** The user's area the place lies inside, if any. */
  area?: Pick<Area, 'id' | 'name'>;
  /** Named places nearby, nearest first. The first is the best guess. */
  candidates: NearbyPlace[];
  lookup: PlaceLookupStatus;
};

export type InferVisitedPlacesOptions = {
  /** Only locations in this range (Unix epoch seconds, inclusive) are read. */
  range?: { from?: number; to?: number };
  visitDetection?: Partial<VisitDetectionOptions>;
  /** Visits whose centres are within this distance are the same place (meters). */
  placeRadiusMeters?: number;
  /** How far around a place to look for named places (meters). */
  searchRadiusMeters?: number;
  /**
   * Most places looked up per run, busiest first. Bounds the calls made to the
   * place finder, which is usually a shared public service.
   */
  maxLookups?: number;
  /**
   * No new lookup starts once this long has passed since the first one began
   * (milliseconds). Keeps a run responsive when the place finder is slow.
   */
  lookupBudgetMs?: number;
  /** Most nearby places kept per visited place. */
  maxCandidates?: number;
};

const DEFAULTS = {
  placeRadiusMeters: 75,
  searchRadiusMeters: 100,
  maxLookups: 15,
  lookupBudgetMs: 20_000,
  maxCandidates: 5,
};

/**
 * Works out where a user has been: finds the visits in their location history,
 * groups repeat visits to the same spot into places, and names each place
 * either from the user's own areas or from what is nearby.
 *
 * Places are returned busiest first: most visits, then most time spent.
 * Places inside one of the user's areas are never sent to the place finder, so
 * spots like home and work stay private.
 */
export async function inferVisitedPlaces(
  userId: string,
  deps: {
    repo: Pick<LocationHistoryRepository, 'listLocations'>;
    areaRepo: Pick<AreaRepository, 'listAreas'>;
    placeFinder?: PlaceFinder;
    logger: Logger;
    /** Milliseconds since the epoch; injectable for tests. */
    now?: () => number;
  },
  options: InferVisitedPlacesOptions = {},
): Promise<VisitedPlace[]> {
  const settings = { ...DEFAULTS, ...options };

  const visits: Visit[] = [];
  for await (const visit of detectVisits(
    deps.repo.listLocations(userId, settings.range),
    settings.visitDetection,
  )) {
    visits.push(visit);
  }

  const areas = await deps.areaRepo.listAreas(userId);
  const places = groupIntoPlaces(visits, settings.placeRadiusMeters)
    .map((group): VisitedPlace => {
      const area = smallestAreaContaining(areas, group.lat, group.lon);
      return {
        ...group,
        ...(area ? { area: { id: area.id, name: area.name } } : {}),
        candidates: [],
        lookup: area ? 'area' : deps.placeFinder ? 'skipped' : 'off',
      };
    })
    .sort(byBusiest);

  if (deps.placeFinder) {
    await lookUpPlaces(places, deps.placeFinder, deps.logger, deps.now ?? Date.now, settings);
  }

  return places;
}

/**
 * Looks up the busiest places one at a time, so a shared server never sees
 * more than one request from us. Stops at the lookup or time budget, or at the
 * first failure.
 */
async function lookUpPlaces(
  places: VisitedPlace[],
  placeFinder: PlaceFinder,
  logger: Logger,
  now: () => number,
  settings: typeof DEFAULTS,
): Promise<void> {
  let lookups = 0;
  let startedAt: number | undefined;
  for (const place of places) {
    if (place.lookup === 'area') continue;
    if (lookups >= settings.maxLookups) return;
    startedAt ??= now();
    if (now() - startedAt >= settings.lookupBudgetMs) return;
    lookups += 1;

    try {
      const found = await placeFinder.findNearbyPlaces(
        place.lat,
        place.lon,
        settings.searchRadiusMeters,
      );
      place.candidates = rankCandidates(place, found).slice(0, settings.maxCandidates);
      place.lookup = place.candidates.length > 0 ? 'found' : 'none';
    } catch (error) {
      // Usually a rate limit or a busy public server: back off for the rest of
      // this run rather than piling on more requests.
      logger.warn('Nearby place lookup failed; skipping the remaining places', error);
      place.lookup = 'failed';
      return;
    }
  }
}

/** Nearest first, keeping only the nearest of places that share a name and category. */
function rankCandidates(
  place: { lat: number; lon: number },
  found: PointOfInterest[],
): NearbyPlace[] {
  const ranked = found
    .map((poi) => ({ ...poi, distanceMeters: distanceMeters(place, poi.lat, poi.lon) }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  // A shop is often mapped twice, as a point and as its building outline.
  const seen = new Set<string>();
  return ranked.filter((candidate) => {
    const key = `${candidate.name.toLowerCase()}|${candidate.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type VisitGroup = Pick<VisitedPlace, 'lat' | 'lon' | 'visits' | 'totalSeconds'>;

/** Adds each visit to the nearest place within `radiusMeters`, or starts a new place. */
function groupIntoPlaces(visits: Visit[], radiusMeters: number): VisitGroup[] {
  const groups: VisitGroup[] = [];
  for (const visit of visits) {
    let nearest: VisitGroup | undefined;
    let nearestDistance = Infinity;
    for (const group of groups) {
      const distance = distanceMeters(group, visit.lat, visit.lon);
      if (distance <= radiusMeters && distance < nearestDistance) {
        nearest = group;
        nearestDistance = distance;
      }
    }

    if (!nearest) {
      groups.push({
        lat: visit.lat,
        lon: visit.lon,
        visits: [visit],
        totalSeconds: duration(visit),
      });
      continue;
    }

    const count = nearest.visits.length;
    nearest.lat = (nearest.lat * count + visit.lat) / (count + 1);
    nearest.lon = (nearest.lon * count + visit.lon) / (count + 1);
    nearest.visits.push(visit);
    nearest.totalSeconds += duration(visit);
  }
  return groups;
}

function duration(visit: Visit): number {
  return visit.departedAt - visit.arrivedAt;
}

/** The most specific area wins when areas overlap. */
function smallestAreaContaining(areas: Area[], lat: number, lon: number): Area | undefined {
  return areas
    .filter((area) => distanceMeters(area, lat, lon) <= area.radius)
    .sort((a, b) => a.radius - b.radius)[0];
}

function byBusiest(a: VisitedPlace, b: VisitedPlace): number {
  return (
    b.visits.length - a.visits.length ||
    b.totalSeconds - a.totalSeconds ||
    lastDeparture(b) - lastDeparture(a)
  );
}

function lastDeparture(place: VisitedPlace): number {
  return place.visits.at(-1)?.departedAt ?? 0;
}
