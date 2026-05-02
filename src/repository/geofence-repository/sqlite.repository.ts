import type { Database } from 'bun:sqlite';
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
  created_at: string;
};

type GeofenceStateRow = {
  geofence_id: number;
  tid: string;
  status: string;
  pending_exit_at: number | null;
  last_evaluated_at: number;
};

const GEOFENCE_COLUMNS = `id, name, lat, lon, radius_meters, tid, exit_grace_seconds, created_at`;

function rowToGeofence(row: GeofenceRow): Geofence {
  return {
    id: row.id,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    radiusMeters: row.radius_meters,
    tid: row.tid,
    exitGraceSeconds: row.exit_grace_seconds,
    createdAt: row.created_at,
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

export class SqliteGeofenceRepository implements GeofenceRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async list(tid: string): Promise<Geofence[]> {
    const rows = this.db
      .prepare(`SELECT ${GEOFENCE_COLUMNS} FROM geofences WHERE tid = ? ORDER BY id ASC`)
      .all(tid) as GeofenceRow[];
    return rows.map(rowToGeofence);
  }

  async findById(id: number): Promise<Geofence | null> {
    const row = this.db.prepare(`SELECT ${GEOFENCE_COLUMNS} FROM geofences WHERE id = ?`).get(id) as
      | GeofenceRow
      | undefined;
    return row ? rowToGeofence(row) : null;
  }

  async create(input: GeofenceCreateInput): Promise<Geofence> {
    const result = this.db
      .prepare(
        `INSERT INTO geofences (name, lat, lon, radius_meters, tid, exit_grace_seconds)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING ${GEOFENCE_COLUMNS}`,
      )
      .get(
        input.name,
        input.lat,
        input.lon,
        input.radiusMeters,
        input.tid,
        input.exitGraceSeconds,
      ) as GeofenceRow;
    return rowToGeofence(result);
  }

  async update(id: number, patch: GeofenceUpdatePatch): Promise<Geofence | null> {
    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (patch.name !== undefined) {
      fields.push('name = ?');
      values.push(patch.name);
    }
    if (patch.lat !== undefined) {
      fields.push('lat = ?');
      values.push(patch.lat);
    }
    if (patch.lon !== undefined) {
      fields.push('lon = ?');
      values.push(patch.lon);
    }
    if (patch.radiusMeters !== undefined) {
      fields.push('radius_meters = ?');
      values.push(patch.radiusMeters);
    }
    if (patch.tid !== undefined) {
      fields.push('tid = ?');
      values.push(patch.tid);
    }
    if (patch.exitGraceSeconds !== undefined) {
      fields.push('exit_grace_seconds = ?');
      values.push(patch.exitGraceSeconds);
    }

    if (fields.length === 0) return this.findById(id);

    values.push(id);
    const row = this.db
      .prepare(
        `UPDATE geofences SET ${fields.join(', ')} WHERE id = ? RETURNING ${GEOFENCE_COLUMNS}`,
      )
      .get(...values) as GeofenceRow | undefined;
    return row ? rowToGeofence(row) : null;
  }

  async delete(id: number): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM geofences WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  async getState(geofenceId: number, tid: string): Promise<GeofenceState | null> {
    const row = this.db
      .prepare(
        `SELECT geofence_id, tid, status, pending_exit_at, last_evaluated_at
         FROM geofence_states WHERE geofence_id = ? AND tid = ?`,
      )
      .get(geofenceId, tid) as GeofenceStateRow | undefined;
    return row ? rowToState(row) : null;
  }

  async upsertState(state: GeofenceState): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO geofence_states (geofence_id, tid, status, pending_exit_at, last_evaluated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(geofence_id, tid) DO UPDATE SET
           status = excluded.status,
           pending_exit_at = excluded.pending_exit_at,
           last_evaluated_at = excluded.last_evaluated_at`,
      )
      .run(state.geofenceId, state.tid, state.status, state.pendingExitAt, state.lastEvaluatedAt);
  }
}
