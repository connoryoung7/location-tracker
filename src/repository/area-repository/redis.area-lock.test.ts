import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
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

  test('a holder whose lock expired never releases the next holder, and says it lost it', async () => {
    const onLost = mock(async (_userId: string) => {});
    const stalling = new RedisAreaLock(redis, mockLogger(), onLost);

    await stalling.withLock(
      'AB',
      async () => {
        // This holder stalled past its TTL, and another one took the lock.
        await redis.send('SET', ['area:lock:AB', 'next-holder', 'PX', '10000']);
      },
      1_000,
    );

    expect(await redis.get('area:lock:AB')).toBe('next-holder');
    expect(onLost).toHaveBeenCalledWith('AB');
  });

  test('a lock that simply expired under its holder is reported lost too', async () => {
    const onLost = mock(async (_userId: string) => {});
    const stalling = new RedisAreaLock(redis, mockLogger(), onLost);

    await stalling.withLock('AB', () => redis.del('area:lock:AB'), 1_000);

    expect(onLost).toHaveBeenCalledWith('AB');
    // A holder that kept it to the end is not.
    onLost.mockClear();
    await stalling.withLock('AB', async () => {}, 1_000);
    expect(onLost).not.toHaveBeenCalled();
  });

  test('an acquisition Redis does not answer in time fails without running the work, and a late grant is handed back', async () => {
    // Connected, but slow to answer SET.
    const slow = new Proxy(redis, {
      get(target, prop) {
        if (prop === 'send') {
          return async (command: string, args: string[]) => {
            if (command === 'SET') await Bun.sleep(200);
            return target.send(command, args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const slowLock = new RedisAreaLock(slow, mockLogger());
    let hasRun = false;

    const startedAt = performance.now();
    const outcome = slowLock.withLock(
      'AB',
      async () => {
        hasRun = true;
      },
      50,
    );
    await expect(outcome).rejects.toThrow('did not answer');
    expect(performance.now() - startedAt).toBeLessThan(150);
    expect(hasRun).toBe(false);

    // The late grant is given straight back, so nobody waits out its TTL.
    await Bun.sleep(300);
    expect(await redis.exists('area:lock:AB')).toBe(false);
  });

  test('a release Redis does not answer counts as lost, and never hangs the write', async () => {
    const onLost = mock(async (_userId: string) => {});
    const silent = new Proxy(redis, {
      get(target, prop) {
        if (prop === 'send') {
          return (command: string, args: string[]) =>
            command === 'EVAL' ? new Promise(() => {}) : target.send(command, args);
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const result = await new RedisAreaLock(silent, mockLogger(), onLost).withLock(
      'AB',
      async () => 'written',
      1_000,
    );

    expect(result).toBe('written');
    expect(onLost).toHaveBeenCalledWith('AB');
  });
});
