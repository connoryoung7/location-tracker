import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SQL, RedisClient } from 'bun';
import { PostgresLocationRepository } from '@/repository/location-repository/postgres.repository.ts';
import { recomputeAreaEvents } from '@/application/recompute-area-events.ts';
import { handleLocation } from '@/application/handlers/location.handler.ts';
import { RedisGeofenceEvaluator } from '@/infrastructure/geofence/redis.geofence-evaluator.ts';
import { RedisAreaProjection } from '@/repository/area-repository/redis.projection.ts';
import {
  mockAreaRepository,
  mockLogger,
  mockMetricsCollector,
  mockGeocoder,
  mockEventPublisher,
} from '@/test/mocks.ts';
import type { GeofenceEvent } from '@/domain/events.ts';

// Use a dedicated throwaway database: this suite clears its tables.
const url = process.env.TEST_POSTGRES_URL;
describe.skipIf(!url)('Postgres replay crash recovery', () => {
  let sql: SQL;
  let repo: PostgresLocationRepository;
  const event: GeofenceEvent = {
    _type: 'area.entered',
    userId: 'u',
    areaId: 'a',
    lat: 0,
    lon: 0,
    tst: 1,
  };
  const state = { inside: ['a'], pending: [['a', 10] as [string, number]] };

  beforeAll(async () => {
    sql = new SQL(url!);
    repo = new PostgresLocationRepository(sql);
    await repo.migrate();
  });
  beforeEach(async () => {
    await sql`TRUNCATE locations, area_events, geofence_replay_state RESTART IDENTITY`;
  });
  afterAll(async () => {
    await sql.close();
  });

  test('replacement and replay state roll back together on failure', async () => {
    await repo.saveAreaEvent(event);
    await expect(
      repo.withUserLock('u', async () => {
        await repo.replaceAreaEvents('u', [{ ...event, tst: 2 }], state);
        throw new Error('crash before commit');
      }),
    ).rejects.toThrow('crash before commit');
    expect((await sql`SELECT tst FROM area_events`)[0].tst).toBe(1);
    expect(await repo.replayState.readReplayState('u')).toBeUndefined();
    await expect(
      repo.replaceAreaEvents('u', [event, { ...event, userId: 'v' }], state),
    ).rejects.toThrow();
    expect((await sql`SELECT tst FROM area_events`)[0].tst).toBe(1);
  });

  test('killed process rolls back events and releases its user lock automatically', async () => {
    await repo.saveAreaEvent(event);
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `
      import { SQL } from 'bun';
      import { PostgresLocationRepository } from './src/repository/location-repository/postgres.repository.ts';
      const repo = new PostgresLocationRepository(new SQL(process.env.TEST_POSTGRES_URL));
      await repo.withUserLock('u', async () => {
        await repo.replaceAreaEvents('u', [], { inside: [], pending: [] });
        console.log('locked');
        await new Promise(() => {});
      });
    `,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain('locked');
      child.kill('SIGKILL');
      await child.exited;
      await repo.withUserLock('u', async () => {
        expect((await sql`SELECT tst FROM area_events`)[0].tst).toBe(1);
        expect(await repo.replayState.readReplayState('u')).toBeUndefined();
      });
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test('same-user work waits for commit while other users can proceed', async () => {
    const second = new PostgresLocationRepository(sql);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = repo.withUserLock('u', async () => {
      await repo.replaceAreaEvents('u', [event], state);
      entered();
      await gate;
    });
    await ready;
    let hasEntered = false;
    const waiting = second.withUserLock('u', async () => {
      hasEntered = true;
      expect(await second.replayState.readReplayState('u')).toEqual(state);
    });
    try {
      await second.withUserLock('other', async () => {});
      expect(hasEntered).toBe(false);
    } finally {
      release();
    }
    await Promise.all([first, waiting]);
  });

  test('history pages include tied timestamps and respect user and range', async () => {
    await sql`INSERT INTO locations (lat, lon, tst, tid)
      SELECT 0, n, 10, 'u' FROM generate_series(1, 1005) AS n`;
    await repo.saveLocation({ _type: 'location', tid: 'u', lat: 0, lon: 0, tst: 11 });
    await repo.saveLocation({ _type: 'location', tid: 'other', lat: 0, lon: 0, tst: 10 });
    const points = [];
    for await (const point of repo.listLocations('u', { from: 10, to: 10 })) points.push(point.lon);
    expect(points).toEqual(Array.from({ length: 1005 }, (_, i) => i + 1));
  });

  test('committed handoff survives Redis failure and restores pending exit on retry', async () => {
    const redis = new RedisClient(process.env.REDIS_URL ?? 'redis://localhost:6379/1');
    const userId = crypto.randomUUID();
    const area = { id: 'a', userId, name: 'Home', lat: 0, lon: 0, radius: 100 };
    const areaRepo = mockAreaRepository();
    areaRepo.listAreas.mockResolvedValue([area]);
    const logger = mockLogger();
    const projection = new RedisAreaProjection(redis);
    const live = new RedisGeofenceEvaluator(redis, 30);
    try {
      await projection.applyArea(area);
      for (const [tst, lon] of [
        [1, 0],
        [10, 1],
      ]) {
        await repo.saveLocation({ _type: 'location', tid: userId, lat: 0, lon: lon!, tst: tst! });
      }
      const deps = {
        redis,
        repo,
        areaRepo,
        logger,
        metrics: mockMetricsCollector(),
        thresholdSeconds: 30,
      };
      await recomputeAreaEvents(userId, deps);
      const committed = await repo.replayState.readReplayState(userId);
      expect(committed).toEqual(state);
      const payload = { _type: 'location' as const, tid: userId, lat: 0, lon: 1, tst: 40 };
      const ingestion = {
        repo,
        logger,
        reverseGeocoder: mockGeocoder(),
        eventPublisher: mockEventPublisher(),
        geofence: live,
      };
      await expect(
        handleLocation(payload, {
          ...ingestion,
          geofence: {
            evaluate: live.evaluate.bind(live),
            restoreState: async () => {
              throw new Error('Redis down');
            },
          },
        }),
      ).rejects.toThrow('Redis down');
      expect(await repo.replayState.readReplayState(userId)).toEqual(committed);
      expect(
        Number((await sql`SELECT COUNT(*) AS count FROM locations WHERE tid = ${userId}`)[0].count),
      ).toBe(2);
      // Redis accepted the handoff, but ingestion fails before committing its
      // acknowledgement. Both the location and acknowledgement must roll back.
      class FailingRepository extends PostgresLocationRepository {
        override async saveLocation(): Promise<void> {
          throw new Error('ingestion interrupted');
        }
      }
      await expect(
        handleLocation(payload, { ...ingestion, repo: new FailingRepository(sql) }),
      ).rejects.toThrow('ingestion interrupted');
      expect(await repo.replayState.readReplayState(userId)).toEqual(committed);
      await handleLocation(payload, ingestion);
      expect(ingestion.eventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({ _type: 'area.exited' }),
      );
      expect(await repo.replayState.readReplayState(userId)).toBeUndefined();
    } finally {
      await projection.removeArea(userId, 'a');
      redis.close();
    }
  });
});
