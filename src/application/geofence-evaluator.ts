import type { LocationPayload, GeofenceState } from '@/domain/types.ts';
import type { EventBus, GeofenceRepository, Logger } from '@/domain/ports.ts';
import { computeTransition, haversineMeters } from '@/application/geofence-state-machine.ts';

type EvaluatorDeps = {
  geofenceRepo: GeofenceRepository;
  eventBus: EventBus;
  logger: Logger;
  now?: () => number;
};

export async function evaluateGeofences(
  payload: LocationPayload,
  deps: EvaluatorDeps,
): Promise<void> {
  const fences = await deps.geofenceRepo.list(payload.tid);
  if (fences.length === 0) return;

  const nowMs = (deps.now ?? Date.now)();

  await Promise.all(
    fences.map(async (fence) => {
      // Accuracy gate: skip junk fixes that can't reliably resolve this fence.
      if (payload.acc !== undefined && payload.acc > fence.radiusMeters * 0.5) {
        return;
      }
      const distance = haversineMeters(payload.lat, payload.lon, fence.lat, fence.lon);
      const isInside = distance <= fence.radiusMeters;
      const current: GeofenceState = (await deps.geofenceRepo.getState(fence.id, payload.tid)) ?? {
        geofenceId: fence.id,
        tid: payload.tid,
        status: 'outside',
        pendingExitAt: null,
        lastEvaluatedAt: nowMs,
      };
      const { newState, event } = computeTransition(current, isInside, nowMs, fence, payload);
      await deps.geofenceRepo.upsertState(newState);
      if (event) await deps.eventBus.publish(event);
    }),
  );
}
