import type { LocationPayload } from '@/domain/types.ts';
import type {
  EventPublisher,
  UserLock,
  ReplayStateRepository,
  Geocoder,
  GeofenceEvaluator,
  LocationRepository,
  Logger,
} from '@/domain/ports.ts';

export async function handleLocation(
  payload: LocationPayload,
  deps: {
    repo: LocationRepository;
    userLock?: UserLock;
    replayState?: ReplayStateRepository;
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
  const ingest = async () => {
    try {
      if (deps.replayState) {
        const state = await deps.replayState.readReplayState(payload.tid);
        if (state) {
          if (!deps.geofence.restoreState)
            throw new Error('Geofence state restoration is unavailable');
          await deps.geofence.restoreState(payload.tid, state);
          await deps.replayState.clearReplayState(payload.tid);
        }
      }
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
  try {
    if (deps.userLock) await deps.userLock.withUserLock(payload.tid, ingest);
    else await ingest();
  } catch (error) {
    deps.logger.error('Geofence work deferred; location is persisted', error);
  }
}
