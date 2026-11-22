import { expect, test } from 'bun:test';
import { AREA_CATEGORY_COLORS } from '@/domain/types.ts';

// The palette is named in three places: the domain (what the server accepts and
// stores), app.css (each key's light and dark shade) and app.js (which keys the
// map colours). These keep the three from drifting apart.
const css = await Bun.file(new URL('../../../public/app.css', import.meta.url)).text();
const js = await Bun.file(new URL('../../../public/app.js', import.meta.url)).text();

test('app.js colours the map with exactly the domain palette, in order', () => {
  const match = js.match(/const CATEGORY_COLOR_KEYS = \[([^\]]*)\];/);
  expect(match).not.toBeNull();
  const keys = [...match![1]!.matchAll(/'([^']+)'/g)].map(([, key]) => key);

  expect(keys).toEqual([...AREA_CATEGORY_COLORS]);
});

test('app.css gives every palette key, and the neutral one, a light and a dark shade', () => {
  for (const key of [...AREA_CATEGORY_COLORS, 'none']) {
    const shades = [...css.matchAll(new RegExp(`--category-${key}:\\s*(#[0-9a-f]{6})`, 'gi'))];
    expect(shades.map(([, hex]) => hex)).toHaveLength(2);
  }
});

test('app.css has a swatch rule for every palette key', () => {
  for (const key of AREA_CATEGORY_COLORS) {
    expect(css).toContain(`.category-swatch[data-color='${key}']`);
  }
});
