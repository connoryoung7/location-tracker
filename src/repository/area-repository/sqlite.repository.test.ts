import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';
import { SqliteAreaRepository } from '@/repository/area-repository/sqlite.repository.ts';
import { buildArea } from '@/test/factories.ts';

let db: Database;
let repo: SqliteAreaRepository;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  repo = new SqliteAreaRepository(db);
});

afterEach(() => {
  db.close();
});

describe('SqliteAreaRepository', () => {
  test('persists an area and reads it back', async () => {
    const area = buildArea({ id: 'a1', userId: 'AB', name: 'Home', radius: 250 });

    await repo.addArea(area);

    expect(await repo.getArea('AB', 'a1')).toEqual(area);
    expect(await repo.listAreas('AB')).toEqual([area]);
  });

  test('upserts by id so re-seeding converges instead of duplicating', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB', name: 'Home', radius: 100 }));
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB', name: 'Home', radius: 999 }));

    const areas = await repo.listAreas('AB');
    expect(areas).toHaveLength(1);
    expect(areas[0]!.radius).toBe(999);
  });

  test('listAllAreas spans users; listAreas is scoped to one', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB' }));
    await repo.addArea(buildArea({ id: 'b1', userId: 'CD' }));

    expect(await repo.listAllAreas()).toHaveLength(2);
    expect(await repo.listAreas('AB')).toHaveLength(1);
  });

  test("removeArea only deletes the owner's area", async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB' }));

    // Wrong owner must not delete it, or one user could remove another's areas.
    await repo.removeArea('CD', 'a1');
    expect(await repo.getArea('AB', 'a1')).toBeDefined();

    await repo.removeArea('AB', 'a1');
    expect(await repo.getArea('AB', 'a1')).toBeUndefined();
  });

  test('getArea is scoped by user', async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB' }));

    expect(await repo.getArea('CD', 'a1')).toBeUndefined();
  });

  test('survives a reopened database, unlike the Redis-only store', async () => {
    const path = `/tmp/area-repo-${Bun.randomUUIDv7()}.db`;
    const first = new Database(path, { create: true });
    runMigrations(first);
    await new SqliteAreaRepository(first).addArea(buildArea({ id: 'a1', userId: 'AB' }));
    first.close();

    const second = new Database(path);
    const areas = await new SqliteAreaRepository(second).listAllAreas();
    second.close();

    expect(areas).toHaveLength(1);
  });
});
