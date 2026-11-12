import type { Area, LocationPayload } from '@/domain/types.ts';
import type { GeofenceEvent } from '@/domain/events.ts';

/** Redis uses the same spherical earth radius for GEO distances. */
export function distanceMeters(a: Area, lat: number, lon: number): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(lat * rad) * Math.cos(a.lat * rad) * Math.sin(((lon - a.lon) * rad) / 2) ** 2;
  return 6372797.560856 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export class ReplayGeofence {
  readonly inside = new Set<string>();
  readonly pendingExit = new Map<string, number>();

  constructor(
    private areas: Area[],
    private thresholdSeconds: number,
  ) {}

  evaluate(location: LocationPayload): GeofenceEvent[] {
    const events: GeofenceEvent[] = [];
    for (const area of this.areas) {
      const base = {
        userId: location.tid,
        areaId: area.id,
        areaName: area.name,
        lat: location.lat,
        lon: location.lon,
        tst: location.tst,
      };
      if (distanceMeters(area, location.lat, location.lon) <= area.radius) {
        if (!this.inside.has(area.id)) events.push({ _type: 'area.entered', ...base });
        this.inside.add(area.id);
        this.pendingExit.delete(area.id);
      } else if (this.inside.has(area.id)) {
        const since = this.pendingExit.get(area.id);
        if (since === undefined) this.pendingExit.set(area.id, location.tst);
        else if (location.tst - since >= this.thresholdSeconds) {
          this.inside.delete(area.id);
          this.pendingExit.delete(area.id);
          events.push({ _type: 'area.exited', ...base });
        }
      }
    }
    return events;
  }
}
