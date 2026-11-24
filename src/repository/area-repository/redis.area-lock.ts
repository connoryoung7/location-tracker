import type { RedisClient } from 'bun';
import type { Logger } from '@/domain/ports.ts';
import { areaWriteLockKey } from '@/infrastructure/redis/keys.ts';

/** Another writer held the user's area lock for longer than the caller would wait. */
export class AreaLockBusyError extends Error {
  constructor(userId: string, waitMs: number) {
    super(`Timed out after ${waitMs}ms waiting for the area lock of ${userId}`);
    this.name = 'AreaLockBusyError';
  }
}

/**
 * How long a lock outlives a holder that died or stalled. Area writes take
 * milliseconds, so this only matters after a crash: other writers for that
 * user wait it out, then carry on.
 */
const LOCK_TTL_MS = 10_000;
/** How often a waiting writer tries the lock again. */
const RETRY_MS = 20;
/** Deletes the lock only if this holder's token is still in it. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * A per-user lock in Redis, across every process sharing it, held while an
 * area is written to the store and then to the geofence index. It lives in
 * Redis rather than the database so no database transaction stays open while
 * Redis is written: the store write commits first, on its own, and the index is
 * only ever written from committed data.
 */
export class RedisAreaLock {
  private redis: RedisClient;
  private logger: Logger;

  constructor(redis: RedisClient, logger: Logger) {
    this.redis = redis;
    this.logger = logger;
  }

  /**
   * Runs `work` holding the user's lock. Rejects with {@link AreaLockBusyError},
   * without running `work`, if another holder keeps it for `waitMs`; any other
   * rejection before `work` runs means Redis itself could not be reached.
   */
  async withLock<T>(userId: string, work: () => Promise<T>, waitMs: number): Promise<T> {
    const key = areaWriteLockKey(userId);
    const token = crypto.randomUUID();
    const deadline = Date.now() + waitMs;
    while (!(await this.tryAcquire(key, token))) {
      if (Date.now() >= deadline) throw new AreaLockBusyError(userId, waitMs);
      await Bun.sleep(RETRY_MS);
    }

    try {
      return await work();
    } finally {
      await this.release(key, token);
    }
  }

  private async tryAcquire(key: string, token: string): Promise<boolean> {
    const reply = await this.redis.send('SET', [key, token, 'NX', 'PX', String(LOCK_TTL_MS)]);
    return reply === 'OK';
  }

  /** Never throws: an unreleased lock expires on its own after {@link LOCK_TTL_MS}. */
  private async release(key: string, token: string): Promise<void> {
    try {
      await this.redis.send('EVAL', [RELEASE_SCRIPT, '1', key, token]);
    } catch (error) {
      this.logger.warn(`Could not release ${key}; it expires in ${LOCK_TTL_MS}ms`, error);
    }
  }
}
