import { SQL } from "bun";
import type { LocationPayload, TransitionPayload } from "@/domain/types.ts";
import type { LocationRepository } from "@/domain/ports.ts";

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

  async close(): Promise<void> {
    await this.conn.close();
  }
}
