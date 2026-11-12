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
