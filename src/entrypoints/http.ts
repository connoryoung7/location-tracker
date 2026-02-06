import { SQL } from 'bun';
import { Database } from 'bun:sqlite';

import { loadConfig } from '@/config.ts';
import { createHttpServer } from '@/infrastructure/http/server.ts';
import { PinoLogger } from '@/infrastructure/logging/pino.logger.ts';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';
import { SqliteLocationRepository } from '@/repository/location-repository/sqlite.repository';
import { PostgresLocationRepository } from '@/repository/location-repository/postgres.repository';
import type { Deps } from '@/application/handle-payload.ts';

const config = loadConfig();
const logger = new PinoLogger();

let deps: Deps;

if (config.databaseUrl) {
  const sql = new SQL(config.databaseUrl);
  const repo = new PostgresLocationRepository(sql);
  await repo.migrate();
  deps = {
    repo,
    logger,
  };
} else {
  const db = new Database(config.dbPath, { create: true });
  runMigrations(db);
  deps = {
    repo: new SqliteLocationRepository(db),
    logger,
  };
}

const app = createHttpServer(deps);

app.listen(config.port, () => {
  logger.info(`HTTP server running on http://localhost:${config.port}`);
});
