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
 * milliseconds, so this only matters after a crash or a long stall: other
 * writers for that user wait it out, then carry on.
 */
const LOCK_TTL_MS = 10_000;
/** How often a waiting writer tries the lock again. */
const RETRY_MS = 20;
/**
 * Every attempt gets at least this long for Redis to answer, even when the
 * caller's wait is nearly up, so a lock that is merely busy is never mistaken
 * for a Redis that is not answering.
 */
const ANSWER_GRACE_MS = 100;
/** Longest a release waits for Redis to answer before treating the lock as lost. */
const RELEASE_TIMEOUT_MS = 1_000;
/** Deletes the lock only if this holder's token is still in it; 1 if it was. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** What {@link answerWithin} returns when Redis has not answered in time. */
export const NO_ANSWER = Symbol('no answer');

/** `promise`'s value, or {@link NO_ANSWER} if it has not settled within `ms`. */
export async function answerWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof NO_ANSWER> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof NO_ANSWER>((resolve) => {
    timer = setTimeout(() => resolve(NO_ANSWER), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A per-user lock in Redis, across every process sharing it, held while an
 * area is written to the store and then to the geofence index. It lives in
 * Redis rather than the database so no database transaction stays open while
 * Redis is written: the store write commits first, on its own, and the index is
 * only ever written from committed data.
 *
 * A lock can expire under a holder that stalls past {@link LOCK_TTL_MS}, and
 * another writer may then get in. Whatever the stalled holder writes to the
 * index afterwards may be stale, so `onLost` is called for that user once the
 * holder finds out, at release, and the caller can have it rebuilt.
 */
export class RedisAreaLock {
  private redis: RedisClient;
  private logger: Logger;
  private onLost: (userId: string) => Promise<void>;

  constructor(
    redis: RedisClient,
    logger: Logger,
    onLost: (userId: string) => Promise<void> = async () => {},
  ) {
    this.redis = redis;
    this.logger = logger;
    this.onLost = onLost;
  }

  /**
   * Runs `work` holding the user's lock. Rejects without running `work` if it
   * cannot be had within `waitMs` (plus {@link ANSWER_GRACE_MS} for Redis to
   * answer the last attempt): with {@link AreaLockBusyError} if another holder
   * kept it, and with another error if Redis failed or did not answer.
   */
  async withLock<T>(userId: string, work: () => Promise<T>, waitMs: number): Promise<T> {
    const key = areaWriteLockKey(userId);
    const token = crypto.randomUUID();
    const deadline = Date.now() + waitMs;

    for (;;) {
      const attempt = this.tryAcquire(key, token);
      const answer = await answerWithin(attempt, Math.max(deadline - Date.now(), ANSWER_GRACE_MS));
      if (answer === NO_ANSWER) {
        // Too late either way. Should Redis grant it after all, give it back.
        attempt
          .then((isAcquired) => (isAcquired ? this.release(key, token) : undefined))
          .catch(() => {});
        throw new Error(`Redis did not answer the area lock request for ${userId} in time`);
      }
      if (answer) break;
      if (Date.now() >= deadline) throw new AreaLockBusyError(userId, waitMs);
      await Bun.sleep(Math.min(RETRY_MS, Math.max(0, deadline - Date.now())));
    }

    try {
      return await work();
    } finally {
      if (!(await this.release(key, token))) {
        this.logger.warn(`Area lock of ${userId} was lost before its write finished`);
        await this.onLost(userId);
      }
    }
  }

  private async tryAcquire(key: string, token: string): Promise<boolean> {
    const reply = await this.redis.send('SET', [key, token, 'NX', 'PX', String(LOCK_TTL_MS)]);
    return reply === 'OK';
  }

  /**
   * Whether this holder still had the lock, and has now released it. Never
   * throws: if Redis fails or does not answer, the lock is treated as lost,
   * and it expires on its own after {@link LOCK_TTL_MS}.
   */
  private async release(key: string, token: string): Promise<boolean> {
    try {
      const answer = await answerWithin(
        this.redis.send('EVAL', [RELEASE_SCRIPT, '1', key, token]),
        RELEASE_TIMEOUT_MS,
      );
      return answer !== NO_ANSWER && Number(answer) === 1;
    } catch (error) {
      this.logger.warn(`Could not release ${key}; it expires in ${LOCK_TTL_MS}ms`, error);
      return false;
    }
  }
}
