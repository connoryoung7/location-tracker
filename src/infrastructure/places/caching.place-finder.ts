import type { PlaceFinder } from '@/domain/ports.ts';
import type { PointOfInterest } from '@/domain/types.ts';

/**
 * Remembers lookups in memory so analysing the same history again does not
 * re-query the same spots. Coordinates are bucketed to four decimal places
 * (about 11 m), close enough that the nearby places are the same. Failures are
 * not cached, so a busy server is retried on the next run.
 */
export class CachingPlaceFinder implements PlaceFinder {
  private entries = new Map<string, Promise<PointOfInterest[]>>();

  constructor(
    private inner: PlaceFinder,
    private maxEntries = 1_000,
  ) {}

  findNearbyPlaces(lat: number, lon: number, radiusMeters: number): Promise<PointOfInterest[]> {
    const key = `${lat.toFixed(4)},${lon.toFixed(4)},${Math.round(radiusMeters)}`;
    const cached = this.entries.get(key);
    if (cached) {
      // Re-insert so the Map's insertion order doubles as least-recently-used order.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }

    const pending = this.inner.findNearbyPlaces(lat, lon, radiusMeters);
    this.entries.set(key, pending);
    pending.catch(() => {
      if (this.entries.get(key) === pending) this.entries.delete(key);
    });

    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return pending;
  }
}
