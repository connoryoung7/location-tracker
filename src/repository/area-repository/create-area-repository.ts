import { SQL } from 'bun';
import { Database } from 'bun:sqlite';
import type { RedisClient } from 'bun';
import type { Config } from '@/config.ts';
import type { AreaRepository, Logger } from '@/domain/ports.ts';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';
import { PostgresAreaRepository } from '@/repository/area-repository/postgres.repository.ts';
import { SqliteAreaRepository } from '@/repository/area-repository/sqlite.repository.ts';
import { RedisAreaProjection } from '@/repository/area-repository/redis.projection.ts';
import { SyncingAreaRepository } from '@/repository/area-repository/syncing.repository.ts';

/**
 * Whichever store owns areas in this deployment. Postgres when configured,
 * SQLite otherwise -- the same choice `@/entrypoints/http.ts` makes for
 * locations.
 */
export type AreaStore = { kind: 'postgres'; sql: SQL } | { kind: 'sqlite'; db: Database };

/**
 * Opens a store for an entrypoint that does not already have a database
 * connection. Callers that do (the ingestion app) should wrap their existing
 * connection in an {@link AreaStore} instead of opening a second one.
 */
export function openAreaStore(config: Config): AreaStore {
  if (config.postgresPassword !== undefined) {
    return {
      kind: 'postgres',
      sql: new SQL({
        hostname: config.postgresHost,
        port: config.postgresPort,
        database: config.postgresDb,
        username: config.postgresUser,
        password: config.postgresPassword,
      }),
    };
  }

  const db = new Database(config.dbPath, { create: true });
  runMigrations(db);
  return { kind: 'sqlite', db };
}

export function createAreaSourceRepository(store: AreaStore): AreaRepository {
  return store.kind === 'postgres'
    ? new PostgresAreaRepository(store.sql)
    : new SqliteAreaRepository(store.db);
}

/**
 * Builds the area repository every entrypoint should use: the store owns the
 * areas, Redis mirrors them for the geofence evaluator.
 *
 * Call `initialize()` on the result before serving traffic to run the cutover
 * import and rebuild the projection.
 */
export function createAreaRepository(
  store: AreaStore,
  redis: RedisClient,
  logger: Logger,
): SyncingAreaRepository {
  return new SyncingAreaRepository(
    createAreaSourceRepository(store),
    new RedisAreaProjection(redis),
    redis,
    logger,
  );
}
