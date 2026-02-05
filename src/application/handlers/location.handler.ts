import type { LocationPayload } from "../../domain/types.ts";
import type { LocationRepository, Logger } from "../../domain/ports.ts";

export function handleLocation(
  payload: LocationPayload,
  deps: { repo: LocationRepository; logger: Logger },
): void {
  deps.logger.info(
    `Location: lat=${payload.lat} lon=${payload.lon} tid=${payload.tid}`,
  );
  deps.repo.saveLocation(payload);
}
