import type { LocationPayload } from '@/domain/types.ts';
import type { LocationRepository, Logger, ReverseGeocoder } from '@/domain/ports.ts';

export async function handleLocation(
  payload: LocationPayload,
  deps: { repo: LocationRepository; logger: Logger; reverseGeocoder: ReverseGeocoder },
): Promise<void> {
  deps.logger.info(`Location: lat=${payload.lat} lon=${payload.lon} tid=${payload.tid}`);
  deps.reverseGeocoder.reverseGeocode(payload.lat, payload.lon).then(async (result) => {
    if (result.address) {
      deps.logger.info(`Address: ${result.address.displayName}`);
      await deps.repo.saveAddress(result.lat, result.lon, result.address);
    }
  }).catch((err) => {
    deps.logger.error(`Reverse geocode failed: ${err}`);
  });
  await deps.repo.saveLocation(payload);
}
