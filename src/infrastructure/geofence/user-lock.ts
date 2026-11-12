import type { RedisClient } from 'bun';
import { randomUUID } from 'node:crypto';

/** Shared by replay and ingestion, including separate server processes. */
export async function withUserLock<T>(
  redis: RedisClient,
  userId: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = `geofence:lock:${userId}`;
  const token = randomUUID();
  // No expiry: a paused process must never resume and overwrite a newer owner.
  // After a process crash an operator must remove this user's orphaned lock.
  for (let attempt = 0; ; attempt++) {
    if (await redis.send('SET', [key, token, 'NX'])) break;
    if (attempt >= 300) throw new Error('User is busy; retry later');
    await Bun.sleep(100);
  }
  try {
    return await work();
  } finally {
    await redis.send('EVAL', [
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end",
      '1',
      key,
      token,
    ]);
  }
}
