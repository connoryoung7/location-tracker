import type { RedisClient } from 'bun';
import type {
  AreaRepository,
  LocationHistoryRepository,
  Logger,
  MetricsCollector,
} from '@/domain/ports.ts';
import type { GeofenceEvent } from '@/domain/events.ts';
import { ReplayGeofence } from '@/application/replay-geofence.ts';
import { withUserLock } from '@/infrastructure/geofence/user-lock.ts';

export async function recomputeAreaEvents(
  userId: string,
  deps: {
    redis: RedisClient;
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
    let before: number;
    if (deps.repo.replayState) {
      // Commit recovery state and events together. Redis is updated by ingestion
      // after commit; an interrupted replay cannot publish uncommitted state.
      before = await deps.repo.replaceAreaEvents(userId, events, state);
    } else {
      const marker = `geofence:replay:${userId}`;
      await deps.redis.send('SET', [marker, JSON.stringify(state)]);
      try {
        before = await deps.repo.replaceAreaEvents(userId, events);
      } catch (error) {
        await deps.redis.send('DEL', [marker]);
        throw error;
      }
    }
    const result = { locations, before, after: events.length, durationMs: Date.now() - started };
    return result;
  };
  const result = await (deps.repo.withUserLock
    ? deps.repo.withUserLock(userId, recompute)
    : withUserLock(deps.redis, userId, recompute));
  result.durationMs = Date.now() - started;
  deps.logger.info('Recomputed area events', { userId, ...result });
  deps.metrics.recordRecompute?.(result.durationMs, result.locations, result.after);
  return result;
}
