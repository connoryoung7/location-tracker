import type { Area } from '@/domain/types.ts';

/** Vertices used to approximate each circular area as a polygon ring. */
const CIRCLE_VERTICES = 64;

/** Mean Earth radius in meters, matching the sphere Redis GEO commands assume. */
const EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Fill colors assigned to users in sorted order. Chosen to stay distinguishable
 * against the OpenStreetMap basemap and to each other.
 */
const USER_COLORS = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#d97706',
  '#9333ea',
  '#0891b2',
  '#db2777',
  '#65a30d',
] as const;

/** A `[lon, lat]` pair, in the order GeoJSON requires. */
type Position = [number, number];

/** GeoJSON polygon approximating one area's circle, carrying its display metadata. */
export type AreaFeature = {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: Position[][] };
  properties: {
    areaId: string;
    userId: string;
    name: string;
    radius: number;
    color: string;
  };
};

export type AreaFeatureCollection = {
  type: 'FeatureCollection';
  features: AreaFeature[];
};

/** One row of the map legend: a user, their color, and how many areas they own. */
export type AreaLegendRow = {
  userId: string;
  color: string;
  areaCount: number;
};

export type AreaMapView = {
  featureCollection: AreaFeatureCollection;
  legend: AreaLegendRow[];
  /** `[west, south, east, north]` enclosing every area, or undefined when there are none. */
  bounds?: [number, number, number, number];
};

/**
 * Approximates a circle of `radius` meters around a center as a closed polygon
 * ring. MapLibre's `circle` layer sizes its radius in pixels, so a real-world
 * radius has to be baked into the geometry instead.
 */
function circleToRing(lat: number, lon: number, radius: number): Position[] {
  const latitudeDelta = (radius / EARTH_RADIUS_METERS) * (180 / Math.PI);
  // Lines of longitude converge toward the poles, so a fixed ground distance
  // spans more degrees of longitude the further from the equator it sits.
  const longitudeDelta = latitudeDelta / Math.cos((lat * Math.PI) / 180);

  const ring: Position[] = [];
  for (let vertex = 0; vertex < CIRCLE_VERTICES; vertex += 1) {
    const angle = (vertex / CIRCLE_VERTICES) * 2 * Math.PI;
    ring.push([lon + longitudeDelta * Math.cos(angle), lat + latitudeDelta * Math.sin(angle)]);
  }
  // GeoJSON linear rings must repeat the first position as the last.
  ring.push(ring[0]!);

  return ring;
}

/**
 * Turns a flat list of areas into everything the map UI needs to render them:
 * polygon geometry, a stable per-user color, legend rows, and a bounding box.
 *
 * Colors are keyed off the sorted position of each user ID so a given user keeps
 * the same color across refreshes regardless of the order Redis returned them in.
 */
export function buildAreaMapView(areas: Area[]): AreaMapView {
  const userIds = [...new Set(areas.map((area) => area.userId))].sort();
  const colorByUserId = new Map(
    userIds.map((userId, index) => [userId, USER_COLORS[index % USER_COLORS.length]!]),
  );

  const features = areas.map((area): AreaFeature => {
    const ring = circleToRing(area.lat, area.lon, area.radius);
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        areaId: area.id,
        userId: area.userId,
        name: area.name,
        radius: area.radius,
        color: colorByUserId.get(area.userId)!,
      },
    };
  });

  const legend = userIds.map(
    (userId): AreaLegendRow => ({
      userId,
      color: colorByUserId.get(userId)!,
      areaCount: areas.filter((area) => area.userId === userId).length,
    }),
  );

  return {
    featureCollection: { type: 'FeatureCollection', features },
    legend,
    bounds: boundsOf(features),
  };
}

/** Bounding box covering every vertex, so circles are framed whole rather than by center. */
function boundsOf(features: AreaFeature[]): [number, number, number, number] | undefined {
  if (features.length === 0) {
    return undefined;
  }

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const feature of features) {
    for (const [lon, lat] of feature.geometry.coordinates[0]!) {
      west = Math.min(west, lon);
      south = Math.min(south, lat);
      east = Math.max(east, lon);
      north = Math.max(north, lat);
    }
  }

  return [west, south, east, north];
}
