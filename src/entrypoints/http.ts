import { SQL } from 'bun';
import { Database } from 'bun:sqlite';

import { loadConfig } from '@/config.ts';
import { createHttpServer } from '@/infrastructure/http/server.ts';
import { LibsodiumDecryptor } from '@/infrastructure/crypto/libsodium.decryptor.ts';
import { PinoLogger } from '@/infrastructure/logging/pino.logger.ts';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';
import { SqliteLocationRepository } from '@/repository/location-repository/sqlite.repository';
import { PostgresLocationRepository } from '@/repository/location-repository/postgres.repository';
import { NominatimGeocoder } from '@/infrastructure/geocoder/nominatim.geocoder';
import { CoordinatePrecision } from '@/domain/types';
import type { Deps } from '@/application/handle-payload.ts';

const config = loadConfig();
const logger = new PinoLogger();
const reverseGeocoder = new NominatimGeocoder(CoordinatePrecision.Building);

const decryptor = await LibsodiumDecryptor.create(
  Buffer.from(btoa(config.encryptionKey), 'base64'),
);

let deps: Deps;

if (config.databaseUrl) {
  logger.info(`Using Postgres database at ${config.databaseUrl}`);
  const sql = new SQL(config.databaseUrl);
  const repo = new PostgresLocationRepository(sql);
  await repo.migrate();
  deps = {
    repo,
    logger,
    decryptor,
    reverseGeocoder,
  };
} else {
  const db = new Database(config.dbPath, { create: true });
  runMigrations(db);
  deps = {
    repo: new SqliteLocationRepository(db),
    logger,
    decryptor,
    reverseGeocoder,
  };
}

const app = createHttpServer(deps);

app.listen(config.port, () => {
  logger.info(`HTTP server running on http://localhost:${config.port}`);
});
