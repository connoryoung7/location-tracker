import type { WaypointPayload } from '@/domain/types.ts';
import type { Geocoder, LocationRepository, Logger } from '@/domain/ports.ts';

export async function handleWaypoint(
  payload: WaypointPayload,
  deps: { repo: LocationRepository; logger: Logger; reverseGeocoder: Geocoder },
): Promise<void> {
  deps.logger.info(`Waypoint: rid="${payload.rid ?? 'unknown'}"`);
  if (payload.lat != null && payload.lon != null) {
    deps.reverseGeocoder
      .reverseGeocode(payload.lat, payload.lon)
      .then(async (result) => {
        if (result.address) {
          deps.logger.info('Address resolved, saving');
          await deps.repo.saveAddress(result.lat, result.lon, result.address);
        }
      })
      .catch((err) => {
        deps.logger.error(`Reverse geocode failed: ${err}`);
      });
  }
  await deps.repo.saveWaypoint(payload);
}
