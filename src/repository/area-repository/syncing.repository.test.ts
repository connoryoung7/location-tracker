import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { RedisClient } from 'bun';
import { Database } from 'bun:sqlite';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';
import { SqliteAreaRepository } from '@/repository/area-repository/sqlite.repository.ts';
import { RedisAreaProjection } from '@/repository/area-repository/redis.projection.ts';
import { SyncingAreaRepository } from '@/repository/area-repository/syncing.repository.ts';
import { buildArea } from '@/test/factories.ts';
import { mockLogger } from '@/test/mocks.ts';
import type { AreaProjection } from '@/domain/ports.ts';

// Defaults to db index 1 so the FLUSHDB below cannot wipe the dev Redis (db 0),
// which persists real area data via --appendonly.
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/1';

describe('SyncingAreaRepository', () => {
  let redis: RedisClient;
  let db: Database;
  let source: SqliteAreaRepository;
  let projection: RedisAreaProjection;
  let repo: SyncingAreaRepository;

  beforeAll(async () => {
    redis = new RedisClient(REDIS_URL);
    await redis.connect();
  });

  afterAll(() => {
    redis.close();
  });

  beforeEach(async () => {
    await redis.send('FLUSHDB', []);
    db = new Database(':memory:');
    runMigrations(db);
    source = new SqliteAreaRepository(db);
    projection = new RedisAreaProjection(redis);
    repo = new SyncingAreaRepository(source, projection, redis, mockLogger());
  });

  test('a write lands in both the store and the Redis index', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB', radius: 300 }));

    expect(await source.listAllAreas()).toHaveLength(1);
    expect(await projection.listAllAreas()).toHaveLength(1);
    // maxradius bounds the GEOSEARCH; without it the Lua matches nothing.
    expect(await redis.get('area:maxradius:AB')).toBe('300');
  });

  test('a delete clears both', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB' }));
    await repo.removeArea('AB', 'a1');

    expect(await source.listAllAreas()).toEqual([]);
    expect(await projection.listAllAreas()).toEqual([]);
  });

  test('reads come from the store, not the index', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB' }));
    // Wipe the index only; the store is still authoritative.
    await redis.send('FLUSHDB', []);

    expect(await repo.listAllAreas()).toHaveLength(1);
  });

  test('rebuildProjection restores an index wiped out from under it', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB' }));
    await redis.send('FLUSHDB', []);
    expect(await projection.listAllAreas()).toEqual([]);

    await repo.rebuildProjection();

    expect(await projection.listAllAreas()).toHaveLength(1);
  });

  test('rebuildProjection drops areas the store no longer owns', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB' }));
    // Delete straight from the store, as if it happened in another process.
    source.removeArea('AB', 'a1');

    await repo.rebuildProjection();

    expect(await projection.listAllAreas()).toEqual([]);
  });

  test('a failed index write still commits to the store and is repaired on read', async () => {
    const logger = mockLogger();
    let failNextApply = true;
    const flaky: AreaProjection = {
      applyArea: (area) => {
        if (failNextApply) {
          failNextApply = false;
          return Promise.reject(new Error('redis down'));
        }
        return projection.applyArea(area);
      },
      removeArea: (userId, areaId) => projection.removeArea(userId, areaId),
      replaceUserAreas: (userId, areas) => projection.replaceUserAreas(userId, areas),
      replaceAll: (areas) => projection.replaceAll(areas),
      listAllAreas: () => projection.listAllAreas(),
      healthCheck: () => projection.healthCheck(),
    };
    const syncing = new SyncingAreaRepository(source, flaky, redis, logger);

    await syncing.addArea(buildArea({ id: 'a1', userId: 'AB' }));

    // The store committed even though the projection write threw.
    expect(await source.listAllAreas()).toHaveLength(1);
    expect(await projection.listAllAreas()).toEqual([]);
    expect(await redis.smembers('area:projection-dirty')).toEqual(['AB']);
    expect(logger.error).toHaveBeenCalled();

    // A read repairs the drift and clears the marker.
    await syncing.listAllAreas();

    expect(await projection.listAllAreas()).toHaveLength(1);
    expect(await redis.smembers('area:projection-dirty')).toEqual([]);
  });

  test('initialize imports areas that exist only in Redis', async () => {
    // Simulates the cutover: areas were Redis-only before the store existed.
    await projection.applyArea(buildArea({ id: 'legacy', userId: 'AB', name: 'Old Home' }));
    expect(await source.listAllAreas()).toEqual([]);

    await repo.initialize();

    const imported = await source.listAllAreas();
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ id: 'legacy', userId: 'AB', name: 'Old Home' });
    // And it survives the rebuild that follows the import.
    expect(await projection.listAllAreas()).toHaveLength(1);
  });

  test('initialize does not import once the store owns areas', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB' }));
    // A stale Redis-only area must not be resurrected into a populated store.
    await projection.applyArea(buildArea({ id: 'ghost', userId: 'ZZ' }));

    await repo.initialize();

    const ids = (await source.listAllAreas()).map((area) => area.id);
    expect(ids).toEqual(['a1']);
    // The rebuild also evicts the ghost from the index.
    expect((await projection.listAllAreas()).map((area) => area.id)).toEqual(['a1']);
  });

  test('initialize is idempotent across restarts', async () => {
    await projection.applyArea(buildArea({ id: 'legacy', userId: 'AB' }));

    await repo.initialize();
    await repo.initialize();

    expect(await source.listAllAreas()).toHaveLength(1);
  });

  test('a rebuild does not disturb live geofence membership', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB' }));
    // The user is already inside; a rebuild must not make them re-enter and
    // emit a duplicate event.
    await redis.sadd('geofence:inside:AB', 'a1');

    await repo.rebuildProjection();

    expect(await redis.sismember('geofence:inside:AB', 'a1')).toBe(true);
  });

  test('a rebuild forgets membership for areas that no longer exist', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB' }));
    await redis.sadd('geofence:inside:AB', 'deleted-area');

    await repo.rebuildProjection();

    expect(await redis.sismember('geofence:inside:AB', 'deleted-area')).toBe(false);
  });

  test('healthCheck fails when the index is unreachable', async () => {
    const dead = new RedisClient('redis://127.0.0.1:1', {
      maxRetries: 0,
      enableOfflineQueue: false,
    });
    const syncing = new SyncingAreaRepository(
      source,
      new RedisAreaProjection(dead),
      redis,
      mockLogger(),
    );

    expect(syncing.healthCheck()).rejects.toThrow();
    dead.close();
  });
});
