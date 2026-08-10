import { RedisClient } from 'bun';

/**
 * Bun defaults to 10 reconnection attempts, after which the client is dead for
 * the lifetime of the process and every command fails with
 * ERR_REDIS_CONNECTION_CLOSED. These are long-running servers that should ride
 * out a Redis restart, so keep retrying instead of giving up.
 */
const MAX_RECONNECT_ATTEMPTS = 2 ** 31 - 1;

export function createRedisClient(url: string): RedisClient {
  return new RedisClient(url, {
    maxRetries: MAX_RECONNECT_ATTEMPTS,
    // Without this, commands issued while disconnected queue until a connection
    // comes back, so requests hang for as long as Redis is down instead of
    // failing. Callers would rather get an error they can render.
    enableOfflineQueue: false,
  });
}
