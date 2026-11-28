import { DEFAULT_VISIT_DETECTION_OPTIONS } from '@/application/detect-visits.ts';
import type { PlaceLookupStatus, VisitedPlace } from '@/application/infer-visited-places.ts';
import { distanceMeters } from '@/application/replay-geofence.ts';

/** Another named place near a visited place: what the user might have been at instead. */
export type VisitedPlaceAlternative = {
  name: string;
  category: string;
  /** Rounded to the metre. */
  distanceMeters: number;
};

/** One row of the places list. Also the properties of that place's map point. */
export type VisitedPlaceRow = {
  /** Stable within one view; ties a list row to its map point. */
  placeId: string;
  /** The area name, the most likely nearby place, or a placeholder. */
  label: string;
  /** What kind of place it probably is, e.g. `Grocery store`. Absent when unknown. */
  category?: string;
  /** Why the place has no name, when it has none. */
  note?: string;
  lookup: PlaceLookupStatus;
  lat: number;
  lon: number;
  visitCount: number;
  totalSeconds: number;
  /** `totalSeconds` for display, e.g. `3h 20m`. */
  durationLabel: string;
  /** When the latest visit ended, ISO 8601 UTC; the browser shows it in local time. */
  lastVisitIso: string;
  alternatives: VisitedPlaceAlternative[];
  /** A starting point for saving the place as an area. Absent when it already is one. */
  proposedArea?: ProposedArea;
};

/** The area the UI offers to create for a visited place, centred on the place. */
export type ProposedArea = {
  /** The most likely nearby place's name, or empty when nothing named is nearby. */
  name: string;
  /** The place's centre, rounded to 6 decimal places (about 0.1 m). */
  lat: number;
  lon: number;
  /** Metres, rounded up to the next 10. */
  radius: number;
};

/** Visits added up by kind of place, so "6 grocery store visits" reads at a glance. */
export type VisitedCategoryRow = {
  category: string;
  visitCount: number;
  placeCount: number;
};

export type VisitedPlaceFeature = {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: VisitedPlaceRow;
};

export type VisitedPlaceView = {
  userId: string;
  rows: VisitedPlaceRow[];
  categories: VisitedCategoryRow[];
  featureCollection: { type: 'FeatureCollection'; features: VisitedPlaceFeature[] };
  /** `[west, south, east, north]` around every place, or undefined when there are none. */
  bounds?: [number, number, number, number];
};

const AREA_CATEGORY = 'Saved area';

const NOTE_BY_LOOKUP: Partial<Record<PlaceLookupStatus, string>> = {
  none: 'Nothing named nearby',
  skipped: 'Not looked up yet; run again to identify more',
  failed: 'Lookup failed; try again later',
  off: 'Nearby lookups are turned off',
};

/** Turns inferred places into the list rows, category summary, and map points the places panel renders. */
export function buildVisitedPlaceView(userId: string, places: VisitedPlace[]): VisitedPlaceView {
  const rows = places.map((place, index): VisitedPlaceRow => {
    const [likely, ...others] = place.candidates;
    const label = labelForPlace(place);
    const category = place.area ? AREA_CATEGORY : likely?.category;
    const note = place.area || likely ? undefined : NOTE_BY_LOOKUP[place.lookup];
    const lastVisit = place.visits.at(-1);

    return {
      placeId: `place-${index + 1}`,
      label,
      ...(category ? { category } : {}),
      ...(note ? { note } : {}),
      lookup: place.lookup,
      lat: place.lat,
      lon: place.lon,
      visitCount: place.visits.length,
      totalSeconds: place.totalSeconds,
      durationLabel: formatDuration(place.totalSeconds),
      lastVisitIso: new Date((lastVisit?.departedAt ?? 0) * 1000).toISOString(),
      // An area is the user's own name for the spot, so nearby businesses are not alternatives to it.
      alternatives: place.area
        ? []
        : others.map((other) => ({
            name: other.name,
            category: other.category,
            distanceMeters: Math.round(other.distanceMeters),
          })),
      ...(place.area ? {} : { proposedArea: proposeArea(place, likely?.name ?? '') }),
    };
  });

  const features = rows.map(
    (row): VisitedPlaceFeature => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
      properties: row,
    }),
  );

  return {
    userId,
    rows,
    categories: summarizeCategories(rows),
    featureCollection: { type: 'FeatureCollection', features },
    bounds: boundsOf(rows),
  };
}

/**
 * A circle on the place, wide enough that every visit's stay circle fits
 * inside, so the new area would have caught each of those visits. A visit is
 * fixes within the stop radius of its own centre, and that centre can sit a
 * little off the place's.
 */
function proposeArea(place: VisitedPlace, name: string): ProposedArea {
  const farthestVisit = Math.max(
    0,
    ...place.visits.map((visit) => distanceMeters(place, visit.lat, visit.lon)),
  );
  return {
    name,
    lat: Number(place.lat.toFixed(6)),
    lon: Number(place.lon.toFixed(6)),
    radius: Math.ceil((farthestVisit + DEFAULT_VISIT_DETECTION_OPTIONS.radiusMeters) / 10) * 10,
  };
}

/** Busiest category first. Areas are the user's own labels, not categories, so they are left out. */
function summarizeCategories(rows: VisitedPlaceRow[]): VisitedCategoryRow[] {
  const byCategory = new Map<string, VisitedCategoryRow>();
  for (const row of rows) {
    if (!row.category || row.category === AREA_CATEGORY) continue;
    const summary = byCategory.get(row.category) ?? {
      category: row.category,
      visitCount: 0,
      placeCount: 0,
    };
    summary.visitCount += row.visitCount;
    summary.placeCount += 1;
    byCategory.set(row.category, summary);
  }
  return [...byCategory.values()].sort(
    (a, b) => b.visitCount - a.visitCount || a.category.localeCompare(b.category),
  );
}

/** The area name, else the most likely nearby place, else a placeholder. */
export function labelForPlace(place: Pick<VisitedPlace, 'area' | 'candidates'>): string {
  return place.area?.name ?? place.candidates[0]?.name ?? 'Unknown place';
}

/** `45 min`, `3h 20m`, `2d 4h`. Under a minute rounds up to `1 min`. */
export function formatDuration(totalSeconds: number): string {
  const minutes = Math.max(1, Math.round(totalSeconds / 60));
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return remainder ? `${days}d ${remainder}h` : `${days}d`;
}

function boundsOf(rows: VisitedPlaceRow[]): [number, number, number, number] | undefined {
  if (rows.length === 0) {
    return undefined;
  }

  const lons = rows.map((row) => row.lon);
  const lats = rows.map((row) => row.lat);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}
