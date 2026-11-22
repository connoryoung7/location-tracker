import { AREA_CATEGORY_COLORS, type AreaCategory, type AreaCategoryColor } from '@/domain/types.ts';

/**
 * The colour for a user's next category: the one their categories use least,
 * earliest in the palette on a tie. So the first three categories get three
 * different colours, and after that colours repeat as evenly as they can.
 */
export function pickAreaCategoryColor(categories: AreaCategory[]): AreaCategoryColor {
  const uses = new Map<AreaCategoryColor, number>(AREA_CATEGORY_COLORS.map((color) => [color, 0]));
  for (const category of categories) {
    uses.set(category.color, (uses.get(category.color) ?? 0) + 1);
  }

  let leastUsed: AreaCategoryColor = AREA_CATEGORY_COLORS[0];
  for (const color of AREA_CATEGORY_COLORS) {
    if (uses.get(color)! < uses.get(leastUsed)!) leastUsed = color;
  }
  return leastUsed;
}
