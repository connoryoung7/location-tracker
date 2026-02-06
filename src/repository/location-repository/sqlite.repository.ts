import type { Database } from 'bun:sqlite';
import type { LocationPayload, TransitionPayload } from '@/domain/types.ts';
import type { LocationRepository } from '@/domain/ports.ts';

export class SqliteLocationRepository implements LocationRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  saveLocation(payload: LocationPayload): void {
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
}
