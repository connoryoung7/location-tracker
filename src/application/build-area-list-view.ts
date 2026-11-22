import { circleBounds, colorForUserId } from '@/application/build-area-map-view.ts';
import type { Area } from '@/domain/types.ts';

/** One row of the areas list. */
export type AreaListRow = {
  areaId: string;
  userId: string;
  name: string;
  lat: number;
  lon: number;
  /** Radius in meters. */
  radius: number;
  /** The same per-user color the map and legend use. */
  color: string;
  /** `[west, south, east, north]` around the whole circle, for zooming the map to it. */
  bounds: [number, number, number, number];
};

export type AreaListView = {
  rows: AreaListRow[];
};

/** Orders every user's areas together, then by name, so a user's areas read as a group. */
export function buildAreaListView(areas: Area[]): AreaListView {
  const rows = areas
    .map(
      (area): AreaListRow => ({
        areaId: area.id,
        userId: area.userId,
        name: area.name,
        lat: area.lat,
        lon: area.lon,
        radius: area.radius,
        color: colorForUserId(area.userId),
        bounds: circleBounds(area.lat, area.lon, area.radius),
      }),
    )
    .sort(
      (a, b) =>
        a.userId.localeCompare(b.userId) ||
        a.name.localeCompare(b.name) ||
        a.areaId.localeCompare(b.areaId),
    );

  return { rows };
}
