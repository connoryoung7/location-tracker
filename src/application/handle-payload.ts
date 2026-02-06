import type { OwnTracksPayload } from '@/domain/types.ts';
import type { LocationRepository, Logger } from '@/domain/ports.ts';
import { handleLocation } from '@/application/handlers/location.handler.ts';
import { handleTransition } from '@/application/handlers/transition.handler.ts';
import { handleFallback } from '@/application/handlers/fallback.handler.ts';

export interface Deps {
  repo: LocationRepository;
  logger: Logger;
}

export async function handlePayload(payload: OwnTracksPayload, deps: Deps): Promise<void> {
  switch (payload._type) {
    case 'location':
      await handleLocation(payload, deps);
      break;
    case 'transition':
      await handleTransition(payload, deps);
      break;
    default:
      handleFallback(payload, deps);
      break;
  }
}
