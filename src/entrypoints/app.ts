import { loadConfig } from '@/config.ts';
import { createAppServer } from '@/infrastructure/http/app-server.ts';
import { PinoLogger } from '@/infrastructure/logging/pino.logger.ts';
import { PrometheusMetricsCollector } from '@/infrastructure/metrics/prometheus.metrics.ts';
import { createRedisClient } from '@/infrastructure/redis/client.ts';
import { RedisAreaRepository } from '@/repository/area-repository/redis.repository.ts';

const config = loadConfig();
const logger = new PinoLogger();
const metrics = new PrometheusMetricsCollector();

const redis = createRedisClient(config.redisUrl);
const areaRepo = new RedisAreaRepository(redis);

const app = createAppServer({ areaRepo, logger, metrics });

app.listen(config.appPort, () => {
  logger.info(`Area map UI running on http://localhost:${config.appPort}`);
});
