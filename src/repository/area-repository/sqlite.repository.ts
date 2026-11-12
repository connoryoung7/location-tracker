import type { Database } from 'bun:sqlite';
import type { Area } from '@/domain/types.ts';
import type { AreaRepository } from '@/domain/ports.ts';

type AreaRow = {
  id: string;
  user_id: string;
  name: string;
  lat: number;
  lon: number;
  radius: number;
};

function toArea(row: AreaRow): Area {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    radius: row.radius,
  };
}

const SELECT_COLUMNS = 'id, user_id, name, lat, lon, radius';

/** The record of truth for areas when running without Postgres. */
export class SqliteAreaRepository implements AreaRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Upserts on `id`, matching {@link PostgresAreaRepository.addArea}. */
  addArea(area: Area): void {
    this.db.run(
      `INSERT INTO areas (id, user_id, name, lat, lon, radius)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         user_id = excluded.user_id,
         name = excluded.name,
         lat = excluded.lat,
         lon = excluded.lon,
         radius = excluded.radius,
         updated_at = datetime('now')`,
      [area.id, area.userId, area.name, area.lat, area.lon, area.radius],
    );
  }

  removeArea(userId: string, areaId: string): void {
    this.db.run(`DELETE FROM areas WHERE id = ? AND user_id = ?`, [areaId, userId]);
  }

  async listAreas(userId: string): Promise<Area[]> {
    const rows = this.db
      .query(`SELECT ${SELECT_COLUMNS} FROM areas WHERE user_id = ? ORDER BY name`)
      .all(userId) as AreaRow[];

    return rows.map(toArea);
  }

  async listAllAreas(): Promise<Area[]> {
    const rows = this.db
      .query(`SELECT ${SELECT_COLUMNS} FROM areas ORDER BY user_id, name`)
      .all() as AreaRow[];

    return rows.map(toArea);
  }

  async getArea(userId: string, areaId: string): Promise<Area | undefined> {
    const row = this.db
      .query(`SELECT ${SELECT_COLUMNS} FROM areas WHERE id = ? AND user_id = ?`)
      .get(areaId, userId) as AreaRow | null;

    return row ? toArea(row) : undefined;
  }

  async healthCheck(): Promise<void> {
    this.db.query('SELECT 1').get();
  }
}
