import type { Area } from '@/domain/types.ts';

/** Vertices used to approximate each circular area as a polygon ring. */
const CIRCLE_VERTICES = 64;

/** Mean Earth radius in meters, matching the sphere Redis GEO commands assume. */
const EARTH_RADIUS_METERS = 6_371_008.8;

/** Saturation held fixed so every generated color stays legible on the basemap. */
const USER_COLOR_SATURATION = 65;

/**
 * Hue alone leaves too much to chance: with a handful of users, two hashes
 * landing within a few degrees of each other is common enough to see in
 * practice, and near-identical hues are indistinguishable on the map. Varying
 * lightness as well gives those pairs a second axis to separate on.
 */
const USER_COLOR_LIGHTNESSES = [36, 46, 56] as const;

/** FNV-1a offset basis and prime. */
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

function fnv1a(value: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }

  return hash >>> 0;
}

/**
 * Derives a user's color from their ID alone.
 *
 * Deriving it from the user's position in the sorted list instead would mean a
 * newly added user that sorts earlier shifts the color of everyone after them
 * on the next poll. Hashing is stateless, so a user's color survives other
 * users appearing and disappearing.
 *
 * Distinct IDs can still collide; the legend labels every swatch rather than
 * relying on color alone.
 */
function colorForUserId(userId: string): string {
  const hue = fnv1a(userId) % 360;
  // Salted separately so lightness does not simply track the hue.
  const lightness =
    USER_COLOR_LIGHTNESSES[fnv1a(`${userId}:lightness`) % USER_COLOR_LIGHTNESSES.length]!;

  return `hsl(${hue}, ${USER_COLOR_SATURATION}%, ${lightness}%)`;
}

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
 * Each user's color is derived from their ID alone, so it survives both
 * reordering and the arrival of new users between polls. The sort only fixes
 * legend row order.
 */
export function buildAreaMapView(areas: Area[]): AreaMapView {
  const userIds = [...new Set(areas.map((area) => area.userId))].sort();
  const colorByUserId = new Map(userIds.map((userId) => [userId, colorForUserId(userId)]));

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
