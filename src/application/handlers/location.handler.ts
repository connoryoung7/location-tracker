import type { LocationPayload } from '@/domain/types.ts';
import type { LocationRepository, Logger } from '@/domain/ports.ts';

export async function handleLocation(
  payload: LocationPayload,
  deps: { repo: LocationRepository; logger: Logger },
): Promise<void> {
  deps.logger.info(`Location: lat=${payload.lat} lon=${payload.lon} tid=${payload.tid}`);
  await deps.repo.saveLocation(payload);
}
