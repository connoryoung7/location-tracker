import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHttpServer } from '@/infrastructure/http/server.ts';
import { SqliteLocationRepository } from '@/infrastructure/persistence/sqlite.repository.ts';
import { ConsoleLogger } from '@/infrastructure/logging/console.logger.ts';
import type { Deps } from '@/application/handle-payload.ts';
import type { Server } from 'node:http';

const TEST_DB = ':memory:';
const TEST_PORT = 0; // let OS pick an available port

let server: Server;
let baseUrl: string;
let db: Database;

beforeAll((done) => {
  const repo = new SqliteLocationRepository(TEST_DB);
  // Access internal db for assertions
  db = (repo as any).db;

  const deps: Deps = {
    repo,
    logger: new ConsoleLogger(),
  };

  const app = createHttpServer(deps);
  server = app.listen(TEST_PORT, () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      baseUrl = `http://localhost:${addr.port}`;
    }
    done();
  });
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  db.run('DELETE FROM locations');
});

function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /owntracks location', () => {
  test('returns 200 with empty array for valid location', async () => {
    const res = await post('/owntracks', {
      _type: 'location',
      lat: 42.3601,
      lon: -71.0589,
      tst: 1700000000,
      tid: 'AB',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test('persists required fields to database', async () => {
    await post('/owntracks', {
      _type: 'location',
      lat: 42.3601,
      lon: -71.0589,
      tst: 1700000000,
      tid: 'AB',
    });

    const row = db.query('SELECT * FROM locations').get() as any;
    expect(row.lat).toBe(42.3601);
    expect(row.lon).toBe(-71.0589);
    expect(row.tst).toBe(1700000000);
    expect(row.tid).toBe('AB');
  });

  test('persists optional fields when provided', async () => {
    await post('/owntracks', {
      _type: 'location',
      lat: 42.3601,
      lon: -71.0589,
      tst: 1700000000,
      tid: 'AB',
      acc: 15,
      alt: 100,
      batt: 85,
      vel: 30,
      conn: 'w',
      tag: 'phone',
      topic: 'owntracks/user/device',
    });

    const row = db.query('SELECT * FROM locations').get() as any;
    expect(row.acc).toBe(15);
    expect(row.alt).toBe(100);
    expect(row.batt).toBe(85);
    expect(row.vel).toBe(30);
    expect(row.conn).toBe('w');
    expect(row.tag).toBe('phone');
    expect(row.topic).toBe('owntracks/user/device');
  });

  test('stores null for omitted optional fields', async () => {
    await post('/owntracks', {
      _type: 'location',
      lat: 42.3601,
      lon: -71.0589,
      tst: 1700000000,
      tid: 'AB',
    });

    const row = db.query('SELECT * FROM locations').get() as any;
    expect(row.acc).toBeNull();
    expect(row.alt).toBeNull();
    expect(row.batt).toBeNull();
    expect(row.vel).toBeNull();
    expect(row.conn).toBeNull();
    expect(row.tag).toBeNull();
    expect(row.topic).toBeNull();
  });

  test('handles multiple sequential location posts', async () => {
    const locations = [
      { _type: 'location', lat: 42.0, lon: -71.0, tst: 1700000001, tid: 'AB' },
      { _type: 'location', lat: 43.0, lon: -72.0, tst: 1700000002, tid: 'AB' },
      { _type: 'location', lat: 44.0, lon: -73.0, tst: 1700000003, tid: 'AB' },
    ];

    for (const loc of locations) {
      const res = await post('/owntracks', loc);
      expect(res.status).toBe(200);
    }

    const rows = db.query('SELECT * FROM locations ORDER BY tst').all() as any[];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.lat).toBe(42.0);
    expect(rows[1]!.lat).toBe(43.0);
    expect(rows[2]!.lat).toBe(44.0);
  });

  test('handles negative coordinates', async () => {
    await post('/owntracks', {
      _type: 'location',
      lat: -33.8688,
      lon: 151.2093,
      tst: 1700000000,
      tid: 'SY',
    });

    const row = db.query('SELECT * FROM locations').get() as any;
    expect(row.lat).toBe(-33.8688);
    expect(row.lon).toBe(151.2093);
  });

  test('handles zero coordinates', async () => {
    await post('/owntracks', {
      _type: 'location',
      lat: 0,
      lon: 0,
      tst: 1700000000,
      tid: 'NL',
    });

    const row = db.query('SELECT * FROM locations').get() as any;
    expect(row.lat).toBe(0);
    expect(row.lon).toBe(0);
  });

  test('returns 400 when _type is missing', async () => {
    const res = await post('/owntracks', {
      lat: 42.0,
      lon: -71.0,
      tst: 1700000000,
      tid: 'AB',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing _type field' });
  });

  test('returns 400 for empty body', async () => {
    const res = await post('/owntracks', {});

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing _type field' });
  });

  test('does not persist when _type is missing', async () => {
    await post('/owntracks', {
      lat: 42.0,
      lon: -71.0,
      tst: 1700000000,
      tid: 'AB',
    });

    const count = db.query('SELECT COUNT(*) as c FROM locations').get() as any;
    expect(count.c).toBe(0);
  });

  test('differentiates locations by tracker id', async () => {
    await post('/owntracks', {
      _type: 'location',
      lat: 42.0,
      lon: -71.0,
      tst: 1700000000,
      tid: 'AB',
    });
    await post('/owntracks', {
      _type: 'location',
      lat: 43.0,
      lon: -72.0,
      tst: 1700000001,
      tid: 'CD',
    });

    const rows = db.query('SELECT * FROM locations ORDER BY tid').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tid).toBe('AB');
    expect(rows[1]!.tid).toBe('CD');
  });
});
