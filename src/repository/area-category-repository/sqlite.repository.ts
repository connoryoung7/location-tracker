import type { Database } from 'bun:sqlite';
import type { AreaCategoryRepository } from '@/domain/ports.ts';
import type { AreaCategory, AreaCategoryColor } from '@/domain/types.ts';

type CategoryRow = { id: string; user_id: string; name: string; color: AreaCategoryColor };

function toCategory(row: CategoryRow): AreaCategory {
  return { id: row.id, userId: row.user_id, name: row.name, color: row.color };
}

const SELECT_COLUMNS = 'id, user_id, name, color';

/**
 * Area categories when running without Postgres. Names are compared with
 * SQLite's `lower()`, which folds ASCII letters only, matching the unique index.
 */
export class SqliteAreaCategoryRepository implements AreaCategoryRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async listCategories(userId: string): Promise<AreaCategory[]> {
    const rows = this.db
      .query(
        `SELECT ${SELECT_COLUMNS} FROM area_categories WHERE user_id = ? ORDER BY lower(name), id`,
      )
      .all(userId) as CategoryRow[];
    return rows.map(toCategory);
  }

  async getCategory(userId: string, categoryId: string): Promise<AreaCategory | undefined> {
    const row = this.db
      .query(`SELECT ${SELECT_COLUMNS} FROM area_categories WHERE id = ? AND user_id = ?`)
      .get(categoryId, userId) as CategoryRow | null;
    return row ? toCategory(row) : undefined;
  }

  async findCategoryByName(userId: string, name: string): Promise<AreaCategory | undefined> {
    const row = this.db
      .query(
        `SELECT ${SELECT_COLUMNS} FROM area_categories WHERE user_id = ? AND lower(name) = lower(?)`,
      )
      .get(userId, name) as CategoryRow | null;
    return row ? toCategory(row) : undefined;
  }

  async addCategory(category: AreaCategory): Promise<'added' | 'name-taken'> {
    if (await this.findCategoryByName(category.userId, category.name)) return 'name-taken';
    this.db.run(`INSERT INTO area_categories (id, user_id, name, color) VALUES (?, ?, ?, ?)`, [
      category.id,
      category.userId,
      category.name,
      category.color,
    ]);
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

    this.db.run(
      `UPDATE area_categories
       SET name = COALESCE(?, name), color = COALESCE(?, color), updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
      [changes.name ?? null, changes.color ?? null, categoryId, userId],
    );
    return 'updated';
  }

  async removeCategory(userId: string, categoryId: string): Promise<boolean> {
    // This connection doesn't enforce foreign keys, so the areas are cleared
    // here rather than by ON DELETE SET NULL.
    return this.db.transaction(() => {
      this.db.run(
        `UPDATE areas SET category_id = NULL, updated_at = datetime('now')
         WHERE category_id = ? AND user_id = ?`,
        [categoryId, userId],
      );
      const { changes } = this.db.run(`DELETE FROM area_categories WHERE id = ? AND user_id = ?`, [
        categoryId,
        userId,
      ]);
      return changes > 0;
    })();
  }
}
