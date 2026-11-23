import type { SQL } from 'bun';
import type { Area } from '@/domain/types.ts';
import type { AreaRepository } from '@/domain/ports.ts';
import { connectionFor } from '@/repository/postgres-transaction.ts';

type AreaRow = {
  id: string;
  user_id: string;
  name: string;
  lat: number;
  lon: number;
  radius: number;
  category_id: string | null;
};

function toArea(row: AreaRow): Area {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    radius: row.radius,
    ...(row.category_id ? { categoryId: row.category_id } : {}),
  };
}

/** The record of truth for areas. The Redis index is projected from this. */
export class PostgresAreaRepository implements AreaRepository {
  private pool: SQL;

  constructor(pool: SQL) {
    this.pool = pool;
  }

  /**
   * The user lock's transaction while one is open, so a write made under the
   * lock reuses its reserved connection and commits with it; the pool otherwise.
   */
  private get conn(): SQL {
    return connectionFor(this.pool);
  }

  /**
   * Upserts on `id` so re-running a seed converges instead of failing, which is
   * what `scripts/seed-areas.ts` and the ingestion API's `POST /areas` rely on.
   * An area re-upserted without a category keeps the one it has.
   */
  async addArea(area: Area): Promise<void> {
    await this.conn`
      INSERT INTO areas (id, user_id, name, lat, lon, radius, category_id)
      VALUES (
        ${area.id}, ${area.userId}, ${area.name}, ${area.lat}, ${area.lon}, ${area.radius},
        ${area.categoryId ?? null}
      )
      ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        name = EXCLUDED.name,
        lat = EXCLUDED.lat,
        lon = EXCLUDED.lon,
        radius = EXCLUDED.radius,
        category_id = COALESCE(EXCLUDED.category_id, areas.category_id),
        updated_at = NOW()
    `;
  }

  /** Scoped by ID and owner; never inserts, unlike {@link addArea}. */
  async updateArea(area: Area): Promise<boolean> {
    const rows = await this.conn`
      UPDATE areas
      SET name = ${area.name}, lat = ${area.lat}, lon = ${area.lon}, radius = ${area.radius},
        updated_at = NOW()
      WHERE id = ${area.id} AND user_id = ${area.userId}
      RETURNING id
    `;
    return rows.length > 0;
  }

  async removeArea(userId: string, areaId: string): Promise<void> {
    await this.conn`DELETE FROM areas WHERE id = ${areaId} AND user_id = ${userId}`;
  }

  async listAreas(userId: string): Promise<Area[]> {
    const rows = (await this.conn`
      SELECT id, user_id, name, lat, lon, radius, category_id FROM areas
      WHERE user_id = ${userId}
      ORDER BY name
    `) as AreaRow[];

    return rows.map(toArea);
  }

  async listAllAreas(): Promise<Area[]> {
    const rows = (await this.conn`
      SELECT id, user_id, name, lat, lon, radius, category_id FROM areas
      ORDER BY user_id, name
    `) as AreaRow[];

    return rows.map(toArea);
  }

  async getArea(userId: string, areaId: string): Promise<Area | undefined> {
    const rows = (await this.conn`
      SELECT id, user_id, name, lat, lon, radius, category_id FROM areas
      WHERE id = ${areaId} AND user_id = ${userId}
    `) as AreaRow[];

    const row = rows[0];
    return row ? toArea(row) : undefined;
  }

  async setAreaCategory(
    userId: string,
    areaId: string,
    categoryId: string | null,
  ): Promise<boolean> {
    const rows = await this.conn`
      UPDATE areas SET category_id = ${categoryId}, updated_at = NOW()
      WHERE id = ${areaId} AND user_id = ${userId}
      RETURNING id
    `;
    return rows.length > 0;
  }

  async healthCheck(): Promise<void> {
    await this.conn`SELECT 1`;
  }
}
