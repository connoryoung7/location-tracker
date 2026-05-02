import type { SQL } from 'bun';
import type { Geofence, GeofenceState, GeofenceStateStatus } from '@/domain/types.ts';
import type {
  GeofenceCreateInput,
  GeofenceRepository,
  GeofenceUpdatePatch,
} from '@/domain/ports.ts';

type GeofenceRow = {
  id: number;
  name: string;
  lat: number;
  lon: number;
  radius_meters: number;
  tid: string;
  exit_grace_seconds: number;
  created_at: Date | string;
};

type GeofenceStateRow = {
  geofence_id: number;
  tid: string;
  status: string;
  pending_exit_at: number | null;
  last_evaluated_at: number;
};

function rowToGeofence(row: GeofenceRow): Geofence {
  const createdAt =
    row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  return {
    id: row.id,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    radiusMeters: row.radius_meters,
    tid: row.tid,
    exitGraceSeconds: row.exit_grace_seconds,
    createdAt,
  };
}

function rowToState(row: GeofenceStateRow): GeofenceState {
  return {
    geofenceId: row.geofence_id,
    tid: row.tid,
    status: row.status as GeofenceStateStatus,
    pendingExitAt: row.pending_exit_at,
    lastEvaluatedAt: row.last_evaluated_at,
  };
}

export class PostgresGeofenceRepository implements GeofenceRepository {
  private conn: SQL;

  constructor(conn: SQL) {
    this.conn = conn;
  }

  async list(tid: string): Promise<Geofence[]> {
    const rows = (await this.conn`
      SELECT id, name, lat, lon, radius_meters, tid, exit_grace_seconds, created_at
      FROM geofences
      WHERE tid = ${tid}
      ORDER BY id ASC
    `) as GeofenceRow[];
    return rows.map(rowToGeofence);
  }

  async findById(id: number): Promise<Geofence | null> {
    const rows = (await this.conn`
      SELECT id, name, lat, lon, radius_meters, tid, exit_grace_seconds, created_at
      FROM geofences
      WHERE id = ${id}
    `) as GeofenceRow[];
    return rows.length > 0 ? rowToGeofence(rows[0]!) : null;
  }

  async create(input: GeofenceCreateInput): Promise<Geofence> {
    const rows = (await this.conn`
      INSERT INTO geofences (name, lat, lon, radius_meters, tid, exit_grace_seconds)
      VALUES (
        ${input.name},
        ${input.lat},
        ${input.lon},
        ${input.radiusMeters},
        ${input.tid},
        ${input.exitGraceSeconds}
      )
      RETURNING id, name, lat, lon, radius_meters, tid, exit_grace_seconds, created_at
    `) as GeofenceRow[];
    return rowToGeofence(rows[0]!);
  }

  async update(id: number, patch: GeofenceUpdatePatch): Promise<Geofence | null> {
    const rows = (await this.conn`
      UPDATE geofences SET
        name = COALESCE(${patch.name ?? null}, name),
        lat = COALESCE(${patch.lat ?? null}, lat),
        lon = COALESCE(${patch.lon ?? null}, lon),
        radius_meters = COALESCE(${patch.radiusMeters ?? null}, radius_meters),
        tid = COALESCE(${patch.tid ?? null}, tid),
        exit_grace_seconds = COALESCE(${patch.exitGraceSeconds ?? null}, exit_grace_seconds)
      WHERE id = ${id}
      RETURNING id, name, lat, lon, radius_meters, tid, exit_grace_seconds, created_at
    `) as GeofenceRow[];
    return rows.length > 0 ? rowToGeofence(rows[0]!) : null;
  }

  async delete(id: number): Promise<boolean> {
    const rows = (await this.conn`
      DELETE FROM geofences WHERE id = ${id} RETURNING id
    `) as { id: number }[];
    return rows.length > 0;
  }

  async getState(geofenceId: number, tid: string): Promise<GeofenceState | null> {
    const rows = (await this.conn`
      SELECT geofence_id, tid, status, pending_exit_at, last_evaluated_at
      FROM geofence_states
      WHERE geofence_id = ${geofenceId} AND tid = ${tid}
    `) as GeofenceStateRow[];
    return rows.length > 0 ? rowToState(rows[0]!) : null;
  }

  async upsertState(state: GeofenceState): Promise<void> {
    await this.conn`
      INSERT INTO geofence_states (geofence_id, tid, status, pending_exit_at, last_evaluated_at)
      VALUES (
        ${state.geofenceId},
        ${state.tid},
        ${state.status},
        ${state.pendingExitAt},
        ${state.lastEvaluatedAt}
      )
      ON CONFLICT (geofence_id, tid) DO UPDATE SET
        status = EXCLUDED.status,
        pending_exit_at = EXCLUDED.pending_exit_at,
        last_evaluated_at = EXCLUDED.last_evaluated_at
    `;
  }

  async migrate(): Promise<void> {
    await this.conn`
      CREATE TABLE IF NOT EXISTS geofences (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        lat DOUBLE PRECISION NOT NULL,
        lon DOUBLE PRECISION NOT NULL,
        radius_meters DOUBLE PRECISION NOT NULL,
        tid TEXT NOT NULL,
        exit_grace_seconds INTEGER NOT NULL DEFAULT 60,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await this.conn`CREATE INDEX IF NOT EXISTS idx_geofences_tid ON geofences (tid)`;
    await this.conn`
      CREATE TABLE IF NOT EXISTS geofence_states (
        geofence_id INTEGER NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
        tid TEXT NOT NULL,
        status TEXT NOT NULL,
        pending_exit_at BIGINT,
        last_evaluated_at BIGINT NOT NULL,
        PRIMARY KEY (geofence_id, tid)
      )
    `;
  }
}
