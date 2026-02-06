import type { TransitionPayload } from '@/domain/types.ts';
import type { LocationRepository, Logger } from '@/domain/ports.ts';

export async function handleTransition(
  payload: TransitionPayload,
  deps: { repo: LocationRepository; logger: Logger },
): Promise<void> {
  deps.logger.info(`Transition: ${payload.event} region="${payload.desc ?? 'unknown'}"`);
  await deps.repo.saveTransition(payload);
}
