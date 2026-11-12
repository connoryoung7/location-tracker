import { expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { Database } from 'bun:sqlite';
import { ReplayGeofence } from '@/application/replay-geofence.ts';
import { recomputeAreaEvents } from '@/application/recompute-area-events.ts';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';
import { SqliteLocationRepository } from '@/repository/location-repository/sqlite.repository.ts';
import { RedisGeofenceEvaluator } from '@/infrastructure/geofence/redis.geofence-evaluator.ts';
import { RedisAreaProjection } from '@/repository/area-repository/redis.projection.ts';
import { mockAreaRepository, mockLogger, mockMetricsCollector } from '@/test/mocks.ts';

test('recompute is repeatable, preserves pending exits and isolates other users', async () => {
  const redis = new RedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379/1');
  const db = new Database(':memory:');
  runMigrations(db);
  const repo = new SqliteLocationRepository(db);
  const userId = crypto.randomUUID();
  const area = { id: 'home', userId, name: 'Home', lat: 0, lon: 0, radius: 100 };
  const areaRepo = mockAreaRepository();
  areaRepo.listAreas.mockResolvedValue([area]);
  const projection = new RedisAreaProjection(redis);
  try {
    await projection.applyArea(area);
    for (const [tst, lon] of [
      [1, 0],
      [10, 1],
    ])
      repo.saveLocation({ _type: 'location', tid: userId, lat: 0, lon: lon!, tst: tst! });
    repo.saveAreaEvent({
      _type: 'area.entered',
      userId: 'other',
      areaId: 'x',
      lat: 0,
      lon: 0,
      tst: 1,
    });
    const evaluator = new RedisGeofenceEvaluator(redis, 30);
    const replay = new ReplayGeofence([area], 30);
    for (const [tst, lon] of [
      [1, 0],
      [10, 1],
      [39, 1],
      [40, 1],
      [50, 0],
      [60, 1],
      [70, 0],
    ]) {
      const point = { _type: 'location' as const, tid: userId, lat: 0, lon: lon!, tst: tst! };
      expect(await evaluator.evaluate(userId, point.lon, point.lat, point.tst)).toEqual(
        replay.evaluate(point),
      );
    }
    const deps = {
      redis,
      repo,
      areaRepo,
      thresholdSeconds: 30,
      logger: mockLogger(),
      metrics: mockMetricsCollector(),
    };
    expect(await recomputeAreaEvents(userId, deps)).toMatchObject({
      locations: 2,
      before: 0,
      after: 1,
    });
    expect(await recomputeAreaEvents(userId, deps)).toMatchObject({ before: 1, after: 1 });
    expect(db.query('SELECT * FROM area_events').all()).toHaveLength(2);
    const live = new RedisGeofenceEvaluator(redis, 30);
    expect(await live.evaluate(userId, 1, 0, 39)).toEqual([]);
    expect((await live.evaluate(userId, 1, 0, 40))[0]?._type).toBe('area.exited');
  } finally {
    await projection.removeArea(userId, area.id);
    redis.close();
    db.close();
  }
});
