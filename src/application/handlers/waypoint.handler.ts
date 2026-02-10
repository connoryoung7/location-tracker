import type { WaypointPayload } from '@/domain/types.ts';
import type { LocationRepository, Logger, ReverseGeocoder } from '@/domain/ports.ts';

export async function handleWaypoint(
  payload: WaypointPayload,
  deps: { repo: LocationRepository; logger: Logger; reverseGeocoder: ReverseGeocoder },
): Promise<void> {
  deps.logger.info(`Waypoint: desc="${payload.desc}" rid="${payload.rid ?? 'unknown'}"`);
  if (payload.lat != null && payload.lon != null) {
    const address = await deps.reverseGeocoder.reverseGeocode(payload.lat, payload.lon);
    if (address) {
      deps.logger.info(`Address: ${address.displayName}`);
      await deps.repo.saveAddress(payload.lat, payload.lon, address);
    }
  }
  await deps.repo.saveWaypoint(payload);
}
