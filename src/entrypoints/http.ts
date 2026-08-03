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
import { PrometheusMetricsCollector } from '@/infrastructure/metrics/prometheus.metrics';
import { CoordinatePrecision } from '@/domain/types';
import type { Deps } from '@/application/handle-payload.ts';
import { createRedisClient } from '@/infrastructure/redis/client.ts';
import { RedisAreaRepository } from '@/repository/area-repository/redis.repository.ts';
import { RedisGeofenceEvaluator } from '@/infrastructure/geofence/redis.geofence-evaluator.ts';
import { RedisEventPublisher } from '@/infrastructure/events/redis.event-publisher.ts';
import { DbEventPublisher } from '@/infrastructure/events/db.event-publisher.ts';
import { NotificationEventPublisher } from '@/infrastructure/events/notification.event-publisher.ts';
import { CompositeEventPublisher } from '@/infrastructure/events/composite.event-publisher.ts';
import { LogNotificationSender } from '@/infrastructure/notifications/log.notification-sender.ts';
import type { LocationRepository } from '@/domain/ports.ts';

const config = loadConfig();
const logger = new PinoLogger();
const reverseGeocoder = new NominatimGeocoder(CoordinatePrecision.Building);
const metrics = new PrometheusMetricsCollector();

const decryptor = await LibsodiumDecryptor.create(
  Buffer.from(btoa(config.encryptionKey), 'base64'),
);

const redis = createRedisClient(config.redisUrl);
const areaRepo = new RedisAreaRepository(redis);
const geofence = new RedisGeofenceEvaluator(redis, config.geofenceExitThresholdSeconds);
const notificationSender = new LogNotificationSender(logger);

function buildEventPublisher(repo: LocationRepository) {
  return new CompositeEventPublisher(
    [
      new RedisEventPublisher(redis),
      new DbEventPublisher(repo),
      new NotificationEventPublisher(notificationSender),
    ],
    logger,
  );
}

let deps: Deps;

if (config.postgresPassword !== undefined) {
  logger.info(
    `Using Postgres database at ${config.postgresHost}:${config.postgresPort}/${config.postgresDb}`,
  );
  const sql = new SQL({
    hostname: config.postgresHost,
    port: config.postgresPort,
    database: config.postgresDb,
    username: config.postgresUser,
    password: config.postgresPassword,
  });
  const repo = new PostgresLocationRepository(sql);
  await repo.migrate();
  deps = {
    repo,
    logger,
    decryptor,
    reverseGeocoder,
    geofence,
    eventPublisher: buildEventPublisher(repo),
    areaRepo,
    metrics,
  };
} else {
  const db = new Database(config.dbPath, { create: true });
  runMigrations(db);
  const repo = new SqliteLocationRepository(db);
  deps = {
    repo,
    logger,
    decryptor,
    reverseGeocoder,
    geofence,
    eventPublisher: buildEventPublisher(repo),
    areaRepo,
    metrics,
  };
}

const app = createHttpServer(deps);

app.listen(config.port, () => {
  logger.info(`HTTP server running on http://localhost:${config.port}`);
});
