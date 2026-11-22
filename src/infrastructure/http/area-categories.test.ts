import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Server } from 'node:http';
import { createAppServer } from '@/infrastructure/http/app-server.ts';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';
import { SqliteAreaCategoryRepository } from '@/repository/area-category-repository/sqlite.repository.ts';
import { SqliteAreaRepository } from '@/repository/area-repository/sqlite.repository.ts';
import { mockAreaEventRepository, mockLogger, mockMetricsCollector } from '@/test/mocks.ts';
import { buildArea, buildAreaCategory } from '@/test/factories.ts';

// Real SQLite repositories, so ownership checks, case-insensitive names and
// delete-clears-areas are exercised end to end.
let db: Database;
let areas: SqliteAreaRepository;
let categories: SqliteAreaCategoryRepository;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  areas = new SqliteAreaRepository(db);
  categories = new SqliteAreaCategoryRepository(db);
  const app = createAppServer({
    areaRepo: areas,
    areaCategories: categories,
    areaEvents: mockAreaEventRepository(),
    users: { listUserIds: async () => ['AB', 'CD'] },
    logger: mockLogger(),
    metrics: mockMetricsCollector(),
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

beforeEach(() => {
  db.run('DELETE FROM areas');
  db.run('DELETE FROM area_categories');
});

/** A JSON API call, as a script or curl would make it. */
async function json(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/** A form post, as htmx sends one from the page. */
async function form(method: string, path: string, fields: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, html: await res.text() };
}

/** The JSON data block with this ID, found by plain string search. */
const readData = (html: string, id: string) => {
  const opening = `id="${id}">`;
  const start = html.indexOf(opening);
  expect(start).toBeGreaterThanOrEqual(0);
  const from = start + opening.length;
  return JSON.parse(html.slice(from, html.indexOf('</script>', from)).replaceAll('\\u003c', '<'));
};

describe('POST /categories', () => {
  test('creates categories with the next unused colour, then repeats', async () => {
    const colors = [];
    for (const name of ['Gym', 'Work', 'Home', 'School']) {
      const { status, body } = await json('POST', '/categories', { userId: 'AB', name });
      expect(status).toBe(201);
      colors.push(body.color);
    }

    expect(colors).toEqual(['blue', 'orange', 'aqua', 'blue']);
  });

  test('keeps a chosen colour, and rejects one outside the palette', async () => {
    const chosen = await json('POST', '/categories', { userId: 'AB', name: 'Gym', color: 'aqua' });
    const unknown = await json('POST', '/categories', { userId: 'AB', name: 'Work', color: 'red' });

    expect(chosen.body.color).toBe('aqua');
    expect(unknown.status).toBe(422);
    expect(await categories.listCategories('AB')).toHaveLength(1);
  });

  test('a duplicate name, ignoring case, is a conflict for that user only', async () => {
    await json('POST', '/categories', { userId: 'AB', name: 'Gym' });

    expect((await json('POST', '/categories', { userId: 'AB', name: ' gym ' })).status).toBe(409);
    expect((await json('POST', '/categories', { userId: 'CD', name: 'Gym' })).status).toBe(201);
  });

  test('rejects a blank or over-long name', async () => {
    expect((await json('POST', '/categories', { userId: 'AB', name: '   ' })).status).toBe(422);
    expect(
      (await json('POST', '/categories', { userId: 'AB', name: 'x'.repeat(101) })).status,
    ).toBe(422);
  });

  test('from the page, answers with the list, or the list and the reason', async () => {
    const added = await form('POST', '/categories', { userId: 'AB', name: 'Gym' });
    const duplicate = await form('POST', '/categories', { userId: 'AB', name: 'GYM' });

    expect(added.status).toBe(200);
    expect(added.html).toContain('value="Gym"');
    // 422 is a status the page's htmx config swaps in.
    expect(duplicate.status).toBe(422);
    expect(duplicate.html).toContain('There&#39;s already a category called &quot;GYM&quot;.');
  });
});

describe('GET /categories', () => {
  test("lists only the user's own categories, by name", async () => {
    await categories.addCategory(buildAreaCategory({ id: 'c1', name: 'Work' }));
    await categories.addCategory(buildAreaCategory({ id: 'c2', name: 'gym' }));
    await categories.addCategory(buildAreaCategory({ id: 'c3', userId: 'CD', name: 'Home' }));

    const { body } = await json('GET', '/categories?userId=AB');

    expect(body.map((category: { name: string }) => category.name)).toEqual(['gym', 'Work']);
  });
});

describe('PATCH /categories/:userId/:categoryId', () => {
  beforeEach(async () => {
    await categories.addCategory(buildAreaCategory({ id: 'gym', name: 'Gym', color: 'blue' }));
    await categories.addCategory(buildAreaCategory({ id: 'work', name: 'Work', color: 'orange' }));
  });

  test('renames and recolours', async () => {
    const { status, body } = await json('PATCH', '/categories/AB/gym', {
      name: 'Climbing',
      color: 'aqua',
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ id: 'gym', name: 'Climbing', color: 'aqua' });
  });

  test("won't take another category's name, a colour outside the palette, or nothing at all", async () => {
    expect((await json('PATCH', '/categories/AB/gym', { name: 'WORK' })).status).toBe(409);
    expect((await json('PATCH', '/categories/AB/gym', { color: 'red' })).status).toBe(422);
    expect((await json('PATCH', '/categories/AB/gym', {})).status).toBe(422);
    expect(await categories.getCategory('AB', 'gym')).toMatchObject({ name: 'Gym', color: 'blue' });
  });

  test("another user's category is not found", async () => {
    expect((await json('PATCH', '/categories/CD/gym', { name: 'Mine' })).status).toBe(404);
  });

  test('from the page, saves the name and colour fields together', async () => {
    const { status, html } = await form('PATCH', '/categories/AB/gym', {
      name: 'Climbing',
      color: 'aqua',
    });

    expect(status).toBe(200);
    expect(html).toContain('value="Climbing"');
    expect(await categories.getCategory('AB', 'gym')).toMatchObject({ color: 'aqua' });
  });
});

describe('DELETE /categories/:userId/:categoryId', () => {
  test('leaves its areas in place, uncategorised', async () => {
    await categories.addCategory(buildAreaCategory({ id: 'gym', name: 'Gym' }));
    await areas.addArea(buildArea({ id: 'a1', name: 'Pool', categoryId: 'gym' }));

    const { status, html } = await form('DELETE', '/categories/AB/gym');

    expect(status).toBe(200);
    expect(html).toContain('Pool');
    expect(await areas.getArea('AB', 'a1')).not.toHaveProperty('categoryId');
    expect((await json('DELETE', '/categories/AB/gym')).status).toBe(404);
  });

  test("can't delete another user's category", async () => {
    await categories.addCategory(buildAreaCategory({ id: 'gym', name: 'Gym' }));

    expect((await json('DELETE', '/categories/CD/gym')).status).toBe(404);
    expect(await categories.getCategory('AB', 'gym')).toBeDefined();
  });
});

describe('PATCH /areas/:userId/:areaId', () => {
  beforeEach(async () => {
    await categories.addCategory(buildAreaCategory({ id: 'gym', name: 'Gym' }));
    await categories.addCategory(buildAreaCategory({ id: 'theirs', userId: 'CD', name: 'Gym' }));
    await areas.addArea(buildArea({ id: 'a1', name: 'Pool' }));
  });

  test('puts an area in one of its own categories and takes it out again', async () => {
    expect((await json('PATCH', '/areas/AB/a1', { categoryId: 'gym' })).status).toBe(200);
    expect((await areas.getArea('AB', 'a1'))!.categoryId).toBe('gym');

    // The page's "None" option sends an empty value.
    expect((await form('PATCH', '/areas/AB/a1', { categoryId: '' })).status).toBe(200);
    expect(await areas.getArea('AB', 'a1')).not.toHaveProperty('categoryId');
  });

  test("never puts an area in another user's category", async () => {
    const { status } = await json('PATCH', '/areas/AB/a1', { categoryId: 'theirs' });

    expect(status).toBe(422);
    expect(await areas.getArea('AB', 'a1')).not.toHaveProperty('categoryId');
  });

  test('an unknown area is not found, and an over-long user ID is rejected', async () => {
    expect((await json('PATCH', '/areas/AB/missing', { categoryId: 'gym' })).status).toBe(404);
    expect((await json('PATCH', `/areas/${'x'.repeat(65)}/a1`, { categoryId: null })).status).toBe(
      422,
    );
  });
});

describe('POST /areas with a category', () => {
  const area = { userId: 'AB', name: 'Pool', lat: 42.36, lon: -71.06, radius: 100 };

  test('goes in an existing category of the same user', async () => {
    await categories.addCategory(buildAreaCategory({ id: 'gym', name: 'Gym' }));

    const { status, body } = await json('POST', '/areas', { ...area, categoryId: 'gym' });

    expect(status).toBe(201);
    expect((await areas.getArea('AB', body.id))!.categoryId).toBe('gym');
  });

  test("is refused, and not created, with another user's category", async () => {
    await categories.addCategory(buildAreaCategory({ id: 'theirs', userId: 'CD', name: 'Gym' }));

    const { status } = await json('POST', '/areas', { ...area, categoryId: 'theirs' });

    expect(status).toBe(422);
    expect(await areas.listAreas('AB')).toEqual([]);
  });

  test('a new category name creates it, with the next colour', async () => {
    await categories.addCategory(buildAreaCategory({ id: 'gym', name: 'Gym', color: 'blue' }));

    const { body } = await json('POST', '/areas', { ...area, categoryName: 'Swimming' });

    const created = await categories.findCategoryByName('AB', 'Swimming');
    expect(created).toMatchObject({ name: 'Swimming', color: 'orange' });
    expect((await areas.getArea('AB', body.id))!.categoryId).toBe(created!.id);
  });

  test('a name the user already has, in any case, reuses that category', async () => {
    await categories.addCategory(buildAreaCategory({ id: 'gym', name: 'Gym' }));

    const { body } = await json('POST', '/areas', { ...area, categoryName: 'GYM' });

    expect((await areas.getArea('AB', body.id))!.categoryId).toBe('gym');
    expect(await categories.listCategories('AB')).toHaveLength(1);
  });

  test('both an ID and a new name is ambiguous', async () => {
    const { status } = await json('POST', '/areas', {
      ...area,
      categoryId: 'gym',
      categoryName: 'Gym',
    });

    expect(status).toBe(422);
  });
});

describe('GET /fragments/areas with categories', () => {
  test('groups areas under their categories, uncategorised last, with colour swatches', async () => {
    await categories.addCategory(buildAreaCategory({ id: 'work', name: 'Work', color: 'orange' }));
    await categories.addCategory(buildAreaCategory({ id: 'gym', name: 'Gym', color: 'blue' }));
    await areas.addArea(buildArea({ id: 'a1', name: 'Office', categoryId: 'work' }));
    await areas.addArea(buildArea({ id: 'a2', name: 'Pool', categoryId: 'gym' }));
    await areas.addArea(buildArea({ id: 'a3', name: 'Park' }));

    const html = await fetch(`${baseUrl}/fragments/areas?userId=AB`).then((res) => res.text());

    const headings = [
      ...html.matchAll(/data-color="(\w+)"[^>]*><\/span>\s*<span class="area-group-name">([^<]+)/g),
    ].map(([, color, name]) => `${name} (${color})`);
    expect(headings).toEqual(['Gym (blue)', 'Work (orange)', 'Uncategorised (none)']);
    expect(html.indexOf('Pool')).toBeLessThan(html.indexOf('Office'));
    expect(html.indexOf('Office')).toBeLessThan(html.indexOf('Park'));

    const data = readData(html, 'areas-data');
    expect(data.categories).toEqual([
      { id: 'gym', name: 'Gym', color: 'blue' },
      { id: 'work', name: 'Work', color: 'orange' },
    ]);
    const colorKeys = Object.fromEntries(
      data.featureCollection.features.map(
        (feature: { properties: { name: string; colorKey: string } }) => [
          feature.properties.name,
          feature.properties.colorKey,
        ],
      ),
    );
    expect(colorKeys).toEqual({ Office: 'orange', Pool: 'blue', Park: 'none' });
  });

  test('without any categories, keeps the plain list', async () => {
    await areas.addArea(buildArea({ id: 'a1', name: 'Park' }));

    const html = await fetch(`${baseUrl}/fragments/areas?userId=AB`).then((res) => res.text());

    expect(html).toContain('Park');
    expect(html).not.toContain('area-group');
  });

  test('escapes category names in headings and the data block', async () => {
    const hostile = '</script><img src=x onerror=alert(1)>';
    await categories.addCategory(buildAreaCategory({ id: 'c1', name: hostile }));
    await areas.addArea(buildArea({ id: 'a1', categoryId: 'c1' }));

    const html = await fetch(`${baseUrl}/fragments/areas?userId=AB`).then((res) => res.text());

    expect(html).not.toContain('<img');
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(readData(html, 'areas-data').categories[0].name).toBe(hostile);
  });
});

describe('GET /fragments/area-list with categories', () => {
  test("shows each area's category as a select that saves on change", async () => {
    await categories.addCategory(buildAreaCategory({ id: 'gym', name: 'Gym' }));
    await areas.addArea(buildArea({ id: 'a1', name: 'Pool', categoryId: 'gym' }));
    await areas.addArea(buildArea({ id: 'a2', name: 'Park' }));

    const html = await fetch(`${baseUrl}/fragments/area-list?userId=AB`).then((res) => res.text());

    expect(html).toContain('<th scope="col">Category</th>');
    const selects = [
      ...html.matchAll(/<select\s+class="area-category-select"[\s\S]*?<\/select>/g),
    ].map(([select]) => select);
    expect(selects).toHaveLength(2);
    expect(selects[1]).toContain('hx-patch="/areas/AB/a1"');
    expect(selects[1]).toContain('<option value="gym" selected>Gym</option>');
    expect(selects[0]).toContain('<option value="" selected>None</option>');
  });

  test('the Categories section says what deleting each one would do', async () => {
    await categories.addCategory(buildAreaCategory({ id: 'gym', name: 'Gym' }));
    await categories.addCategory(buildAreaCategory({ id: 'work', name: 'Work' }));
    await areas.addArea(buildArea({ id: 'a1', categoryId: 'gym' }));
    await areas.addArea(buildArea({ id: 'a2', categoryId: 'gym' }));

    const html = await fetch(`${baseUrl}/fragments/area-list?userId=AB`).then((res) => res.text());

    expect(html).toContain(
      'hx-confirm="Delete &quot;Gym&quot;? 2 areas will become uncategorised."',
    );
    expect(html).toContain('hx-confirm="Delete &quot;Work&quot;? It has no areas."');
    expect(html).toContain('hx-post="/categories"');
  });

  test('shows the Categories section even before the user has any areas', async () => {
    const html = await fetch(`${baseUrl}/fragments/area-list?userId=AB`).then((res) => res.text());

    expect(html).toContain('No areas for AB yet.');
    expect(html).toContain('class="category-manager"');
  });
});

test('the New area form offers None, the categories, and New category…', async () => {
  const html = await fetch(`${baseUrl}/`).then((res) => res.text());
  const select = html.slice(html.indexOf('<select name="categoryId" id="draw-category">'));

  expect(select.slice(0, select.indexOf('</select>'))).toContain(
    '<option value="" selected>None</option>',
  );
  expect(select).toContain('<option value="__new__">New category…</option>');
  expect(html).toContain('<label id="draw-category-name-label" hidden>');
});
