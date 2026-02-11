import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHttpServer } from '@/infrastructure/http/server.ts';
import { ConsoleLogger } from '@/infrastructure/logging/console.logger.ts';
import { runMigrations } from '@/infrastructure/persistence/migrate.ts';
import { SqliteLocationRepository } from '@/repository/location-repository/sqlite.repository';
import { LibsodiumDecryptor } from '@/infrastructure/crypto/libsodium.decryptor';
import type { Deps } from '@/application/handle-payload.ts';
import type { Server } from 'node:http';
import type { PayloadDecryptor, ReverseGeocoder } from '@/domain/ports';
import type { ReverseGeocodingResult } from '@/domain/types';
import type { DomainEvent } from '@/domain/events';

const TEST_PORT = 0; // let OS pick an available port

let server: Server;
let baseUrl: string;
let db: Database;
let encryptor: PayloadDecryptor;
let mockGeocodeResult: ReverseGeocodingResult;
const mockPublish = mock<(event: DomainEvent) => void>(() => {});
const encryptionKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 32 bytes key for testing

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = encryptionKey;

  encryptor = await LibsodiumDecryptor.create(Buffer.from(btoa(encryptionKey), 'base64'));

  db = new Database(':memory:');
  runMigrations(db);

  const deps: Deps = {
    repo: new SqliteLocationRepository(db),
    logger: new ConsoleLogger(),
    decryptor: encryptor,
    reverseGeocoder: { reverseGeocode: async () => mockGeocodeResult } satisfies ReverseGeocoder,
    eventPublisher: { publish: mockPublish },
  };

  const app = createHttpServer(deps);
  await new Promise<void>((resolve) => {
    server = app.listen(TEST_PORT, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  db.run('DELETE FROM locations');
  db.run('DELETE FROM waypoints');
  db.run('DELETE FROM addresses');
  mockGeocodeResult = { lat: 0, lon: 0 };
  mockPublish.mockClear();
});

function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /_health', () => {
  test('returns 200 with status ok', async () => {
    const res = await fetch(`${baseUrl}/_health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('POST /pub location', () => {
  test('returns 200 with empty array for valid location', async () => {
    const res = await post('/pub', {
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
    await post('/pub', {
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
    await post('/pub', {
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
    await post('/pub', {
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

    await Promise.all(
      locations.map((loc) => post('/pub', loc).then((res) => expect(res.status).toBe(200))),
    );

    const rows = db.query('SELECT * FROM locations ORDER BY tst').all() as any[];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.lat).toBe(42.0);
    expect(rows[1]!.lat).toBe(43.0);
    expect(rows[2]!.lat).toBe(44.0);
  });

  test('handles negative coordinates', async () => {
    await post('/pub', {
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
    await post('/pub', {
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
    const res = await post('/pub', {
      lat: 42.0,
      lon: -71.0,
      tst: 1700000000,
      tid: 'AB',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe('Invalid payload');
    expect(body.issues).toBeDefined();
  });

  test('returns 400 for empty body', async () => {
    const res = await post('/pub', {});

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe('Invalid payload');
    expect(body.issues).toBeDefined();
  });

  test('does not persist when _type is missing', async () => {
    await post('/pub', {
      lat: 42.0,
      lon: -71.0,
      tst: 1700000000,
      tid: 'AB',
    });

    const count = db.query('SELECT COUNT(*) as c FROM locations').get() as any;
    expect(count.c).toBe(0);
  });

  test('persists address when reverse geocoder returns a result', async () => {
    mockGeocodeResult = {
      lat: 42.3601,
      lon: -71.0589,
      address: {
        displayName: '123 Main St, Boston, MA 02101, US',
        street: '123 Main St',
        city: 'Boston',
        state: 'MA',
        country: 'United States',
        countryCode: 'US',
        postalCode: '02101',
      },
    };

    await post('/pub', {
      _type: 'location',
      lat: 42.3601,
      lon: -71.0589,
      tst: 1700000000,
      tid: 'AB',
    });

    // Address save is fire-and-forget; wait for the background promise to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    const row = db.query('SELECT * FROM addresses').get() as any;
    expect(row).not.toBeNull();
    expect(row.lat).toBe(42.3601);
    expect(row.lon).toBe(-71.0589);
    expect(row.display_name).toBe('123 Main St, Boston, MA 02101, US');
    expect(row.street).toBe('123 Main St');
    expect(row.city).toBe('Boston');
    expect(row.state).toBe('MA');
    expect(row.country).toBe('United States');
    expect(row.country_code).toBe('US');
    expect(row.postal_code).toBe('02101');
  });

  test('does not persist address when reverse geocoder returns undefined', async () => {
    await post('/pub', {
      _type: 'location',
      lat: 42.3601,
      lon: -71.0589,
      tst: 1700000000,
      tid: 'AB',
    });

    const count = db.query('SELECT COUNT(*) as c FROM addresses').get() as any;
    expect(count.c).toBe(0);
  });

  test('differentiates locations by tracker id', async () => {
    await post('/pub', {
      _type: 'location',
      lat: 42.0,
      lon: -71.0,
      tst: 1700000000,
      tid: 'AB',
    });
    await post('/pub', {
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

describe('POST /pub waypoint', () => {
  test('returns 200 for valid waypoint', async () => {
    const res = await post('/pub', {
      _type: 'waypoint',
      desc: 'Home',
      tst: 1700000000,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test('persists required fields to database', async () => {
    await post('/pub', {
      _type: 'waypoint',
      desc: 'Home',
      tst: 1700000000,
    });

    const row = db.query('SELECT * FROM waypoints').get() as any;
    expect(row.desc).toBe('Home');
    expect(row.tst).toBe(1700000000);
  });

  test('persists optional fields when provided', async () => {
    await post('/pub', {
      _type: 'waypoint',
      desc: 'Office',
      tst: 1700000000,
      lat: 42.3601,
      lon: -71.0589,
      rad: 150,
      rid: 'region-1',
      uuid: 'FDA50693-A4E2-4FB1-AFCF-C6EB07647825',
      major: 10001,
      minor: 19641,
    });

    const row = db.query('SELECT * FROM waypoints').get() as any;
    expect(row.desc).toBe('Office');
    expect(row.tst).toBe(1700000000);
    expect(row.lat).toBe(42.3601);
    expect(row.lon).toBe(-71.0589);
    expect(row.rad).toBe(150);
    expect(row.rid).toBe('region-1');
    expect(row.uuid).toBe('FDA50693-A4E2-4FB1-AFCF-C6EB07647825');
    expect(row.major).toBe(10001);
    expect(row.minor).toBe(19641);
  });

  test('stores null for omitted optional fields', async () => {
    await post('/pub', {
      _type: 'waypoint',
      desc: 'Home',
      tst: 1700000000,
    });

    const row = db.query('SELECT * FROM waypoints').get() as any;
    expect(row.lat).toBeNull();
    expect(row.lon).toBeNull();
    expect(row.rad).toBeNull();
    expect(row.uuid).toBeNull();
    expect(row.major).toBeNull();
    expect(row.minor).toBeNull();
    expect(row.rid).toBeNull();
  });
});

describe('POST /pub encrypted location', () => {
  test('decrypts and persists an encrypted location payload', async () => {
    const location = {
      _type: 'location',
      lat: 42.3601,
      lon: -71.0589,
      tst: 1700000000,
      tid: 'AB',
    };

    const res = await post('/pub', {
      _type: 'encrypted',
      data: encryptor.encrypt(JSON.stringify(location)),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);

    const row = db.query('SELECT * FROM locations').get() as any;
    expect(row.lat).toBe(42.3601);
    expect(row.lon).toBe(-71.0589);
    expect(row.tst).toBe(1700000000);
    expect(row.tid).toBe('AB');
  });
});

describe('POST /pub encrypted waypoint', () => {
  test('decrypts and persists an encrypted waypoint payload', async () => {
    const waypoint = {
      _type: 'waypoint',
      desc: 'Home',
      tst: 1700000000,
      lat: 42.3601,
      lon: -71.0589,
      rad: 100,
    };

    const res = await post('/pub', {
      _type: 'encrypted',
      data: encryptor.encrypt(JSON.stringify(waypoint)),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);

    const row = db.query('SELECT * FROM waypoints').get() as any;
    expect(row.desc).toBe('Home');
    expect(row.tst).toBe(1700000000);
    expect(row.lat).toBe(42.3601);
    expect(row.lon).toBe(-71.0589);
    expect(row.rad).toBe(100);
  });
});

describe('POST /pub encrypted invalid payloads', () => {
  test('returns 200 but does not persist when decrypted data is not valid JSON', async () => {
    const res = await post('/pub', {
      _type: 'encrypted',
      data: encryptor.encrypt('not valid json{{{'),
    });

    expect(res.status).toBe(200);

    const locations = db.query('SELECT COUNT(*) as c FROM locations').get() as any;
    const waypoints = db.query('SELECT COUNT(*) as c FROM waypoints').get() as any;
    expect(locations.c).toBe(0);
    expect(waypoints.c).toBe(0);
  });

  test('returns 200 but does not persist when decrypted data is valid JSON but not an OwnTracks type', async () => {
    const res = await post('/pub', {
      _type: 'encrypted',
      data: encryptor.encrypt(JSON.stringify({ _type: 'unknown', foo: 'bar' })),
    });

    expect(res.status).toBe(200);

    const locations = db.query('SELECT COUNT(*) as c FROM locations').get() as any;
    const waypoints = db.query('SELECT COUNT(*) as c FROM waypoints').get() as any;
    expect(locations.c).toBe(0);
    expect(waypoints.c).toBe(0);
  });
});

describe('POST /pub transition', () => {
  test('publishes a UserWaypointUpdatedEvent on enter transition', async () => {
    const res = await post('/pub', {
      _type: 'transition',
      tst: 1700000000,
      wtst: 1699999000,
      acc: 10,
      event: 'enter',
      lat: 42.3601,
      lon: -71.0589,
      tid: 'AB',
      desc: 'Office',
      t: 'c',
      rid: 'region-1',
    });

    expect(res.status).toBe(200);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0]![0]).toEqual({
      _type: 'user-waypoint.updated',
      update_type: 'enter',
      waypoint: {
        _type: 'waypoint',
        desc: 'Office',
        tst: 1699999000,
        rid: 'region-1',
      },
      transition: {
        _type: 'transition',
        tst: 1700000000,
        wtst: 1699999000,
        acc: 10,
        event: 'enter',
        lat: 42.3601,
        lon: -71.0589,
        tid: 'AB',
        desc: 'Office',
        t: 'c',
        rid: 'region-1',
      },
    });
  });

  test('publishes a UserWaypointUpdatedEvent on leave transition', async () => {
    await post('/pub', {
      _type: 'transition',
      tst: 1700001000,
      wtst: 1699999000,
      acc: 5,
      event: 'leave',
      desc: 'Home',
      rid: 'region-2',
    });

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0]![0]).toMatchObject({
      _type: 'user-waypoint.updated',
      update_type: 'leave',
      waypoint: { desc: 'Home', tst: 1699999000 },
    });
  });

  test('does not publish an event for location payloads', async () => {
    await post('/pub', {
      _type: 'location',
      lat: 42.3601,
      lon: -71.0589,
      tst: 1700000000,
      tid: 'AB',
    });

    expect(mockPublish).not.toHaveBeenCalled();
  });

  test('publishes event when transition is encrypted', async () => {
    const transition = {
      _type: 'transition' as const,
      tst: 1700000000,
      wtst: 1699999000,
      acc: 10,
      event: 'enter' as const,
      lat: 42.3601,
      lon: -71.0589,
      tid: 'AB',
      desc: 'Office',
      t: 'c' as const,
      rid: 'region-1',
    };

    const res = await post('/pub', {
      _type: 'encrypted',
      data: encryptor.encrypt(JSON.stringify(transition)),
    });

    expect(res.status).toBe(200);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0]![0]).toEqual({
      _type: 'user-waypoint.updated',
      update_type: 'enter',
      waypoint: {
        _type: 'waypoint',
        desc: 'Office',
        tst: 1699999000,
        rid: 'region-1',
      },
      transition,
    });
  });

  test('publishes leave event when encrypted transition has minimal fields', async () => {
    const transition = {
      _type: 'transition',
      tst: 1700001000,
      wtst: 1699999000,
      acc: 5,
      event: 'leave',
    };

    await post('/pub', {
      _type: 'encrypted',
      data: encryptor.encrypt(JSON.stringify(transition)),
    });

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0]![0]).toMatchObject({
      _type: 'user-waypoint.updated',
      update_type: 'leave',
      waypoint: { _type: 'waypoint', desc: '', tst: 1699999000 },
    });
  });
});
