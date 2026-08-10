import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { RedisClient } from 'bun';
import { Database } from 'bun:sqlite';
import { RedisAreaRepository } from '@/repository/area-repository/redis.repository.ts';
import { RedisGeofenceEvaluator } from '@/infrastructure/geofence/redis.geofence-evaluator.ts';
import { RedisEventPublisher } from '@/infrastructure/events/redis.event-publisher.ts';
import { DbEventPublisher } from '@/infrastructure/events/db.event-publisher.ts';
import { NotificationEventPublisher } from '@/infrastructure/events/notification.event-publisher.ts';
import { CompositeEventPublisher } from '@/infrastructure/events/composite.event-publisher.ts';
import { SqliteLocationRepository } from '@/repository/location-repository/sqlite.repository.ts';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';
import { buildArea } from '@/test/factories.ts';
import { mockLogger, mockNotificationSender } from '@/test/mocks.ts';
import { stationaryCoordinates, walkingCoordinates } from '@/test/coordinates.ts';
import type { EventPublisher } from '@/domain/ports.ts';
import type { GeofenceEvent } from '@/domain/events.ts';

// Defaults to db index 1 so the FLUSHDB in beforeEach cannot wipe the dev
// Redis (db 0), which persists real area data via --appendonly.
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/1';
const THRESHOLD_SECONDS = 60;

describe('RedisAreaRepository + RedisGeofenceEvaluator', () => {
  let redis: RedisClient;
  let areaRepo: RedisAreaRepository;
  let geofence: RedisGeofenceEvaluator;
  let userCounter = 0;

  beforeAll(() => {
    redis = new RedisClient(REDIS_URL);
    areaRepo = new RedisAreaRepository(redis);
    geofence = new RedisGeofenceEvaluator(redis, THRESHOLD_SECONDS);
  });

  afterAll(() => {
    redis.close();
  });

  beforeEach(async () => {
    await redis.send('FLUSHDB', []);
    userCounter += 1;
  });

  function nextUserId(): string {
    return `user-${userCounter}-${Math.random().toString(36).slice(2)}`;
  }

  test('1. enter: outside then inside yields exactly one area.entered', async () => {
    const userId = nextUserId();
    await areaRepo.addArea(buildArea({ id: 'a1', userId, lat: 42.4, lon: -71.1, radius: 100 }));

    const outside = await geofence.evaluate(userId, -71.2, 42.4, 1000);
    expect(outside).toEqual([]);

    const inside = await geofence.evaluate(userId, -71.1, 42.4, 1060);
    expect(inside).toHaveLength(1);
    expect(inside[0]).toMatchObject({ _type: 'area.entered', areaId: 'a1' });
  });

  test('2. stay inside: repeated inside locations produce no duplicate enters', async () => {
    const userId = nextUserId();
    await areaRepo.addArea(buildArea({ id: 'a1', userId, lat: 42.4, lon: -71.1, radius: 100 }));

    const first = await geofence.evaluate(userId, -71.1, 42.4, 1000);
    expect(first).toHaveLength(1);

    const second = await geofence.evaluate(userId, -71.1, 42.4, 1060);
    expect(second).toEqual([]);
  });

  test('3. brief exit within cushion: no exit and no re-enter', async () => {
    const userId = nextUserId();
    await areaRepo.addArea(buildArea({ id: 'a1', userId, lat: 42.4, lon: -71.1, radius: 100 }));

    const entered = await geofence.evaluate(userId, -71.1, 42.4, 1000);
    expect(entered).toHaveLength(1);

    const outside = await geofence.evaluate(userId, -71.2, 42.4, 1010);
    expect(outside).toEqual([]);

    const backInside = await geofence.evaluate(userId, -71.1, 42.4, 1020);
    expect(backInside).toEqual([]);
  });

  test('4. confirmed exit: continuously outside past the cushion yields one area.exited', async () => {
    const userId = nextUserId();
    await areaRepo.addArea(buildArea({ id: 'a1', userId, lat: 42.4, lon: -71.1, radius: 100 }));

    const entered = await geofence.evaluate(userId, -71.1, 42.4, 1000);
    expect(entered).toHaveLength(1);

    const outsideStart = await geofence.evaluate(userId, -71.2, 42.4, 1010);
    expect(outsideStart).toEqual([]);

    const confirmedExit = await geofence.evaluate(
      userId,
      -71.2,
      42.4,
      1010 + THRESHOLD_SECONDS + 1,
    );
    expect(confirmedExit).toHaveLength(1);
    expect(confirmedExit[0]).toMatchObject({ _type: 'area.exited', areaId: 'a1' });
  });

  test('5. cold start: first-ever location already inside fires enter', async () => {
    const userId = nextUserId();
    await areaRepo.addArea(buildArea({ id: 'a1', userId, lat: 42.4, lon: -71.1, radius: 100 }));

    const events = await geofence.evaluate(userId, -71.1, 42.4, 1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ _type: 'area.entered', areaId: 'a1' });
  });

  test('6. per-user isolation: identical coordinates only trigger the owning user', async () => {
    const userA = nextUserId();
    const userB = nextUserId();
    await areaRepo.addArea(
      buildArea({ id: 'a1', userId: userA, lat: 42.4, lon: -71.1, radius: 100 }),
    );

    const eventsForA = await geofence.evaluate(userA, -71.1, 42.4, 1000);
    expect(eventsForA).toHaveLength(1);

    const eventsForB = await geofence.evaluate(userB, -71.1, 42.4, 1000);
    expect(eventsForB).toEqual([]);
  });

  test('7. overlapping areas: two enters, then one exit when leaving only one', async () => {
    const userId = nextUserId();
    const center = { lat: 42.5, lon: -71.2 };
    await areaRepo.addArea(
      buildArea({ id: 'big', userId, lat: center.lat, lon: center.lon, radius: 300 }),
    );
    await areaRepo.addArea(
      buildArea({ id: 'small', userId, lat: center.lat, lon: center.lon, radius: 100 }),
    );

    const bothEnter = await geofence.evaluate(userId, center.lon, center.lat, 1000);
    expect(bothEnter).toHaveLength(2);
    expect(bothEnter.map((e) => e.areaId).sort()).toEqual(['big', 'small']);

    // ~150m north of center: inside "big" (radius 300), outside "small" (radius 100)
    const farLat = center.lat + (150 / 6372797.560856) * (180 / Math.PI);

    const pendingExit = await geofence.evaluate(userId, center.lon, farLat, 1070);
    expect(pendingExit).toEqual([]);

    const confirmedExit = await geofence.evaluate(
      userId,
      center.lon,
      farLat,
      1070 + THRESHOLD_SECONDS + 1,
    );
    expect(confirmedExit).toHaveLength(1);
    expect(confirmedExit[0]).toMatchObject({ _type: 'area.exited', areaId: 'small' });
  });

  test('8. boundary: distance == radius counts as inside; just beyond does not', async () => {
    const userId = nextUserId();
    const center = { lat: 42.6, lon: -71.3 };
    const probe = { lat: center.lat + 0.001, lon: center.lon };

    // Measure via GEOSEARCH FROMLONLAT (not GEODIST) since that's the exact
    // command the geofence Lua script uses for candidate distances — GEODIST
    // between two stored members computes distance slightly differently and
    // would not be self-consistent with what evaluate() actually measures.
    const scratchKey = `test:scratch:${userId}`;
    await redis.send('GEOADD', [scratchKey, String(center.lon), String(center.lat), 'center']);
    const searchResult = (await redis.send('GEOSEARCH', [
      scratchKey,
      'FROMLONLAT',
      String(probe.lon),
      String(probe.lat),
      'BYRADIUS',
      '99999',
      'm',
      'WITHDIST',
    ])) as [string, string][];
    const distance = Number(searchResult.find(([member]) => member === 'center')![1]);
    await redis.del(scratchKey);

    await areaRepo.addArea(
      buildArea({ id: 'inclusive', userId, lat: center.lat, lon: center.lon, radius: distance }),
    );
    await areaRepo.addArea(
      buildArea({
        id: 'exclusive',
        userId,
        lat: center.lat,
        lon: center.lon,
        radius: distance - 1,
      }),
    );

    const events = await geofence.evaluate(userId, probe.lon, probe.lat, 1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ _type: 'area.entered', areaId: 'inclusive' });
  });

  test('9. GPS jitter: stationary coordinates produce no spurious churn', async () => {
    const userId = nextUserId();
    const center = stationaryCoordinates[0]!;
    await areaRepo.addArea(
      buildArea({ id: 'a1', userId, lat: center.lat, lon: center.lon, radius: 50 }),
    );

    const allEvents: GeofenceEvent[] = [];
    for (const point of stationaryCoordinates) {
      const events = await geofence.evaluate(userId, point.lon, point.lat, point.tst);
      allEvents.push(...events);
    }

    expect(allEvents).toHaveLength(1);
    expect(allEvents[0]).toMatchObject({ _type: 'area.entered', areaId: 'a1' });
  });

  test('10. path crossing: walking through an area yields exactly one enter then one exit', async () => {
    const userId = nextUserId();
    // Centered on walkingCoordinates[7]; points 6-8 fall within 100m, the rest do not.
    await areaRepo.addArea(
      buildArea({ id: 'a1', userId, lat: 42.356, lon: -71.0588, radius: 100 }),
    );

    const allEvents: GeofenceEvent[] = [];
    for (const point of walkingCoordinates) {
      const events = await geofence.evaluate(userId, point.lon, point.lat, point.tst);
      allEvents.push(...events);
    }

    expect(allEvents).toHaveLength(2);
    expect(allEvents[0]).toMatchObject({ _type: 'area.entered', areaId: 'a1' });
    expect(allEvents[1]).toMatchObject({ _type: 'area.exited', areaId: 'a1' });
  });

  test('11. no areas: locations for a user with zero areas produce no events', async () => {
    const userId = nextUserId();
    const events = await geofence.evaluate(userId, -71.1, 42.4, 1000);
    expect(events).toEqual([]);
  });

  test("11b. listAllAreas returns every user's areas and drops removed ones", async () => {
    const userA = nextUserId();
    const userB = nextUserId();
    await areaRepo.addArea(buildArea({ id: 'a1', userId: userA, name: 'Home', radius: 100 }));
    await areaRepo.addArea(buildArea({ id: 'a2', userId: userA, name: 'Gym', radius: 150 }));
    await areaRepo.addArea(buildArea({ id: 'b1', userId: userB, name: 'Work', radius: 200 }));

    const all = await areaRepo.listAllAreas();
    expect(all).toHaveLength(3);
    expect(all.map((area) => `${area.userId}/${area.id}`).sort()).toEqual(
      [`${userA}/a1`, `${userA}/a2`, `${userB}/b1`].sort(),
    );

    await areaRepo.removeArea(userA, 'a2');
    expect(await areaRepo.listAllAreas()).toHaveLength(2);
  });

  test('12. add/remove lifecycle: removing an area stops further events and clears state', async () => {
    const userId = nextUserId();
    await areaRepo.addArea(buildArea({ id: 'a1', userId, lat: 42.4, lon: -71.1, radius: 100 }));

    const entered = await geofence.evaluate(userId, -71.1, 42.4, 1000);
    expect(entered).toHaveLength(1);

    await areaRepo.removeArea(userId, 'a1');

    const isInside = await redis.sismember(`geofence:inside:${userId}`, 'a1');
    expect(isInside).toBe(false);

    const events = await geofence.evaluate(userId, -71.1, 42.4, 1060);
    expect(events).toEqual([]);
  });

  test('13. radius change: remove + re-add recomputes membership against the new radius', async () => {
    const userId = nextUserId();
    const center = { lat: 42.4, lon: -71.1 };
    // ~80m north of center
    const point = { lat: center.lat + (80 / 6372797.560856) * (180 / Math.PI), lon: center.lon };

    await areaRepo.addArea(
      buildArea({ id: 'a1', userId, lat: center.lat, lon: center.lon, radius: 50 }),
    );
    const outsideOfSmallRadius = await geofence.evaluate(userId, point.lon, point.lat, 1000);
    expect(outsideOfSmallRadius).toEqual([]);

    await areaRepo.removeArea(userId, 'a1');
    await areaRepo.addArea(
      buildArea({ id: 'a1', userId, lat: center.lat, lon: center.lon, radius: 150 }),
    );

    const insideOfLargeRadius = await geofence.evaluate(userId, point.lon, point.lat, 1060);
    expect(insideOfLargeRadius).toHaveLength(1);
    expect(insideOfLargeRadius[0]).toMatchObject({ _type: 'area.entered', areaId: 'a1' });
  });

  test('14. event fan-out: every event reaches Pub/Sub, the DB, and notifications; a failing sink does not block the rest', async () => {
    const userId = nextUserId();
    await areaRepo.addArea(buildArea({ id: 'a1', userId, lat: 42.4, lon: -71.1, radius: 100 }));

    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new SqliteLocationRepository(db);
    const notificationSender = mockNotificationSender();
    const logger = mockLogger();

    // A subscribed connection can only ping/subscribe/unsubscribe, so the
    // subscriber needs its own connection separate from the one used to
    // evaluate/publish.
    const subscriber = new RedisClient(REDIS_URL);
    const received: string[] = [];
    await subscriber.subscribe('geofence:events', (message) => {
      received.push(message);
    });

    const failingSink: EventPublisher = {
      publish: () => Promise.reject(new Error('sink down')),
    };

    const publisher = new CompositeEventPublisher(
      [
        new RedisEventPublisher(redis),
        new DbEventPublisher(repo),
        new NotificationEventPublisher(notificationSender),
        failingSink,
      ],
      logger,
    );

    const events = await geofence.evaluate(userId, -71.1, 42.4, 1000);
    expect(events).toHaveLength(1);

    for (const event of events) {
      await publisher.publish(event);
    }

    // Pub/Sub delivery is asynchronous; give it a moment to arrive.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await subscriber.unsubscribe('geofence:events');
    subscriber.close();

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!)).toMatchObject({ _type: 'area.entered', areaId: 'a1' });

    const row = db.query('SELECT * FROM area_events').get() as { area_id: string } | null;
    expect(row).not.toBeNull();
    expect(row!.area_id).toBe('a1');

    expect(notificationSender.sendNotification).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);

    db.close();
  });
});
