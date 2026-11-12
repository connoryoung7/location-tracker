import { PostgresLocationRepository } from '@/repository/location-repository/postgres.repository.ts';
import { SqliteLocationRepository } from '@/repository/location-repository/sqlite.repository.ts';
import { recomputeAreaEvents } from '@/application/recompute-area-events.ts';
import { loadConfig } from '@/config.ts';
import { createAppServer } from '@/infrastructure/http/app-server.ts';
import { PinoLogger } from '@/infrastructure/logging/pino.logger.ts';
import { PrometheusMetricsCollector } from '@/infrastructure/metrics/prometheus.metrics.ts';
import { createRedisClient, waitForRedis } from '@/infrastructure/redis/client.ts';
import {
  createAreaRepository,
  openAreaStore,
} from '@/repository/area-repository/create-area-repository.ts';

const config = loadConfig();
const logger = new PinoLogger();
const metrics = new PrometheusMetricsCollector();

const redis = createRedisClient(config.redisUrl);
const store = openAreaStore(config);
const areaRepo = createAreaRepository(store, redis, logger);
const repo =
  store.kind === 'postgres'
    ? new PostgresLocationRepository(store.sql)
    : new SqliteLocationRepository(store.db);
if (repo instanceof PostgresLocationRepository) await repo.migrate();

// Commands fail fast rather than queueing while disconnected, so warm the
// connection before doing any startup work -- and before serving a page, which
// would otherwise render the error state and wait a full poll to recover.
if (await waitForRedis(redis)) {
  // Reconciles the geofence index with the area store. Not fatal: areas are read
  // from the store, so the UI works even when Redis is down -- only geofencing
  // is degraded, and a later read repairs it.
  await areaRepo.initialize().catch((error: unknown) => {
    logger.error(`Failed to initialize the area projection: ${error}`);
    areaRepo.initializeInBackground();
  });
} else {
  logger.warn('Redis not reachable at startup; serving areas from the store only');
  areaRepo.initializeInBackground();
}

const app = createAppServer({
  areaRepo,
  logger,
  metrics,
  recompute: (userId) =>
    recomputeAreaEvents(userId, {
      redis,
      areaRepo,
      repo,
      logger,
      metrics,
      thresholdSeconds: config.geofenceExitThresholdSeconds,
    }),
});

app.listen(config.appPort, () => {
  logger.info(`Area map UI running on http://localhost:${config.appPort}`);
});
