import type { OwnTracksPayload } from '@/domain/types.ts';
import type { Logger } from '@/domain/ports.ts';

export function handleFallback(payload: OwnTracksPayload, deps: { logger: Logger }): void {
  deps.logger.info(`Received ${payload._type} event (no-op)`);
}
