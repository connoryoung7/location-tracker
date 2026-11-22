import type { AreaCategoryRepository } from '@/domain/ports.ts';
import type { AreaStore } from '@/repository/area-repository/create-area-repository.ts';
import { PostgresAreaCategoryRepository } from '@/repository/area-category-repository/postgres.repository.ts';
import { SqliteAreaCategoryRepository } from '@/repository/area-category-repository/sqlite.repository.ts';

/** Categories live in the same store as the areas they group. */
export function createAreaCategoryRepository(store: AreaStore): AreaCategoryRepository {
  return store.kind === 'postgres'
    ? new PostgresAreaCategoryRepository(store.sql)
    : new SqliteAreaCategoryRepository(store.db);
}
