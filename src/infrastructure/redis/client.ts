import { RedisClient } from 'bun';

/**
 * Bun defaults to 10 reconnection attempts, after which the client is dead for
 * the lifetime of the process and every command fails with
 * ERR_REDIS_CONNECTION_CLOSED. These are long-running servers that should ride
 * out a Redis restart, so keep retrying instead of giving up.
 */
const MAX_RECONNECT_ATTEMPTS = 2 ** 31 - 1;

/** How long startup waits for the first connection before carrying on without it. */
const CONNECT_TIMEOUT_MS = 5_000;

export function createRedisClient(url: string): RedisClient {
  return new RedisClient(url, {
    maxRetries: MAX_RECONNECT_ATTEMPTS,
    // Without this, commands issued while disconnected queue until a connection
    // comes back, so requests hang for as long as Redis is down instead of
    // failing. Callers would rather get an error they can render.
    enableOfflineQueue: false,
  });
}

/**
 * Waits for the initial connection, bounded.
 *
 * Commands fail fast rather than queueing, so anything issued before the socket
 * is up errors -- startup work needs the connection warm first. But retries are
 * unbounded, so `connect()` never rejects while Redis is down, and awaiting it
 * outright would hang the process forever.
 *
 * @returns whether the client connected within the timeout. Callers should carry
 * on either way; `autoReconnect` keeps trying in the background.
 */
export async function waitForRedis(
  redis: RedisClient,
  timeoutMs: number = CONNECT_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Each branch handles its own settlement, so the losing race leg cannot
  // surface as an unhandled rejection.
  const connected = redis.connect().then(
    () => true,
    () => false,
  );
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    return await Promise.race([connected, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
