import { Database } from "bun:sqlite";
import type { LocationPayload, TransitionPayload } from "../../domain/types.ts";
import type { LocationRepository } from "../../domain/ports.ts";

export class SqliteLocationRepository implements LocationRepository {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        tst INTEGER NOT NULL,
        tid TEXT NOT NULL,
        acc REAL,
        alt REAL,
        batt INTEGER,
        vel REAL,
        conn TEXT,
        tag TEXT,
        topic TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tst INTEGER NOT NULL,
        wtst INTEGER NOT NULL,
        acc REAL NOT NULL,
        event TEXT NOT NULL,
        lat REAL,
        lon REAL,
        tid TEXT,
        "desc" TEXT,
        t TEXT,
        rid TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
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
