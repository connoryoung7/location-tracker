import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { RedisClient } from 'bun';
import { Database } from 'bun:sqlite';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';
import { SqliteAreaRepository } from '@/repository/area-repository/sqlite.repository.ts';
import { RedisAreaProjection } from '@/repository/area-repository/redis.projection.ts';
import { SyncingAreaRepository } from '@/repository/area-repository/syncing.repository.ts';
import { SqliteLocationRepository } from '@/repository/location-repository/sqlite.repository.ts';
import { buildArea } from '@/test/factories.ts';
import { mockLogger } from '@/test/mocks.ts';
import type { AreaProjection, UserLock } from '@/domain/ports.ts';
import type { Area } from '@/domain/types.ts';

/**
 * A Redis projection whose next write waits until released, to hold a write
 * mid-flight between its source and index steps while another one starts.
 */
class HeldProjection extends RedisAreaProjection {
  private gate = Promise.withResolvers<void>();
  private isNextWriteHeld = false;

  holdNextWrite(): void {
    this.gate = Promise.withResolvers<void>();
    this.isNextWriteHeld = true;
  }

  release(): void {
    this.gate.resolve();
  }

  override async applyArea(area: Area): Promise<void> {
    await this.waitIfHeld();
    return super.applyArea(area);
  }

  override async removeArea(userId: string, areaId: string): Promise<void> {
    await this.waitIfHeld();
    return super.removeArea(userId, areaId);
  }

  private async waitIfHeld(): Promise<void> {
    if (!this.isNextWriteHeld) return;
    this.isNextWriteHeld = false;
    await this.gate.promise;
  }
}

/** Lets pending promise callbacks and timers run, so a started write reaches its next await. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// Defaults to db index 1 so the FLUSHDB below cannot wipe the dev Redis (db 0),
// which persists real area data via --appendonly.
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/1';

describe('SyncingAreaRepository', () => {
  let redis: RedisClient;
  let db: Database;
  let source: SqliteAreaRepository;
  let projection: RedisAreaProjection;
  let userLock: SqliteLocationRepository;
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
    // The location repository over the same database, as every entrypoint wires it.
    userLock = new SqliteLocationRepository(db);
    repo = new SyncingAreaRepository(source, projection, redis, mockLogger(), userLock);
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
    const syncing = new SyncingAreaRepository(source, flaky, redis, logger, userLock);

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

  test('a user whose dirty marker could not reach Redis is still repaired later', async () => {
    let failSadd = true;
    const flakyRedis = new Proxy(redis, {
      get(target, prop) {
        if (prop === 'sadd') {
          return (...args: Parameters<RedisClient['sadd']>) => {
            if (failSadd) return Promise.reject(new Error('redis down'));
            return target.sadd(...args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
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
    const syncing = new SyncingAreaRepository(source, flaky, flakyRedis, mockLogger(), userLock);

    await syncing.addArea(buildArea({ id: 'a1', userId: 'AB' }));
    expect(await redis.smembers('area:projection-dirty')).toEqual([]);
    expect(await projection.listAllAreas()).toEqual([]);

    // Redis is back; the in-process marker drives the repair.
    failSadd = false;
    await syncing.listAllAreas();

    expect(await projection.listAllAreas()).toHaveLength(1);
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

  test('an edit lands in both, and keeps live geofence membership', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB', name: 'Home', radius: 100 }));
    await redis.sadd('geofence:inside:AB', 'a1');

    const isUpdated = await repo.updateArea(
      buildArea({ id: 'a1', userId: 'AB', name: 'Gym', radius: 250 }),
    );

    expect(isUpdated).toBe(true);
    expect(await source.getArea('AB', 'a1')).toMatchObject({ name: 'Gym', radius: 250 });
    // Redis keeps positions as geohashes, so only the metadata compares exactly.
    const projected = await projection.listAllAreas();
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ id: 'a1', userId: 'AB', name: 'Gym', radius: 250 });
    expect(await redis.get('area:maxradius:AB')).toBe('250');
    // Still inside after the edit: the next location must not fire a duplicate enter.
    expect(await redis.sismember('geofence:inside:AB', 'a1')).toBe(true);
  });

  test('a rename whose index write fails reaches the geofence once the user is repaired', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB', name: 'Hom' }));
    const flaky: AreaProjection = {
      applyArea: () => Promise.reject(new Error('redis down')),
      removeArea: (userId, areaId) => projection.removeArea(userId, areaId),
      replaceUserAreas: (userId, areas) => projection.replaceUserAreas(userId, areas),
      replaceAll: (areas) => projection.replaceAll(areas),
      listAllAreas: () => projection.listAllAreas(),
      healthCheck: () => projection.healthCheck(),
    };
    const syncing = new SyncingAreaRepository(source, flaky, redis, mockLogger(), userLock);

    expect(await syncing.updateArea(buildArea({ id: 'a1', userId: 'AB', name: 'Home' }))).toBe(
      true,
    );

    // Live events would still say "Hom" until the repair runs.
    expect((await projection.listAllAreas())[0]).toMatchObject({ name: 'Hom' });
    expect(await redis.smembers('area:projection-dirty')).toEqual(['AB']);

    // The repair re-projects the user from the store with replaceUserAreas.
    await syncing.listAllAreas();

    expect((await projection.listAllAreas())[0]).toMatchObject({ id: 'a1', name: 'Home' });
    expect(await redis.smembers('area:projection-dirty')).toEqual([]);
  });

  test('an edit of a missing area touches neither store', async () => {
    const isUpdated = await repo.updateArea(buildArea({ id: 'a1', userId: 'AB' }));

    expect(isUpdated).toBe(false);
    expect(await source.listAllAreas()).toEqual([]);
    expect(await projection.listAllAreas()).toEqual([]);
  });

  test('edits finishing out of order still leave the index on the latest circle', async () => {
    const held = new HeldProjection(redis);
    const syncing = new SyncingAreaRepository(source, held, redis, mockLogger(), userLock);
    await syncing.addArea(buildArea({ id: 'a1', userId: 'AB', radius: 100 }));

    // Edit A stalls between its store and index writes; edit B starts meanwhile.
    held.holdNextWrite();
    const editA = syncing.updateArea(buildArea({ id: 'a1', userId: 'AB', radius: 200 }));
    await settle();
    const editB = syncing.updateArea(buildArea({ id: 'a1', userId: 'AB', radius: 300 }));
    await settle();
    held.release();
    await Promise.all([editA, editB]);

    expect(await source.getArea('AB', 'a1')).toMatchObject({ radius: 300 });
    expect((await held.listAllAreas())[0]).toMatchObject({ id: 'a1', radius: 300 });
    expect(await redis.get('area:maxradius:AB')).toBe('300');
  });

  test('a delete during an edit is not undone in the index', async () => {
    const held = new HeldProjection(redis);
    const syncing = new SyncingAreaRepository(source, held, redis, mockLogger(), userLock);
    await syncing.addArea(buildArea({ id: 'a1', userId: 'AB' }));

    held.holdNextWrite();
    const edit = syncing.updateArea(buildArea({ id: 'a1', userId: 'AB', name: 'Gym' }));
    await settle();
    const remove = syncing.removeArea('AB', 'a1');
    await settle();
    held.release();
    await Promise.all([edit, remove]);

    expect(await source.listAllAreas()).toEqual([]);
    expect(await held.listAllAreas()).toEqual([]);
  });

  test('a write whose commit fails after the index was updated leaves the user dirty', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB', radius: 100 }));
    // The store write commits with the lock, after the index already took the edit.
    const failingCommit: UserLock = {
      withUserLock: async (_userId, work) => {
        db.run('BEGIN');
        await work();
        db.run('ROLLBACK');
        throw new Error('database is locked');
      },
    };
    const syncing = new SyncingAreaRepository(
      source,
      projection,
      redis,
      mockLogger(),
      failingCommit,
    );

    await expect(
      syncing.updateArea(buildArea({ id: 'a1', userId: 'AB', radius: 250 })),
    ).rejects.toThrow('database is locked');

    expect(await source.getArea('AB', 'a1')).toMatchObject({ radius: 100 });
    expect(await redis.smembers('area:projection-dirty')).toEqual(['AB']);

    // The next read rebuilds the index from what the store really holds.
    await syncing.listAreas('AB');

    expect((await projection.listAllAreas())[0]).toMatchObject({ id: 'a1', radius: 100 });
    expect(await redis.smembers('area:projection-dirty')).toEqual([]);
  });

  test('a write landing during a repair keeps the user dirty until a clean repair', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB', radius: 100 }));
    await redis.sadd('area:projection-dirty', 'AB');
    // The repair reads radius 100; an edit to 250 then lands before it writes Redis.
    let isFirstRepair = true;
    const racing: AreaProjection = {
      applyArea: (area) => projection.applyArea(area),
      removeArea: (userId, areaId) => projection.removeArea(userId, areaId),
      replaceUserAreas: async (userId, areas) => {
        if (isFirstRepair) {
          isFirstRepair = false;
          await syncing.updateArea(buildArea({ id: 'a1', userId: 'AB', radius: 250 }));
        }
        return projection.replaceUserAreas(userId, areas);
      },
      replaceAll: (areas) => projection.replaceAll(areas),
      listAllAreas: () => projection.listAllAreas(),
      healthCheck: () => projection.healthCheck(),
    };
    const syncing = new SyncingAreaRepository(source, racing, redis, mockLogger(), userLock);

    await syncing.listAreas('AB');

    // The repair wrote its older snapshot, so it must not call the user clean.
    expect(await redis.smembers('area:projection-dirty')).toEqual(['AB']);

    await syncing.listAreas('AB');

    expect((await projection.listAllAreas())[0]).toMatchObject({ id: 'a1', radius: 250 });
    expect(await redis.smembers('area:projection-dirty')).toEqual([]);
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
      userLock,
    );

    expect(syncing.healthCheck()).rejects.toThrow();
    dead.close();
  });
});
