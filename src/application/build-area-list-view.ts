import { circleBounds, type AreaColorKey } from '@/application/build-area-map-view.ts';
import type { Area, AreaCategory } from '@/domain/types.ts';

/** One row of the areas list. */
export type AreaListRow = {
  areaId: string;
  userId: string;
  name: string;
  lat: number;
  lon: number;
  /** Radius in meters. */
  radius: number;
  /** Null when the area is uncategorised. */
  categoryId: string | null;
  categoryName: string | null;
  /** The same colour key its circle is drawn with. */
  colorKey: AreaColorKey;
  /** `[west, south, east, north]` around the whole circle, for zooming the map to it. */
  bounds: [number, number, number, number];
};

/** A user's areas in one category, or the uncategorised ones when `category` is null. */
export type AreaGroup = {
  category: AreaCategory | null;
  rows: AreaListRow[];
};

/** One of the user's categories, as the Categories section lists it. */
export type AreaCategoryRow = AreaCategory & {
  /** How many areas deleting it would leave uncategorised. */
  areaCount: number;
};

export type AreaListView = {
  rows: AreaListRow[];
  /**
   * The rows by category: categories in the order given, then uncategorised.
   * Only groups with areas appear.
   */
  groups: AreaGroup[];
  categories: AreaCategoryRow[];
};

/**
 * The areas list and its grouping. `categories` are the areas' owner's, in the
 * order they should be shown (the repository's: by name); an area whose
 * category isn't among them counts as uncategorised.
 */
export function buildAreaListView(areas: Area[], categories: AreaCategory[] = []): AreaListView {
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  const rows = areas
    .map((area): AreaListRow => {
      const category = area.categoryId ? categoryById.get(area.categoryId) : undefined;
      return {
        areaId: area.id,
        userId: area.userId,
        name: area.name,
        lat: area.lat,
        lon: area.lon,
        radius: area.radius,
        categoryId: category?.id ?? null,
        categoryName: category?.name ?? null,
        colorKey: category?.color ?? 'none',
        bounds: circleBounds(area.lat, area.lon, area.radius),
      };
    })
    .sort(
      (a, b) =>
        a.userId.localeCompare(b.userId) ||
        a.name.localeCompare(b.name) ||
        a.areaId.localeCompare(b.areaId),
    );

  const groups: AreaGroup[] = [
    ...categories.map((category) => ({
      category,
      rows: rows.filter((row) => row.categoryId === category.id),
    })),
    { category: null, rows: rows.filter((row) => row.categoryId === null) },
  ].filter((group) => group.rows.length > 0);

  return {
    rows,
    groups,
    categories: categories.map((category) => ({
      ...category,
      areaCount: rows.filter((row) => row.categoryId === category.id).length,
    })),
  };
}
