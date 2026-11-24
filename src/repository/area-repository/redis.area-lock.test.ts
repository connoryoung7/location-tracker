import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { AreaLockBusyError, RedisAreaLock } from '@/repository/area-repository/redis.area-lock.ts';
import { mockLogger } from '@/test/mocks.ts';

// Defaults to db index 1 so the FLUSHDB below cannot wipe the dev Redis (db 0).
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/1';

describe('RedisAreaLock', () => {
  let redis: RedisClient;
  let lock: RedisAreaLock;

  beforeAll(async () => {
    redis = new RedisClient(REDIS_URL);
    await redis.connect();
  });

  afterAll(() => {
    redis.close();
  });

  beforeEach(async () => {
    await redis.send('FLUSHDB', []);
    lock = new RedisAreaLock(redis, mockLogger());
  });

  test("one user's writers take turns, even through separate lock instances", async () => {
    const other = new RedisAreaLock(redis, mockLogger());
    const order: string[] = [];
    const holding = Promise.withResolvers<void>();

    const first = lock.withLock(
      'AB',
      async () => {
        order.push('first starts');
        await holding.promise;
        order.push('first ends');
      },
      1_000,
    );
    await Bun.sleep(30);
    const second = other.withLock('AB', async () => order.push('second runs'), 1_000);
    await Bun.sleep(30);
    holding.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(['first starts', 'first ends', 'second runs']);
  });

  test('different users never wait for each other', async () => {
    const holding = Promise.withResolvers<void>();
    const first = lock.withLock('AB', () => holding.promise, 1_000);

    expect(await lock.withLock('CD', async () => 'ran', 50)).toBe('ran');

    holding.resolve();
    await first;
  });

  test('gives up after waitMs without running the work, and releases nothing it does not own', async () => {
    const holding = Promise.withResolvers<void>();
    const holder = lock.withLock('AB', () => holding.promise, 1_000);
    await Bun.sleep(30);
    let hasRun = false;

    await expect(
      lock.withLock(
        'AB',
        async () => {
          hasRun = true;
        },
        50,
      ),
    ).rejects.toBeInstanceOf(AreaLockBusyError);

    expect(hasRun).toBe(false);
    // The holder still has it.
    expect(await redis.exists('area:lock:AB')).toBe(true);
    holding.resolve();
    await holder;
    expect(await redis.exists('area:lock:AB')).toBe(false);
  });

  test('releases the lock when the work throws', async () => {
    await expect(
      lock.withLock(
        'AB',
        async () => {
          throw new Error('store failed');
        },
        1_000,
      ),
    ).rejects.toThrow('store failed');

    expect(await redis.exists('area:lock:AB')).toBe(false);
  });

  test('a lock left behind by a crashed holder expires, so writers carry on', async () => {
    // A crashed holder's lock, about to expire.
    await redis.send('SET', ['area:lock:AB', 'crashed-holder', 'PX', '100']);

    expect(await lock.withLock('AB', async () => 'ran', 1_000)).toBe('ran');
  });

  test('a holder whose lock expired never releases the next holder', async () => {
    await lock.withLock(
      'AB',
      async () => {
        // This holder stalled past its TTL, and another one took the lock.
        await redis.send('SET', ['area:lock:AB', 'next-holder', 'PX', '10000']);
      },
      1_000,
    );

    expect(await redis.get('area:lock:AB')).toBe('next-holder');
  });
});
