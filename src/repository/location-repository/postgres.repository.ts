import type { SQL } from 'bun';
import type { LocationPayload, TransitionPayload } from '@/domain/types.ts';
import type { LocationRepository } from '@/domain/ports.ts';

export class PostgresLocationRepository implements LocationRepository {
  private conn: SQL;

  constructor(conn: SQL) {
    this.conn = conn;
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

  async migrate(): Promise<void> {
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
  }

  async close(): Promise<void> {
    await this.conn.close();
  }
}
