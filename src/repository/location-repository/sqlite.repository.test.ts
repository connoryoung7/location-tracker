import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';
import { SqliteLocationRepository } from '@/repository/location-repository/sqlite.repository.ts';
import type { GeofenceEvent } from '@/domain/events.ts';

test('history carries GPS accuracy only when the device reported it', async () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const repo = new SqliteLocationRepository(db);
  try {
    repo.saveLocation({ _type: 'location', tid: 'u', tst: 1, lat: 0, lon: 0, acc: 12 });
    repo.saveLocation({ _type: 'location', tid: 'u', tst: 2, lat: 0, lon: 0 });
    const points = [];
    for await (const point of repo.listLocations('u')) points.push(point);
    expect(points).toEqual([
      { _type: 'location', tid: 'u', tst: 1, lat: 0, lon: 0, acc: 12 },
      { _type: 'location', tid: 'u', tst: 2, lat: 0, lon: 0 },
    ]);
  } finally {
    db.close();
  }
});

test('history orders ties, filters users/ranges, replacement is atomic and repeatable', async () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const repo = new SqliteLocationRepository(db);
  try {
    for (const [tid, tst, lon] of [
      ['u', 20, 1],
      ['u', 10, 2],
      ['u', 10, 3],
      ['v', 10, 4],
    ] as const) {
      repo.saveLocation({ _type: 'location', tid, tst, lon, lat: 0 });
    }
    const points = [];
    for await (const point of repo.listLocations('u', { to: 10 })) points.push(point.lon);
    expect(points).toEqual([2, 3]);
    const event: GeofenceEvent = {
      _type: 'area.entered',
      userId: 'u',
      areaId: 'a',
      lat: 0,
      lon: 0,
      tst: 10,
    };
    repo.saveAreaEvent({ ...event, userId: 'v' });
    expect(await repo.replaceAreaEvents('u', [event])).toBe(0);
    expect(await repo.replaceAreaEvents('u', [event])).toBe(1);
    await expect(repo.replaceAreaEvents('u', [{ ...event, userId: 'v' }])).rejects.toThrow();
    expect(db.query('SELECT * FROM area_events').all()).toHaveLength(2);
  } finally {
    db.close();
  }
});

test("lists one user's area events newest first, up to the limit", async () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const repo = new SqliteLocationRepository(db);
  try {
    const event: GeofenceEvent = {
      _type: 'area.entered',
      userId: 'u',
      areaId: 'a',
      lat: 1.5,
      lon: 2.5,
      tst: 10,
    };
    repo.saveAreaEvent(event);
    repo.saveAreaEvent({ ...event, _type: 'area.exited', areaName: 'Home', tst: 30 });
    repo.saveAreaEvent({ ...event, tst: 20 });
    repo.saveAreaEvent({ ...event, userId: 'v', tst: 40 });

    expect(await repo.listAreaEvents('u', { limit: 2 })).toEqual([
      { ...event, _type: 'area.exited', areaName: 'Home', tst: 30 },
      { ...event, tst: 20 },
    ]);
    expect(await repo.listAreaEvents('u')).toHaveLength(3);
    expect(await repo.listAreaEvents('nobody')).toEqual([]);
  } finally {
    db.close();
  }
});

test('SQLite replay state rolls back with events and live writes wait outside replay', async () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const repo = new SqliteLocationRepository(db);
  try {
    await expect(
      repo.withUserLock('u', async () => {
        await repo.replaceAreaEvents('u', [], { inside: ['a'], pending: [] });
        throw new Error('interrupted');
      }),
    ).rejects.toThrow();
    expect(await repo.replayState.readReplayState('u')).toBeUndefined();
    await repo.withUserLock('u', async () => {
      await repo.replaceAreaEvents('u', [], { inside: ['a'], pending: [] });
    });
    expect(await repo.replayState.readReplayState('u')).toEqual({ inside: ['a'], pending: [] });
  } finally {
    db.close();
  }
});

test('a caller with waitMs gives up waiting in the queue, and the queue still holds', async () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const repo = new SqliteLocationRepository(db);
  const order: string[] = [];
  const holding = Promise.withResolvers<void>();
  try {
    // A long holder, as a recompute would be.
    const holder = repo.withUserLock('u', async () => {
      order.push('holder starts');
      await holding.promise;
      order.push('holder ends');
    });
    const impatient = repo.withUserLock('u', async () => order.push('impatient runs'), {
      waitMs: 20,
    });
    const patient = repo.withUserLock('u', async () => order.push('patient runs'));

    // Raced against a deadline, so an unbounded wait fails the test instead of hanging it.
    const outcome = await Promise.race([
      impatient.then(
        () => 'ran',
        (error: Error) => error.message,
      ),
      Bun.sleep(1_000).then(() => 'still waiting'),
    ]);
    holding.resolve();
    await Promise.allSettled([holder, impatient, patient]);

    expect(outcome).toBe('Timed out after 20ms waiting for the user lock');

    // The one who gave up never ran, and the one behind it still waited its turn.
    expect(order).toEqual(['holder starts', 'holder ends', 'patient runs']);
  } finally {
    db.close();
  }
});

test("waitMs also caps waiting for another process's write lock, then the default returns", async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const directory = await mkdtemp('/tmp/location-lock-wait-');
  const path = `${directory}/test.db`;
  const db = new Database(path);
  runMigrations(db);
  const repo = new SqliteLocationRepository(db);
  // Another process holds the database write lock, as a recompute there would.
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { Database } from 'bun:sqlite';
    const db = new Database(process.env.TEST_SQLITE_PATH);
    db.run('BEGIN IMMEDIATE');
    console.log('locked');
    await new Promise(() => {});
  `,
    ],
    { env: { ...process.env, TEST_SQLITE_PATH: path }, stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    const ready = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toContain('locked');

    const startedAt = performance.now();
    await expect(repo.withUserLock('u', async () => {}, { waitMs: 100 })).rejects.toThrow();
    // Well under the 1 s default busy timeout.
    expect(performance.now() - startedAt).toBeLessThan(600);
    expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 1000 });
  } finally {
    child.kill();
    await child.exited;
    db.close();
    await rm(directory, { recursive: true });
  }
});

test('SQLite releases its write lock and rolls back replay after a worker is killed', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const directory = await mkdtemp('/tmp/location-replay-');
  const path = `${directory}/test.db`;
  const db = new Database(path);
  runMigrations(db);
  const repo = new SqliteLocationRepository(db);
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { Database } from 'bun:sqlite';
    import { SqliteLocationRepository } from './src/repository/location-repository/sqlite.repository.ts';
    const repo = new SqliteLocationRepository(new Database(process.env.TEST_SQLITE_PATH));
    await repo.withUserLock('u', async () => {
      await repo.replaceAreaEvents('u', [], { inside: ['a'], pending: [] });
      console.log('locked');
      await new Promise(() => {});
    });
  `,
    ],
    { env: { ...process.env, TEST_SQLITE_PATH: path }, stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    const ready = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toContain('locked');
    child.kill('SIGKILL');
    await child.exited;
    await repo.withUserLock('u', async () => {
      expect(await repo.replayState.readReplayState('u')).toBeUndefined();
    });
  } finally {
    child.kill();
    await child.exited;
    db.close();
    await rm(directory, { recursive: true });
  }
});

test('user options include trackers without areas and area owners without locations, once each', async () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const repo = new SqliteLocationRepository(db);
  try {
    expect(await repo.listUserIds()).toEqual([]);
    repo.saveLocation({ _type: 'location', tid: 'AB', tst: 1, lat: 0, lon: 0 });
    repo.saveLocation({ _type: 'location', tid: 'AB', tst: 2, lat: 0, lon: 0 });
    db.run('INSERT INTO areas (id, user_id, name, lat, lon, radius) VALUES (?, ?, ?, ?, ?, ?)', [
      'a',
      'CD',
      'Home',
      0,
      0,
      100,
    ]);
    expect(await repo.listUserIds()).toEqual(['AB', 'CD']);
  } finally {
    db.close();
  }
});
