import type { PlaceLookupStatus, VisitedPlace } from '@/application/infer-visited-places.ts';

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
    const label = place.area?.name ?? likely?.name ?? 'Unknown place';
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
