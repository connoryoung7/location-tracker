import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';

const MIGRATIONS = './drizzle';
let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A copy of the migrations folder that stops before the migration tagged `beforeTag`. */
async function migrationsBefore(beforeTag: string): Promise<string> {
  scratch = mkdtempSync(join(tmpdir(), 'migrations-'));
  cpSync(MIGRATIONS, scratch, { recursive: true });
  const journalPath = join(scratch, 'meta', '_journal.json');
  const journal = await Bun.file(journalPath).json();
  const cut = journal.entries.findIndex((entry: { tag: string }) => entry.tag === beforeTag);
  expect(cut).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, cut);
  await Bun.write(journalPath, JSON.stringify(journal));
  return scratch;
}

test('adding area categories keeps every existing area, uncategorised', async () => {
  const db = new Database(':memory:');
  migrate(drizzle(db), { migrationsFolder: await migrationsBefore('0006_workable_human_torch') });
  db.run(`INSERT INTO areas (id, user_id, name, lat, lon, radius) VALUES
    ('a1', 'AB', 'Home', 42.36, -71.06, 150), ('a2', 'CD', 'Work', 51.5, -0.12, 250)`);

  runMigrations(db);

  const rows = db.query('SELECT id, name, radius, category_id FROM areas ORDER BY id').all();
  expect(rows).toEqual([
    { id: 'a1', name: 'Home', radius: 150, category_id: null },
    { id: 'a2', name: 'Work', radius: 250, category_id: null },
  ]);
  expect(db.query('SELECT COUNT(*) AS count FROM area_categories').get()).toEqual({ count: 0 });
  db.close();
});
