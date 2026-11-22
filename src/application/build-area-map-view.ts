import type { Area, AreaCategory, AreaCategoryColor } from '@/domain/types.ts';

/**
 * A circle's colour: its category's palette key, or `none` when it is
 * uncategorised. The page turns keys into the light or dark shade.
 */
export type AreaColorKey = AreaCategoryColor | 'none';

/** Vertices used to approximate each circular area as a polygon ring. */
const CIRCLE_VERTICES = 64;

/** Mean Earth radius in meters, matching the sphere Redis GEO commands assume. */
const EARTH_RADIUS_METERS = 6_371_008.8;

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
    /** The circle's centre, so the map popup can open the area for editing. */
    lat: number;
    lon: number;
    radius: number;
    colorKey: AreaColorKey;
    /**
     * Shown in the area's popup; empty when it is uncategorised. Not null, so
     * the value the popup gets back from MapLibre is never in doubt.
     */
    categoryName: string;
  };
};

export type AreaFeatureCollection = {
  type: 'FeatureCollection';
  features: AreaFeature[];
};

export type AreaMapView = {
  featureCollection: AreaFeatureCollection;
  /** `[west, south, east, north]` enclosing every area, or undefined when there are none. */
  bounds?: [number, number, number, number];
};

/** Degrees of latitude and longitude a circle of `radius` meters spans either side of its center. */
function circleDeltas(
  lat: number,
  radius: number,
): { latitudeDelta: number; longitudeDelta: number } {
  const latitudeDelta = (radius / EARTH_RADIUS_METERS) * (180 / Math.PI);
  // Lines of longitude converge toward the poles, so a fixed ground distance
  // spans more degrees of longitude the further from the equator it sits.
  const longitudeDelta = latitudeDelta / Math.cos((lat * Math.PI) / 180);
  return { latitudeDelta, longitudeDelta };
}

/** `[west, south, east, north]` enclosing one circular area. */
export function circleBounds(
  lat: number,
  lon: number,
  radius: number,
): [number, number, number, number] {
  const { latitudeDelta, longitudeDelta } = circleDeltas(lat, radius);
  return [lon - longitudeDelta, lat - latitudeDelta, lon + longitudeDelta, lat + latitudeDelta];
}

/**
 * Approximates a circle of `radius` meters around a center as a closed polygon
 * ring. MapLibre's `circle` layer sizes its radius in pixels, so a real-world
 * radius has to be baked into the geometry instead.
 */
function circleToRing(lat: number, lon: number, radius: number): Position[] {
  const { latitudeDelta, longitudeDelta } = circleDeltas(lat, radius);

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
 * polygon geometry, the colour of each area's category, and a bounding box.
 * `categories` are the areas' owner's; an area whose category isn't among them
 * is drawn as uncategorised.
 */
export function buildAreaMapView(areas: Area[], categories: AreaCategory[] = []): AreaMapView {
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  const features = areas.map((area): AreaFeature => {
    const ring = circleToRing(area.lat, area.lon, area.radius);
    const category = area.categoryId ? categoryById.get(area.categoryId) : undefined;
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        areaId: area.id,
        userId: area.userId,
        name: area.name,
        lat: area.lat,
        lon: area.lon,
        radius: area.radius,
        colorKey: category?.color ?? 'none',
        categoryName: category?.name ?? '',
      },
    };
  });

  return {
    featureCollection: { type: 'FeatureCollection', features },
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
