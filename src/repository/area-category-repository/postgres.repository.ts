import type { SQL } from 'bun';
import type { AreaCategoryRepository } from '@/domain/ports.ts';
import type { AreaCategory, AreaCategoryColor } from '@/domain/types.ts';

type CategoryRow = { id: string; user_id: string; name: string; color: AreaCategoryColor };

function toCategory(row: CategoryRow): AreaCategory {
  return { id: row.id, userId: row.user_id, name: row.name, color: row.color };
}

/**
 * Area categories in Postgres. The tables are created by
 * `PostgresLocationRepository.migrate()`, alongside `areas`.
 */
export class PostgresAreaCategoryRepository implements AreaCategoryRepository {
  private conn: SQL;

  constructor(conn: SQL) {
    this.conn = conn;
  }

  async listCategories(userId: string): Promise<AreaCategory[]> {
    const rows = (await this.conn`
      SELECT id, user_id, name, color FROM area_categories
      WHERE user_id = ${userId}
      ORDER BY lower(name), id
    `) as CategoryRow[];
    return rows.map(toCategory);
  }

  async getCategory(userId: string, categoryId: string): Promise<AreaCategory | undefined> {
    const rows = (await this.conn`
      SELECT id, user_id, name, color FROM area_categories
      WHERE id = ${categoryId} AND user_id = ${userId}
    `) as CategoryRow[];
    return rows[0] ? toCategory(rows[0]) : undefined;
  }

  async findCategoryByName(userId: string, name: string): Promise<AreaCategory | undefined> {
    const rows = (await this.conn`
      SELECT id, user_id, name, color FROM area_categories
      WHERE user_id = ${userId} AND lower(name) = lower(${name})
    `) as CategoryRow[];
    return rows[0] ? toCategory(rows[0]) : undefined;
  }

  async addCategory(category: AreaCategory): Promise<'added' | 'name-taken'> {
    if (await this.findCategoryByName(category.userId, category.name)) return 'name-taken';
    await this.conn`
      INSERT INTO area_categories (id, user_id, name, color)
      VALUES (${category.id}, ${category.userId}, ${category.name}, ${category.color})
    `;
    return 'added';
  }

  async updateCategory(
    userId: string,
    categoryId: string,
    changes: { name?: string; color?: AreaCategoryColor },
  ): Promise<'updated' | 'not-found' | 'name-taken'> {
    if (!(await this.getCategory(userId, categoryId))) return 'not-found';
    if (changes.name !== undefined) {
      const sameName = await this.findCategoryByName(userId, changes.name);
      // Renaming "gym" to "Gym" is fine; taking another category's name is not.
      if (sameName && sameName.id !== categoryId) return 'name-taken';
    }

    await this.conn`
      UPDATE area_categories
      SET name = COALESCE(${changes.name ?? null}, name),
          color = COALESCE(${changes.color ?? null}, color),
          updated_at = NOW()
      WHERE id = ${categoryId} AND user_id = ${userId}
    `;
    return 'updated';
  }

  async removeCategory(userId: string, categoryId: string): Promise<boolean> {
    // ON DELETE SET NULL would also clear the areas here; doing it explicitly
    // keeps the behaviour identical to SQLite, which doesn't enforce it.
    return this.conn.begin(async (tx) => {
      await tx`
        UPDATE areas SET category_id = NULL, updated_at = NOW()
        WHERE category_id = ${categoryId} AND user_id = ${userId}
      `;
      const rows = await tx`
        DELETE FROM area_categories WHERE id = ${categoryId} AND user_id = ${userId}
        RETURNING id
      `;
      return rows.length > 0;
    });
  }
}
