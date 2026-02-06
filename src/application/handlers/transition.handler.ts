import type { TransitionPayload } from '@/domain/types.ts';
import type { LocationRepository, Logger } from '@/domain/ports.ts';

export function handleTransition(
  payload: TransitionPayload,
  deps: { repo: LocationRepository; logger: Logger },
): void {
  deps.logger.info(`Transition: ${payload.event} region="${payload.desc ?? 'unknown'}"`);
  deps.repo.saveTransition(payload);
}
