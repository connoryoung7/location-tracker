import type { WaypointPayload } from '@/domain/types.ts';
import type { LocationRepository, Logger, ReverseGeocoder } from '@/domain/ports.ts';

export async function handleWaypoint(
  payload: WaypointPayload,
  deps: { repo: LocationRepository; logger: Logger; reverseGeocoder: ReverseGeocoder },
): Promise<void> {
  deps.logger.info(`Waypoint: desc="${payload.desc}" rid="${payload.rid ?? 'unknown'}"`);
  if (payload.lat != null && payload.lon != null) {
    const result = await deps.reverseGeocoder.reverseGeocode(payload.lat, payload.lon);
    if (result.address) {
      deps.logger.info(`Address: ${result.address.displayName}`);
      await deps.repo.saveAddress(result.lat, result.lon, result.address);
    }
  }
  await deps.repo.saveWaypoint(payload);
}
