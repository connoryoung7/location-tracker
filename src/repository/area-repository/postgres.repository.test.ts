import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { PostgresAreaRepository } from '@/repository/area-repository/postgres.repository.ts';
import { PostgresLocationRepository } from '@/repository/location-repository/postgres.repository.ts';
import { buildArea } from '@/test/factories.ts';

// Use a dedicated throwaway database: this suite clears its tables.
const url = process.env.TEST_POSTGRES_URL;
describe.skipIf(!url)('PostgresAreaRepository', () => {
  let sql: SQL;
  let repo: PostgresAreaRepository;

  beforeAll(async () => {
    sql = new SQL(url!);
    // The location repository owns the schema, the areas table included.
    await new PostgresLocationRepository(sql).migrate();
    repo = new PostgresAreaRepository(sql);
  });
  beforeEach(async () => {
    await sql`TRUNCATE areas`;
  });
  afterAll(async () => {
    await sql.close();
  });

  test("updateArea changes an existing area's name and circle in place", async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB', name: 'Home', radius: 100 }));

    const isUpdated = await repo.updateArea(
      buildArea({ id: 'a1', userId: 'AB', name: 'Gym', lat: 42.35, lon: -71.06, radius: 80 }),
    );

    expect(isUpdated).toBe(true);
    expect(await repo.listAllAreas()).toEqual([
      buildArea({ id: 'a1', userId: 'AB', name: 'Gym', lat: 42.35, lon: -71.06, radius: 80 }),
    ]);
  });

  test("updateArea never inserts: an unknown, deleted, or other user's area is left alone", async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB', name: 'Home' }));

    expect(await repo.updateArea(buildArea({ id: 'nope', userId: 'AB' }))).toBe(false);
    expect(await repo.updateArea(buildArea({ id: 'a1', userId: 'CD', name: 'Stolen' }))).toBe(
      false,
    );
    expect(await repo.listAllAreas()).toEqual([
      buildArea({ id: 'a1', userId: 'AB', name: 'Home' }),
    ]);

    // A delete that wins the race must stay deleted.
    await repo.removeArea('AB', 'a1');
    expect(await repo.updateArea(buildArea({ id: 'a1', userId: 'AB', name: 'Back?' }))).toBe(false);
    expect(await repo.listAllAreas()).toEqual([]);
  });

  test("a write under the user lock reuses the lock's connection, even from a one-connection pool", async () => {
    const single = new SQL({ url: url!, max: 1 });
    const lock = new PostgresLocationRepository(single);
    const areas = new PostgresAreaRepository(single);
    try {
      await areas.addArea(buildArea({ id: 'a1', userId: 'AB', radius: 100 }));

      // The lock holds the only connection: a write sent to the pool would wait forever.
      const isUpdated = await lock.withUserLock('AB', async () =>
        areas.updateArea(buildArea({ id: 'a1', userId: 'AB', radius: 200 })),
      );

      expect(isUpdated).toBe(true);
      expect(await areas.getArea('AB', 'a1')).toMatchObject({ radius: 200 });
    } finally {
      await single.close();
    }
  });

  test('waitMs caps waiting for the advisory lock below the 250 ms default', async () => {
    const lock = new PostgresLocationRepository(sql);
    const holding = Promise.withResolvers<void>();
    const locked = Promise.withResolvers<void>();
    const holder = lock.withUserLock('AB', async () => {
      locked.resolve();
      await holding.promise;
    });
    await locked.promise;
    try {
      const startedAt = performance.now();
      await expect(lock.withUserLock('AB', async () => {}, { waitMs: 20 })).rejects.toThrow();
      expect(performance.now() - startedAt).toBeLessThan(200);
    } finally {
      holding.resolve();
      await holder;
    }
  });

  test('a write under the user lock commits or rolls back with it', async () => {
    const lock = new PostgresLocationRepository(sql);
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB', radius: 100 }));

    await expect(
      lock.withUserLock('AB', async () => {
        await repo.updateArea(buildArea({ id: 'a1', userId: 'AB', radius: 200 }));
        throw new Error('interrupted before commit');
      }),
    ).rejects.toThrow('interrupted before commit');

    expect(await repo.getArea('AB', 'a1')).toMatchObject({ radius: 100 });
  });
});
