import type { LocationPayload } from '@/domain/types.ts';
import type {
  EventPublisher,
  Geocoder,
  GeofenceEvaluator,
  LocationRepository,
  Logger,
} from '@/domain/ports.ts';

export async function handleLocation(
  payload: LocationPayload,
  deps: {
    repo: LocationRepository;
    logger: Logger;
    reverseGeocoder: Geocoder;
    geofence: GeofenceEvaluator;
    eventPublisher: EventPublisher;
  },
): Promise<void> {
  deps.logger.info(`Location received for tid=${payload.tid}`);
  deps.reverseGeocoder
    .reverseGeocode(payload.lat, payload.lon)
    .then(async (result) => {
      if (result.address) {
        deps.logger.info(`Address: ${result.address.displayName}`);
        await deps.repo.saveAddress(result.lat, result.lon, result.address);
      }
    })
    .catch((err) => {
      deps.logger.error(`Reverse geocode failed: ${err}`);
    });
  await deps.repo.saveLocation(payload);

  try {
    const events = await deps.geofence.evaluate(payload.tid, payload.lon, payload.lat, payload.tst);
    for (const event of events) {
      await deps.eventPublisher.publish(event);
    }
  } catch (err) {
    deps.logger.error(`Geofence evaluation failed: ${err}`);
  }
}
