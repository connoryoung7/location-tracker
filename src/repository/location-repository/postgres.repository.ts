import type { SQL, TransactionSQL } from 'bun';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  Address,
  GeofenceReplayState,
  LocationPayload,
  TransitionPayload,
  WaypointPayload,
} from '@/domain/types.ts';
import type { GeofenceEvent } from '@/domain/events.ts';
import type { LocationRepository } from '@/domain/ports.ts';

export class PostgresLocationRepository implements LocationRepository {
  private pool: SQL;
  private transaction = new AsyncLocalStorage<TransactionSQL>();

  private get conn(): SQL {
    return this.transaction.getStore() ?? this.pool;
  }

  readonly replayState = {
    readReplayState: async (userId: string): Promise<GeofenceReplayState | undefined> => {
      const [row] = await this
        .conn`SELECT state FROM geofence_replay_state WHERE user_id = ${userId}`;
      return row?.state;
    },
    clearReplayState: async (userId: string): Promise<void> => {
      await this.conn`DELETE FROM geofence_replay_state WHERE user_id = ${userId}`;
    },
  };

  async withUserLock<T>(userId: string, work: () => Promise<T>): Promise<T> {
    return this.pool.begin(async (tx) => {
      // The lock and all repository operations use this transaction's connection.
      // Postgres releases it on commit, rollback, or connection loss.
      await tx`SET LOCAL lock_timeout = '250ms'`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`geofence:${userId}`}, 0))`;
      return this.transaction.run(tx, work);
    });
  }

  constructor(conn: SQL) {
    this.pool = conn;
  }

  async saveLocation(payload: LocationPayload): Promise<void> {
    await this.conn`
      INSERT INTO locations (lat, lon, tst, tid, acc, alt, batt, vel, conn, tag, topic)
      VALUES (
        ${payload.lat},
        ${payload.lon},
        ${payload.tst},
        ${payload.tid},
        ${payload.acc ?? null},
        ${payload.alt ?? null},
        ${payload.batt ?? null},
        ${payload.vel ?? null},
        ${payload.conn ?? null},
        ${payload.tag ?? null},
        ${payload.topic ?? null}
      )
    `;
  }

  async saveTransition(payload: TransitionPayload): Promise<void> {
    await this.conn`
      INSERT INTO transitions (tst, wtst, acc, event, lat, lon, tid, "desc", t, rid)
      VALUES (
        ${payload.tst},
        ${payload.wtst},
        ${payload.acc},
        ${payload.event},
        ${payload.lat ?? null},
        ${payload.lon ?? null},
        ${payload.tid ?? null},
        ${payload.desc ?? null},
        ${payload.t ?? null},
        ${payload.rid ?? null}
      )
    `;
  }

  async saveWaypoint(payload: WaypointPayload): Promise<void> {
    await this.conn`
      INSERT INTO waypoints ("desc", tst, lat, lon, rad, uuid, major, minor, rid)
      VALUES (
        ${payload.desc},
        ${payload.tst},
        ${payload.lat ?? null},
        ${payload.lon ?? null},
        ${payload.rad ?? null},
        ${payload.uuid ?? null},
        ${payload.major ?? null},
        ${payload.minor ?? null},
        ${payload.rid ?? null}
      )
    `;
  }

  async saveAddress(lat: number, lon: number, address: Address): Promise<void> {
    await this.conn`
      INSERT INTO addresses (lat, lon, display_name, street, city, state, country, country_code, postal_code)
      VALUES (
        ${lat},
        ${lon},
        ${address.displayName},
        ${address.street ?? null},
        ${address.city ?? null},
        ${address.state ?? null},
        ${address.country ?? null},
        ${address.countryCode ?? null},
        ${address.postalCode ?? null}
      )
    `;
  }

  async migrate(): Promise<void> {
    await this.conn`CREATE TABLE IF NOT EXISTS geofence_replay_state (
      user_id TEXT PRIMARY KEY,
      state JSONB NOT NULL
    )`;
    await this.conn`
      CREATE TABLE IF NOT EXISTS locations (
        id SERIAL PRIMARY KEY,
        lat DOUBLE PRECISION NOT NULL,
        lon DOUBLE PRECISION NOT NULL,
        tst INTEGER NOT NULL,
        tid TEXT NOT NULL,
        acc DOUBLE PRECISION,
        alt DOUBLE PRECISION,
        batt INTEGER,
        vel DOUBLE PRECISION,
        conn TEXT,
        tag TEXT,
        topic TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await this.conn`
      CREATE TABLE IF NOT EXISTS waypoints (
        id SERIAL PRIMARY KEY,
        "desc" TEXT NOT NULL,
        tst INTEGER NOT NULL,
        lat DOUBLE PRECISION,
        lon DOUBLE PRECISION,
        rad DOUBLE PRECISION,
        uuid TEXT,
        major INTEGER,
        minor INTEGER,
        rid TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await this.conn`
      CREATE TABLE IF NOT EXISTS addresses (
        id SERIAL PRIMARY KEY,
        lat DOUBLE PRECISION NOT NULL,
        lon DOUBLE PRECISION NOT NULL,
        display_name TEXT NOT NULL,
        street TEXT,
        city TEXT,
        state TEXT,
        country TEXT,
        country_code TEXT,
        postal_code TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await this.conn`
      CREATE TABLE IF NOT EXISTS transitions (
        id SERIAL PRIMARY KEY,
        tst INTEGER NOT NULL,
        wtst INTEGER NOT NULL,
        acc DOUBLE PRECISION NOT NULL,
        event TEXT NOT NULL,
        lat DOUBLE PRECISION,
        lon DOUBLE PRECISION,
        tid TEXT,
        "desc" TEXT,
        t TEXT,
        rid TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await this.conn`
      CREATE TABLE IF NOT EXISTS areas (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        lat DOUBLE PRECISION NOT NULL,
        lon DOUBLE PRECISION NOT NULL,
        radius DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await this.conn`CREATE INDEX IF NOT EXISTS areas_user_id_idx ON areas (user_id)`;
    await this.conn`
      CREATE TABLE IF NOT EXISTS area_events (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        user_id TEXT NOT NULL,
        area_id TEXT NOT NULL,
        area_name TEXT,
        lat DOUBLE PRECISION NOT NULL,
        lon DOUBLE PRECISION NOT NULL,
        tst INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
  }

  async saveAreaEvent(event: GeofenceEvent): Promise<void> {
    await this.conn`
      INSERT INTO area_events (type, user_id, area_id, area_name, lat, lon, tst)
      VALUES (
        ${event._type},
        ${event.userId},
        ${event.areaId},
        ${event.areaName ?? null},
        ${event.lat},
        ${event.lon},
        ${event.tst}
      )
    `;
  }

  async *listLocations(
    userId: string,
    range: { from?: number; to?: number } = {},
  ): AsyncIterable<LocationPayload> {
    let timestamp = range.from ?? 0;
    let id = 0;
    while (true) {
      const rows = await this.conn`SELECT id, lat, lon, tst, tid FROM locations
        WHERE tid = ${userId} AND tst >= ${range.from ?? 0} AND tst <= ${range.to ?? 2147483647}
        AND (tst > ${timestamp} OR (tst = ${timestamp} AND id > ${id})) ORDER BY tst, id LIMIT 1000`;
      if (!rows.length) return;
      for (const row of rows) {
        timestamp = row.tst;
        id = row.id;
        yield { _type: 'location', lat: row.lat, lon: row.lon, tst: row.tst, tid: row.tid };
      }
    }
  }

  async replaceAreaEvents(
    userId: string,
    events: GeofenceEvent[],
    state?: GeofenceReplayState,
  ): Promise<number> {
    const replace = async (tx: SQL) => {
      const [before] =
        await tx`SELECT COUNT(*) AS count FROM area_events WHERE user_id = ${userId}`;
      await tx`DELETE FROM area_events WHERE user_id = ${userId}`;
      for (const event of events) {
        if (event.userId !== userId) throw new Error('Event user mismatch');
      }
      for (let offset = 0; offset < events.length; offset += 1000) {
        const rows = events.slice(offset, offset + 1000).map((event) => ({
          type: event._type,
          user_id: userId,
          area_id: event.areaId,
          area_name: event.areaName ?? null,
          lat: event.lat,
          lon: event.lon,
          tst: event.tst,
        }));
        await tx`INSERT INTO area_events ${tx(rows)}`;
      }
      if (state) {
        await tx`INSERT INTO geofence_replay_state (user_id, state) VALUES (${userId}, ${state}::jsonb)
          ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state`;
      }
      return Number(before.count);
    };
    const transaction = this.transaction.getStore();
    return transaction ? transaction.savepoint(replace) : this.pool.begin(replace);
  }

  async healthCheck(): Promise<void> {
    await this.conn`SELECT 1`;
  }

  async close(): Promise<void> {
    await this.conn.close();
  }
}
