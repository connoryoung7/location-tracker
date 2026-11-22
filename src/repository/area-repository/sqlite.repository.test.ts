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

  test("updateArea changes an existing area's name and circle in place", async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB', name: 'Home', radius: 100 }));

    const isUpdated = repo.updateArea(
      buildArea({ id: 'a1', userId: 'AB', name: 'Gym', lat: 42.35, lon: -71.06, radius: 80 }),
    );

    expect(isUpdated).toBe(true);
    expect(await repo.listAllAreas()).toEqual([
      buildArea({ id: 'a1', userId: 'AB', name: 'Gym', lat: 42.35, lon: -71.06, radius: 80 }),
    ]);
  });

  test("updateArea never inserts: an unknown, deleted, or other user's area is left alone", async () => {
    await repo.addArea(buildArea({ id: 'a1', userId: 'AB', name: 'Home' }));

    expect(repo.updateArea(buildArea({ id: 'nope', userId: 'AB' }))).toBe(false);
    expect(repo.updateArea(buildArea({ id: 'a1', userId: 'CD', name: 'Stolen' }))).toBe(false);
    expect(await repo.listAllAreas()).toEqual([
      buildArea({ id: 'a1', userId: 'AB', name: 'Home' }),
    ]);

    // A delete that wins the race must stay deleted.
    await repo.removeArea('AB', 'a1');
    expect(repo.updateArea(buildArea({ id: 'a1', userId: 'AB', name: 'Back?' }))).toBe(false);
    expect(await repo.listAllAreas()).toEqual([]);
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

  describe('categories', () => {
    beforeEach(() => {
      db.run(`INSERT INTO area_categories (id, user_id, name, color) VALUES
        ('gym', 'AB', 'Gym', 'blue'), ('work', 'AB', 'Work', 'orange')`);
    });

    test('an area reads back with its category, and without one when uncategorised', async () => {
      await repo.addArea(buildArea({ id: 'a1', categoryId: 'gym' }));
      await repo.addArea(buildArea({ id: 'a2', name: 'Park' }));

      expect((await repo.getArea('AB', 'a1'))!.categoryId).toBe('gym');
      // Absent, not null, so it matches areas from the Redis projection.
      expect(await repo.getArea('AB', 'a2')).not.toHaveProperty('categoryId');
    });

    test('re-upserting an area without a category keeps the one it has', async () => {
      await repo.addArea(buildArea({ id: 'a1', categoryId: 'gym' }));

      // As re-running a seed or the cutover import does.
      await repo.addArea(buildArea({ id: 'a1', radius: 300 }));

      const area = (await repo.getArea('AB', 'a1'))!;
      expect(area.radius).toBe(300);
      expect(area.categoryId).toBe('gym');
    });

    test("editing an area's name and circle keeps its category", async () => {
      await repo.addArea(buildArea({ id: 'a1', categoryId: 'gym' }));

      // The edit form sends no category, as PUT /areas/:userId/:areaId does.
      expect(await repo.updateArea(buildArea({ id: 'a1', name: 'Moved', radius: 400 }))).toBe(true);

      expect((await repo.getArea('AB', 'a1'))!.categoryId).toBe('gym');
    });

    test('setAreaCategory changes and clears the category, for the owner only', async () => {
      await repo.addArea(buildArea({ id: 'a1' }));

      expect(await repo.setAreaCategory('AB', 'a1', 'work')).toBe(true);
      expect((await repo.getArea('AB', 'a1'))!.categoryId).toBe('work');

      expect(await repo.setAreaCategory('CD', 'a1', 'gym')).toBe(false);
      expect((await repo.getArea('AB', 'a1'))!.categoryId).toBe('work');

      expect(await repo.setAreaCategory('AB', 'a1', null)).toBe(true);
      expect(await repo.getArea('AB', 'a1')).not.toHaveProperty('categoryId');

      expect(await repo.setAreaCategory('AB', 'missing', 'gym')).toBe(false);
    });
  });
});
