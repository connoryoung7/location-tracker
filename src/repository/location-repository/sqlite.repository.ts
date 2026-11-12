import type { Database } from 'bun:sqlite';
import type {
  Address,
  GeofenceReplayState,
  LocationPayload,
  TransitionPayload,
  WaypointPayload,
} from '@/domain/types.ts';
import type { GeofenceEvent } from '@/domain/events.ts';
import type { LocationRepository } from '@/domain/ports.ts';

export class SqliteLocationRepository implements LocationRepository {
  private db: Database;

  private queue: Promise<unknown> = Promise.resolve();
  readonly replayState = {
    readReplayState: async (userId: string): Promise<GeofenceReplayState | undefined> => {
      const row = this.db
        .query('SELECT state FROM geofence_replay_state WHERE user_id = ?')
        .get(userId) as { state: string } | null;
      return row ? JSON.parse(row.state) : undefined;
    },
    clearReplayState: async (userId: string): Promise<void> => {
      this.db.run('DELETE FROM geofence_replay_state WHERE user_id = ?', [userId]);
    },
  };

  // SQLite serializes writers database-wide. BEGIN IMMEDIATE also coordinates
  // separate app/ingestion processes; process death rolls back and releases it.
  async withUserLock<T>(_userId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.db.run('BEGIN IMMEDIATE');
      try {
        const result = await work();
        this.db.run('COMMIT');
        return result;
      } catch (error) {
        this.db.run('ROLLBACK');
        throw error;
      }
    } finally {
      release();
    }
  }

  constructor(db: Database) {
    this.db = db;
    db.run('PRAGMA busy_timeout = 1000');
    db.run(
      'CREATE TABLE IF NOT EXISTS geofence_replay_state (user_id TEXT PRIMARY KEY, state TEXT NOT NULL)',
    );
  }

  saveLocation(payload: LocationPayload): void | Promise<void> {
    // Another live request must not join an in-flight replay transaction.
    if (this.db.inTransaction) return this.queue.then(() => this.saveLocation(payload));
    this.db.run(
      `INSERT INTO locations (lat, lon, tst, tid, acc, alt, batt, vel, conn, tag, topic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.lat,
        payload.lon,
        payload.tst,
        payload.tid,
        payload.acc ?? null,
        payload.alt ?? null,
        payload.batt ?? null,
        payload.vel ?? null,
        payload.conn ?? null,
        payload.tag ?? null,
        payload.topic ?? null,
      ],
    );
  }

  saveTransition(payload: TransitionPayload): void {
    this.db.run(
      `INSERT INTO transitions (tst, wtst, acc, event, lat, lon, tid, "desc", t, rid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.tst,
        payload.wtst,
        payload.acc,
        payload.event,
        payload.lat ?? null,
        payload.lon ?? null,
        payload.tid ?? null,
        payload.desc ?? null,
        payload.t ?? null,
        payload.rid ?? null,
      ],
    );
  }

  saveWaypoint(payload: WaypointPayload): void {
    this.db.run(
      `INSERT INTO waypoints ("desc", tst, lat, lon, rad, uuid, major, minor, rid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.desc,
        payload.tst,
        payload.lat ?? null,
        payload.lon ?? null,
        payload.rad ?? null,
        payload.uuid ?? null,
        payload.major ?? null,
        payload.minor ?? null,
        payload.rid ?? null,
      ],
    );
  }

  saveAddress(lat: number, lon: number, address: Address): void {
    this.db.run(
      `INSERT INTO addresses (lat, lon, display_name, street, city, state, country, country_code, postal_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lat,
        lon,
        address.displayName,
        address.street ?? null,
        address.city ?? null,
        address.state ?? null,
        address.country ?? null,
        address.countryCode ?? null,
        address.postalCode ?? null,
      ],
    );
  }

  saveAreaEvent(event: GeofenceEvent): void {
    this.db.run(
      `INSERT INTO area_events (type, user_id, area_id, area_name, lat, lon, tst)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event._type,
        event.userId,
        event.areaId,
        event.areaName ?? null,
        event.lat,
        event.lon,
        event.tst,
      ],
    );
  }

  async *listLocations(
    userId: string,
    range: { from?: number; to?: number } = {},
  ): AsyncIterable<LocationPayload> {
    const rows = this.db.query(
      `SELECT lat, lon, tst, tid FROM locations WHERE tid = ? AND tst >= ? AND tst <= ? ORDER BY tst, id`,
    );
    for (const row of rows.iterate(userId, range.from ?? 0, range.to ?? Number.MAX_SAFE_INTEGER)) {
      yield { _type: 'location', ...(row as Omit<LocationPayload, '_type'>) };
    }
  }

  async replaceAreaEvents(
    userId: string,
    events: GeofenceEvent[],
    state?: GeofenceReplayState,
  ): Promise<number> {
    return this.db.transaction(() => {
      const before = this.db
        .query('SELECT COUNT(*) AS count FROM area_events WHERE user_id = ?')
        .get(userId) as { count: number };
      this.db.run('DELETE FROM area_events WHERE user_id = ?', [userId]);
      for (const event of events) {
        if (event.userId !== userId) throw new Error('Event user mismatch');
        this.saveAreaEvent(event);
      }
      if (state)
        this.db.run(
          `INSERT INTO geofence_replay_state (user_id, state) VALUES (?, ?)
        ON CONFLICT (user_id) DO UPDATE SET state = excluded.state`,
          [userId, JSON.stringify(state)],
        );
      return before.count;
    })();
  }

  async healthCheck(): Promise<void> {
    this.db.prepare('SELECT 1').get();
  }
}
