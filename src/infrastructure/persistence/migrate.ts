import { Database } from 'bun:sqlite';

import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

export function runMigrations(db: Database): void {
  const drizzleDb = drizzle(db);
  migrate(drizzleDb, { migrationsFolder: './drizzle' });
}

if (import.meta.main) {
  const { loadConfig } = await import('@/config.ts');
  const config = loadConfig();
  const db = new Database(config.dbPath, { create: true });
  runMigrations(db);
  console.log('Migrations complete');
  db.close();
}
