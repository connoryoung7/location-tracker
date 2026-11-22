import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { PostgresAreaCategoryRepository } from '@/repository/area-category-repository/postgres.repository.ts';
import { PostgresAreaRepository } from '@/repository/area-repository/postgres.repository.ts';
import { PostgresLocationRepository } from '@/repository/location-repository/postgres.repository.ts';
import { buildArea, buildAreaCategory } from '@/test/factories.ts';

// Use a dedicated throwaway database: this suite clears the area tables.
const url = process.env.TEST_POSTGRES_URL;
describe.skipIf(!url)('PostgresAreaCategoryRepository', () => {
  let sql: SQL;
  let categories: PostgresAreaCategoryRepository;
  let areas: PostgresAreaRepository;

  beforeAll(async () => {
    sql = new SQL(url!);
    // Creates area_categories and areas.category_id along with everything else.
    await new PostgresLocationRepository(sql).migrate();
    // Running it twice must be harmless on an existing database.
    await new PostgresLocationRepository(sql).migrate();
    categories = new PostgresAreaCategoryRepository(sql);
    areas = new PostgresAreaRepository(sql);
  });
  beforeEach(async () => {
    await sql`TRUNCATE areas, area_categories`;
  });
  afterAll(async () => {
    await sql.close();
  });

  test('names are unique per user regardless of case; other users may share them', async () => {
    expect(await categories.addCategory(buildAreaCategory({ id: 'c1', name: 'Gym' }))).toBe(
      'added',
    );
    expect(await categories.addCategory(buildAreaCategory({ id: 'c2', name: 'GYM' }))).toBe(
      'name-taken',
    );
    expect(
      await categories.addCategory(buildAreaCategory({ id: 'c3', userId: 'CD', name: 'gym' })),
    ).toBe('added');
    // Wrapped in a real promise: a Bun SQL query is lazy, so handing the query
    // itself to `rejects` never runs it and the test hangs.
    const insertDuplicate = async () => {
      await sql`INSERT INTO area_categories (id, user_id, name, color) VALUES ('c4', 'AB', 'gym', 'blue')`;
    };
    await expect(insertDuplicate()).rejects.toThrow();
    expect((await categories.listCategories('AB')).map((category) => category.id)).toEqual(['c1']);
  });

  test('renames and recolours, but never onto another category name', async () => {
    await categories.addCategory(buildAreaCategory({ id: 'c1', name: 'gym', color: 'blue' }));
    await categories.addCategory(buildAreaCategory({ id: 'c2', name: 'Work' }));

    expect(await categories.updateCategory('AB', 'c1', { name: 'Gym', color: 'aqua' })).toBe(
      'updated',
    );
    expect(await categories.updateCategory('AB', 'c1', { name: 'WORK' })).toBe('name-taken');
    expect(await categories.updateCategory('CD', 'c1', { color: 'orange' })).toBe('not-found');
    expect(await categories.getCategory('AB', 'c1')).toMatchObject({ name: 'Gym', color: 'aqua' });
  });

  test("deleting a category leaves its areas in place, uncategorised, and others' alone", async () => {
    await categories.addCategory(buildAreaCategory({ id: 'gym', name: 'Gym' }));
    await categories.addCategory(buildAreaCategory({ id: 'work', name: 'Work' }));
    await areas.addArea(buildArea({ id: 'a1', categoryId: 'gym' }));
    await areas.addArea(buildArea({ id: 'a2', categoryId: 'work' }));

    expect(await categories.removeCategory('AB', 'gym')).toBe(true);

    expect(await areas.getArea('AB', 'a1')).not.toHaveProperty('categoryId');
    expect((await areas.getArea('AB', 'a2'))!.categoryId).toBe('work');
    expect(await categories.removeCategory('AB', 'gym')).toBe(false);
  });

  test('areas keep their category through a re-upsert and can be moved or cleared', async () => {
    await categories.addCategory(buildAreaCategory({ id: 'gym', name: 'Gym' }));
    await areas.addArea(buildArea({ id: 'a1', categoryId: 'gym' }));
    await areas.addArea(buildArea({ id: 'a1', radius: 300 }));

    expect(await areas.getArea('AB', 'a1')).toMatchObject({ radius: 300, categoryId: 'gym' });
    expect(await areas.setAreaCategory('CD', 'a1', null)).toBe(false);
    expect(await areas.setAreaCategory('AB', 'a1', null)).toBe(true);
    expect(await areas.getArea('AB', 'a1')).not.toHaveProperty('categoryId');
  });
});
