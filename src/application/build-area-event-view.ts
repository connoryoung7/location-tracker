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
  /** ISO 8601 UTC, for `<time datetime>` and as the fallback display text. */
  isoTime: string;
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
  rows: AreaEventListRow[];
  featureCollection: AreaEventFeatureCollection;
  /** `[west, south, east, north]` around every event, or undefined when there are none. */
  bounds?: [number, number, number, number];
};

const KIND_BY_TYPE = {
  'area.entered': 'entered',
  'area.exited': 'exited',
} as const satisfies Record<GeofenceEvent['_type'], AreaEventKind>;

/**
 * Turns a user's stored area events into the list rows and map points the
 * events panel renders. Keeps the incoming order, which the repository returns
 * newest first.
 */
export function buildAreaEventView(userId: string, events: GeofenceEvent[]): AreaEventView {
  const rows = events.map(
    (event): AreaEventListRow => ({
      kind: KIND_BY_TYPE[event._type],
      areaId: event.areaId,
      areaLabel: event.areaName ?? event.areaId,
      lat: event.lat,
      lon: event.lon,
      tst: event.tst,
      isoTime: new Date(event.tst * 1000).toISOString(),
    }),
  );

  const features = rows.map(
    (row): AreaEventFeature => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
      properties: row,
    }),
  );

  return {
    userId,
    rows,
    featureCollection: { type: 'FeatureCollection', features },
    bounds: boundsOf(rows),
  };
}

function boundsOf(rows: AreaEventListRow[]): [number, number, number, number] | undefined {
  if (rows.length === 0) {
    return undefined;
  }

  const lons = rows.map((row) => row.lon);
  const lats = rows.map((row) => row.lat);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}
