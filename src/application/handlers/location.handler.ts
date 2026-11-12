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
  const ingest = async () => {
    if (deps.repo.replayState) {
      const state = await deps.repo.replayState.readReplayState(payload.tid);
      if (state) {
        if (!deps.geofence.restoreState)
          throw new Error('Geofence state restoration is unavailable');
        // Fail before saving/evaluating if Redis cannot apply committed replay state.
        // A rollback retains the handoff so the next request can retry it.
        await deps.geofence.restoreState(payload.tid, state);
        await deps.repo.replayState.clearReplayState(payload.tid);
      }
    }
    await deps.repo.saveLocation(payload);

    try {
      const events = await deps.geofence.evaluate(
        payload.tid,
        payload.lon,
        payload.lat,
        payload.tst,
      );
      for (const event of events) {
        await deps.eventPublisher.publish(event);
      }
    } catch (err) {
      deps.logger.error(`Geofence evaluation failed: ${err}`);
    }
  };
  if (deps.repo.withUserLock) await deps.repo.withUserLock(payload.tid, ingest);
  else await ingest();
}
