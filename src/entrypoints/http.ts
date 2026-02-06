import { Database } from 'bun:sqlite';

import { loadConfig } from '@/config.ts';
import { createHttpServer } from '@/infrastructure/http/server.ts';
import { PinoLogger } from '@/infrastructure/logging/pino.logger.ts';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';
import { SqliteLocationRepository } from '@/repository/location-repository/sqlite.repository';
import type { Deps } from '@/application/handle-payload.ts';

const config = loadConfig();

const db = new Database(config.dbPath, { create: true });
runMigrations(db);

const deps: Deps = {
  repo: new SqliteLocationRepository(db),
  logger: new PinoLogger(),
};

const app = createHttpServer(deps);

app.listen(config.port, () => {
  deps.logger.info(`HTTP server running on http://localhost:${config.port}`);
});
