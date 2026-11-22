import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';
import { SqliteAreaCategoryRepository } from '@/repository/area-category-repository/sqlite.repository.ts';
import { SqliteAreaRepository } from '@/repository/area-repository/sqlite.repository.ts';
import { buildArea, buildAreaCategory } from '@/test/factories.ts';

let db: Database;
let categories: SqliteAreaCategoryRepository;
let areas: SqliteAreaRepository;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  categories = new SqliteAreaCategoryRepository(db);
  areas = new SqliteAreaRepository(db);
});

afterEach(() => {
  db.close();
});

describe('SqliteAreaCategoryRepository', () => {
  test("lists only the user's own categories, by name regardless of case", async () => {
    await categories.addCategory(buildAreaCategory({ id: 'c1', name: 'work' }));
    await categories.addCategory(buildAreaCategory({ id: 'c2', name: 'Gym' }));
    await categories.addCategory(buildAreaCategory({ id: 'c3', userId: 'CD', name: 'Home' }));

    expect((await categories.listCategories('AB')).map((category) => category.name)).toEqual([
      'Gym',
      'work',
    ]);
    expect(await categories.listCategories('CD')).toEqual([
      buildAreaCategory({ id: 'c3', userId: 'CD', name: 'Home' }),
    ]);
  });

  test('a user cannot have two categories with the same name, ignoring case', async () => {
    expect(await categories.addCategory(buildAreaCategory({ id: 'c1', name: 'Gym' }))).toBe(
      'added',
    );
    expect(await categories.addCategory(buildAreaCategory({ id: 'c2', name: 'GYM' }))).toBe(
      'name-taken',
    );
    // Another user can.
    expect(
      await categories.addCategory(buildAreaCategory({ id: 'c3', userId: 'CD', name: 'gym' })),
    ).toBe('added');
  });

  test('the unique index backs the check up', () => {
    db.run(
      `INSERT INTO area_categories (id, user_id, name, color) VALUES ('c1', 'AB', 'Gym', 'blue')`,
    );

    expect(() =>
      db.run(
        `INSERT INTO area_categories (id, user_id, name, color) VALUES ('c2', 'AB', 'gym', 'blue')`,
      ),
    ).toThrow(/UNIQUE/);
  });

  test('finds a category by name regardless of case, for its own user only', async () => {
    await categories.addCategory(buildAreaCategory({ id: 'c1', name: 'Gym' }));

    expect((await categories.findCategoryByName('AB', 'gYM'))?.id).toBe('c1');
    expect(await categories.findCategoryByName('CD', 'Gym')).toBeUndefined();
  });

  test('renames and recolours, keeping what is not changed', async () => {
    await categories.addCategory(buildAreaCategory({ id: 'c1', name: 'Gym', color: 'blue' }));

    expect(await categories.updateCategory('AB', 'c1', { name: 'Climbing' })).toBe('updated');
    expect(await categories.getCategory('AB', 'c1')).toMatchObject({
      name: 'Climbing',
      color: 'blue',
    });

    expect(await categories.updateCategory('AB', 'c1', { color: 'aqua' })).toBe('updated');
    expect(await categories.getCategory('AB', 'c1')).toMatchObject({
      name: 'Climbing',
      color: 'aqua',
    });
  });

  test("a rename can change a category's own case but not take another's name", async () => {
    await categories.addCategory(buildAreaCategory({ id: 'c1', name: 'gym' }));
    await categories.addCategory(buildAreaCategory({ id: 'c2', name: 'Work' }));

    expect(await categories.updateCategory('AB', 'c1', { name: 'Gym' })).toBe('updated');
    expect(await categories.updateCategory('AB', 'c1', { name: 'work' })).toBe('name-taken');
    expect((await categories.getCategory('AB', 'c1'))!.name).toBe('Gym');
  });

  test("another user's category can't be changed or deleted", async () => {
    await categories.addCategory(buildAreaCategory({ id: 'c1', name: 'Gym' }));

    expect(await categories.updateCategory('CD', 'c1', { name: 'Mine' })).toBe('not-found');
    expect(await categories.removeCategory('CD', 'c1')).toBe(false);
    expect((await categories.getCategory('AB', 'c1'))!.name).toBe('Gym');
  });

  test("deleting a category leaves its areas in place, uncategorised, and others' alone", async () => {
    await categories.addCategory(buildAreaCategory({ id: 'gym', name: 'Gym' }));
    await categories.addCategory(buildAreaCategory({ id: 'work', name: 'Work' }));
    await areas.addArea(buildArea({ id: 'a1', categoryId: 'gym' }));
    await areas.addArea(buildArea({ id: 'a2', categoryId: 'gym' }));
    await areas.addArea(buildArea({ id: 'a3', categoryId: 'work' }));

    expect(await categories.removeCategory('AB', 'gym')).toBe(true);

    const byId = Object.fromEntries((await areas.listAreas('AB')).map((area) => [area.id, area]));
    expect(Object.keys(byId).sort()).toEqual(['a1', 'a2', 'a3']);
    expect(byId.a1).not.toHaveProperty('categoryId');
    expect(byId.a2).not.toHaveProperty('categoryId');
    expect(byId.a3!.categoryId).toBe('work');
    expect(await categories.getCategory('AB', 'gym')).toBeUndefined();
    expect(await categories.removeCategory('AB', 'gym')).toBe(false);
  });
});
