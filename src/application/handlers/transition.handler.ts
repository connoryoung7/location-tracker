import type { TransitionPayload } from '@/domain/types.ts';
import type { EventPublisher, LocationRepository, Logger } from '@/domain/ports.ts';
import type { UserWaypointUpdatedEvent } from '@/domain/events.ts';

export async function handleTransition(
  payload: TransitionPayload,
  deps: { repo: LocationRepository; logger: Logger; eventPublisher: EventPublisher },
): Promise<void> {
  deps.logger.info(`Transition: ${payload.event} region="${payload.desc ?? 'unknown'}"`);
  await deps.repo.saveTransition(payload);

  const event: UserWaypointUpdatedEvent = {
    _type: 'user-waypoint.updated',
    update_type: payload.event,
    waypoint: {
      _type: 'waypoint',
      desc: payload.desc ?? '',
      tst: payload.wtst,
      rid: payload.rid,
    },
    transition_tst: payload.tst,
  };
  await deps.eventPublisher.publish(event);
}
