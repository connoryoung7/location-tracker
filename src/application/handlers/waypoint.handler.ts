import type { WaypointPayload } from '@/domain/types.ts';
import type { LocationRepository, Logger } from '@/domain/ports.ts';

export async function handleWaypoint(
  payload: WaypointPayload,
  deps: { repo: LocationRepository; logger: Logger },
): Promise<void> {
  deps.logger.info(`Waypoint: desc="${payload.desc}" rid="${payload.rid ?? 'unknown'}"`);
  await deps.repo.saveWaypoint(payload);
}
