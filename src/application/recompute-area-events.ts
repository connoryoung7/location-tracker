import type {
  AreaRepository,
  UserLock,
  LocationHistoryRepository,
  Logger,
  MetricsCollector,
} from '@/domain/ports.ts';
import type { GeofenceEvent } from '@/domain/events.ts';
import { ReplayGeofence } from '@/application/replay-geofence.ts';

export async function recomputeAreaEvents(
  userId: string,
  deps: {
    userLock: UserLock;
    areaRepo: AreaRepository;
    repo: LocationHistoryRepository;
    thresholdSeconds: number;
    logger: Logger;
    metrics: MetricsCollector;
  },
) {
  const started = Date.now();
  const recompute = async () => {
    const replay = new ReplayGeofence(await deps.areaRepo.listAreas(userId), deps.thresholdSeconds);
    const events: GeofenceEvent[] = [];
    let locations = 0;
    for await (const location of deps.repo.listLocations(userId)) {
      events.push(...replay.evaluate(location));
      locations++;
    }
    const state = { inside: [...replay.inside], pending: [...replay.pendingExit] };
    const before = await deps.repo.replaceAreaEvents(userId, events, state);
    const result = { locations, before, after: events.length, durationMs: Date.now() - started };
    return result;
  };
  const result = await deps.userLock.withUserLock(userId, recompute);
  result.durationMs = Date.now() - started;
  deps.logger.info('Recomputed area events', { userId, ...result });
  deps.metrics.recordRecompute?.(result.durationMs, result.locations, result.after);
  return result;
}
