import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { RedisClient } from 'bun';
import { Database } from 'bun:sqlite';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';
import { SqliteAreaRepository } from '@/repository/area-repository/sqlite.repository.ts';
import { RedisAreaProjection } from '@/repository/area-repository/redis.projection.ts';
import { SyncingAreaRepository } from '@/repository/area-repository/syncing.repository.ts';
import { RedisAreaLock } from '@/repository/area-repository/redis.area-lock.ts';
import { buildArea } from '@/test/factories.ts';
import { mockLogger } from '@/test/mocks.ts';
import type { AreaProjection } from '@/domain/ports.ts';
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
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

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

  test('a failed index write still commits to the store and is repaired on the next pass', async () => {
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
      listProjectedUserIds: () => projection.listProjectedUserIds(),
      healthCheck: () => projection.healthCheck(),
    };
    const syncing = new SyncingAreaRepository(source, flaky, redis, logger);

    await syncing.addArea(buildArea({ id: 'a1', userId: 'AB' }));

    // The store committed even though the projection write threw.
    expect(await source.listAllAreas()).toHaveLength(1);
    expect(await projection.listAllAreas()).toEqual([]);
    expect(await redis.smembers('area:projection-dirty')).toEqual(['AB']);
    expect(logger.error).toHaveBeenCalled();

    // A repair pass rebuilds the user and clears the marker.
    await syncing.repairDrift();

    expect(await projection.listAllAreas()).toHaveLength(1);
    expect(await redis.smembers('area:projection-dirty')).toEqual([]);
  });

  test('a user whose dirty marker could not reach Redis is still repaired later', async () => {
    let failMarkDirty = true;
    const flakyRedis = new Proxy(redis, {
      get(target, prop) {
        if (prop === 'send') {
          // Marking dirty runs a script that bumps the user's dirty count.
          return (command: string, args: string[]) => {
            const isMarkDirty = command === 'EVAL' && args[0]!.includes('HINCRBY');
            if (failMarkDirty && isMarkDirty) return Promise.reject(new Error('redis down'));
            return target.send(command, args);
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
      listProjectedUserIds: () => projection.listProjectedUserIds(),
      healthCheck: () => projection.healthCheck(),
    };
    const syncing = new SyncingAreaRepository(source, flaky, flakyRedis, mockLogger());

    await syncing.addArea(buildArea({ id: 'a1', userId: 'AB' }));
    expect(await redis.smembers('area:projection-dirty')).toEqual([]);
    expect(await projection.listAllAreas()).toEqual([]);

    // Redis is back; the in-process marker drives the repair.
    failMarkDirty = false;
    await syncing.repairDrift();

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
      listProjectedUserIds: () => projection.listProjectedUserIds(),
      healthCheck: () => projection.healthCheck(),
    };
    const syncing = new SyncingAreaRepository(source, flaky, redis, mockLogger());

    expect(await syncing.updateArea(buildArea({ id: 'a1', userId: 'AB', name: 'Home' }))).toBe(
      true,
    );

    // Live events would still say "Hom" until the repair runs.
    expect((await projection.listAllAreas())[0]).toMatchObject({ name: 'Hom' });
    expect(await redis.smembers('area:projection-dirty')).toEqual(['AB']);

    // The repair re-projects the user from the store with replaceUserAreas.
    await syncing.repairDrift();

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
    const syncing = new SyncingAreaRepository(source, held, redis, mockLogger());
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
    const syncing = new SyncingAreaRepository(source, held, redis, mockLogger());
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

  test('an edit whose lock expired mid-write leaves the user dirty, so a delete it overwrote is repaired', async () => {
    const held = new HeldProjection(redis);
    const stalling = new SyncingAreaRepository(source, held, redis, mockLogger());
    await stalling.addArea(buildArea({ id: 'a1', userId: 'AB' }));

    held.holdNextWrite();
    const edit = stalling.updateArea(buildArea({ id: 'a1', userId: 'AB', name: 'Gym' }));
    await settle();
    // The edit stalls past its lock's expiry, and a delete gets in.
    await redis.del('area:lock:AB');
    await repo.removeArea('AB', 'a1');
    held.release();
    await edit;

    // The stalled edit wrote the deleted area back, but knows it lost the lock.
    expect(await source.listAllAreas()).toEqual([]);
    expect(await redis.smembers('area:projection-dirty')).toEqual(['AB']);

    await repo.repairDrift();

    expect(await projection.listAllAreas()).toEqual([]);
    expect(await redis.smembers('area:projection-dirty')).toEqual([]);
  });

  test('a store write that fails never reaches the index', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB', radius: 100 }));
    const failing = Object.create(source) as SqliteAreaRepository;
    failing.updateArea = () => {
      throw new Error('database is locked');
    };
    const syncing = new SyncingAreaRepository(failing, projection, redis, mockLogger());

    await expect(
      syncing.updateArea(buildArea({ id: 'a1', userId: 'AB', radius: 250 })),
    ).rejects.toThrow('database is locked');

    expect((await projection.listAllAreas())[0]).toMatchObject({ radius: 100 });
    expect(await redis.smembers('area:projection-dirty')).toEqual([]);
  });

  test('with Redis unreachable for the lock, a write still reaches the store and is repaired later', async () => {
    const lockless = new Proxy(redis, {
      get(target, prop) {
        if (prop === 'send') {
          return (command: string, args: string[]) =>
            command === 'SET'
              ? Promise.reject(new Error('redis down'))
              : target.send(command, args);
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const syncing = new SyncingAreaRepository(source, projection, lockless, mockLogger());

    await syncing.addArea(buildArea({ id: 'a1', userId: 'AB' }));

    // Saved, but the index was not written without the lock.
    expect(await source.listAllAreas()).toHaveLength(1);
    expect(await projection.listAllAreas()).toEqual([]);
    expect(await redis.smembers('area:projection-dirty')).toEqual(['AB']);

    await repo.repairDrift();

    expect(await projection.listAllAreas()).toHaveLength(1);
  });

  test('a mark made while a repair holds an older snapshot survives that repair', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB', radius: 100 }));
    await redis.sadd('area:projection-dirty', 'AB');
    // A writer that gives up on the lock writes the store alone and marks the
    // user dirty; here it does so after the repair has read radius 100.
    const lockless = new Proxy(redis, {
      get(target, prop) {
        if (prop === 'send') {
          return (command: string, args: string[]) =>
            command === 'SET'
              ? Promise.reject(new Error('redis down'))
              : target.send(command, args);
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const storeOnlyWriter = new SyncingAreaRepository(source, projection, lockless, mockLogger());
    let isFirstRepair = true;
    const racing: AreaProjection = {
      applyArea: (area) => projection.applyArea(area),
      removeArea: (userId, areaId) => projection.removeArea(userId, areaId),
      replaceUserAreas: async (userId, areas) => {
        if (isFirstRepair) {
          isFirstRepair = false;
          await storeOnlyWriter.updateArea(buildArea({ id: 'a1', userId: 'AB', radius: 250 }));
        }
        return projection.replaceUserAreas(userId, areas);
      },
      replaceAll: (areas) => projection.replaceAll(areas),
      listAllAreas: () => projection.listAllAreas(),
      listProjectedUserIds: () => projection.listProjectedUserIds(),
      healthCheck: () => projection.healthCheck(),
    };
    const repairer = new SyncingAreaRepository(source, racing, redis, mockLogger());

    await repairer.repairDrift();

    // The repair wrote its older snapshot, so the newer mark must still stand.
    expect((await projection.listAllAreas())[0]).toMatchObject({ radius: 100 });
    expect(await redis.smembers('area:projection-dirty')).toEqual(['AB']);

    await repairer.repairDrift();

    expect((await projection.listAllAreas())[0]).toMatchObject({ radius: 250 });
    expect(await redis.smembers('area:projection-dirty')).toEqual([]);
  });

  test('a repair waits for the user lock, and leaves the user dirty while it is busy', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB' }));
    await projection.replaceUserAreas('AB', []);
    await redis.sadd('area:projection-dirty', 'AB');
    const holding = Promise.withResolvers<void>();
    const holder = new RedisAreaLock(redis, mockLogger()).withLock(
      'AB',
      () => holding.promise,
      1_000,
    );
    await settle();

    // A write holds the lock, so the repair gives up rather than race it.
    await repo.repairDrift();
    expect(await projection.listAllAreas()).toEqual([]);
    expect(await redis.smembers('area:projection-dirty')).toEqual(['AB']);

    holding.resolve();
    await holder;
    await repo.repairDrift();

    expect(await projection.listAllAreas()).toHaveLength(1);
    expect(await redis.smembers('area:projection-dirty')).toEqual([]);
  });

  test('reads never repair', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB' }));
    await projection.replaceUserAreas('AB', []);
    await redis.sadd('area:projection-dirty', 'AB');

    expect(await repo.listAreas('AB')).toHaveLength(1);
    await repo.listAllAreas();

    expect(await projection.listAllAreas()).toEqual([]);
    expect(await redis.smembers('area:projection-dirty')).toEqual(['AB']);
  });

  test('the repair timer heals a dirty user with no one reading', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB' }));
    await projection.replaceUserAreas('AB', []);
    await redis.sadd('area:projection-dirty', 'AB');

    repo.startRepairing(20);
    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((await redis.smembers('area:projection-dirty')).length === 0) break;
        await settle();
      }
    } finally {
      repo.stopRepairing();
    }

    expect(await projection.listAllAreas()).toHaveLength(1);
    expect(await redis.smembers('area:projection-dirty')).toEqual([]);
  });

  test('a rebuild covers users only the index or the dirty set knows about', async () => {
    await projection.applyArea(buildArea({ id: 'gone', userId: 'CD' }));
    await redis.sadd('area:projection-dirty', 'EF');

    await repo.rebuildProjection();

    expect(await projection.listAllAreas()).toEqual([]);
    expect(await redis.smembers('area:projection-dirty')).toEqual([]);
  });

  test('a rebuild clears a slice left half-written, which no longer reads back as areas', async () => {
    // A delete whose Redis write failed after removing the position: the
    // metadata, the max radius and membership are left behind.
    await projection.applyArea(buildArea({ id: 'gone', userId: 'CD', radius: 500 }));
    await redis.sadd('geofence:inside:CD', 'gone');
    await redis.zrem('geo:areas:CD', 'gone');
    expect(await projection.listAllAreas()).toEqual([]);

    await repo.rebuildProjection();

    expect(await redis.hgetall('area:meta:CD')).toEqual({});
    expect(await redis.get('area:maxradius:CD')).toBeNull();
    expect(await redis.sismember('geofence:inside:CD', 'gone')).toBe(false);
  });

  test("a rebuild leaves a user it can't reach dirty for the repair timer, rather than failing", async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB' }));
    const holding = Promise.withResolvers<void>();
    const holder = new RedisAreaLock(redis, mockLogger()).withLock(
      'AB',
      () => holding.promise,
      1_000,
    );
    await settle();

    await repo.rebuildProjection();
    expect(await redis.smembers('area:projection-dirty')).toEqual(['AB']);

    holding.resolve();
    await holder;
    await repo.repairDrift();
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
    );

    expect(syncing.healthCheck()).rejects.toThrow();
    dead.close();
  });
});
