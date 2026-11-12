import type { SQL } from 'bun';
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

/** The record of truth for areas. The Redis index is projected from this. */
export class PostgresAreaRepository implements AreaRepository {
  private conn: SQL;

  constructor(conn: SQL) {
    this.conn = conn;
  }

  /**
   * Upserts on `id` so re-running a seed converges instead of failing, which is
   * what `scripts/seed-areas.ts` and the ingestion API's `POST /areas` rely on.
   */
  async addArea(area: Area): Promise<void> {
    await this.conn`
      INSERT INTO areas (id, user_id, name, lat, lon, radius)
      VALUES (${area.id}, ${area.userId}, ${area.name}, ${area.lat}, ${area.lon}, ${area.radius})
      ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        name = EXCLUDED.name,
        lat = EXCLUDED.lat,
        lon = EXCLUDED.lon,
        radius = EXCLUDED.radius,
        updated_at = NOW()
    `;
  }

  async removeArea(userId: string, areaId: string): Promise<void> {
    await this.conn`DELETE FROM areas WHERE id = ${areaId} AND user_id = ${userId}`;
  }

  async listAreas(userId: string): Promise<Area[]> {
    const rows = (await this.conn`
      SELECT id, user_id, name, lat, lon, radius FROM areas
      WHERE user_id = ${userId}
      ORDER BY name
    `) as AreaRow[];

    return rows.map(toArea);
  }

  async listAllAreas(): Promise<Area[]> {
    const rows = (await this.conn`
      SELECT id, user_id, name, lat, lon, radius FROM areas
      ORDER BY user_id, name
    `) as AreaRow[];

    return rows.map(toArea);
  }

  async getArea(userId: string, areaId: string): Promise<Area | undefined> {
    const rows = (await this.conn`
      SELECT id, user_id, name, lat, lon, radius FROM areas
      WHERE id = ${areaId} AND user_id = ${userId}
    `) as AreaRow[];

    const row = rows[0];
    return row ? toArea(row) : undefined;
  }

  async healthCheck(): Promise<void> {
    await this.conn`SELECT 1`;
  }
}
