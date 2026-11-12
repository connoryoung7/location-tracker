import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';
import { SqliteLocationRepository } from '@/repository/location-repository/sqlite.repository.ts';
import type { GeofenceEvent } from '@/domain/events.ts';

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
