import { describe, expect, mock, test } from 'bun:test';
import {
  BASEMAP_STYLES,
  basemapStyleFor,
  carryOverlays,
  followColorScheme,
} from '@/../public/basemap.js';

type Layer = { id: string; type: string; source?: string };
type Style = { version: 8; sources: Record<string, unknown>; layers: Layer[] };

const positron: Style = {
  version: 8,
  sources: { openmaptiles: { type: 'vector' }, ne2_shaded: { type: 'raster' } },
  layers: [
    { id: 'background', type: 'background' },
    { id: 'shaded', type: 'raster', source: 'ne2_shaded' },
    { id: 'water', type: 'fill', source: 'openmaptiles' },
  ],
};

const dark: Style = {
  version: 8,
  sources: { openmaptiles: { type: 'vector' } },
  layers: [
    { id: 'background', type: 'background' },
    { id: 'water', type: 'fill', source: 'openmaptiles' },
  ],
};

const areasData = { type: 'FeatureCollection', features: [{ type: 'Feature' }] };

/** Positron with the page's overlays added on top, as `map.getStyle()` would serialise it. */
const positronWithOverlays: Style = {
  ...positron,
  sources: {
    ...positron.sources,
    areas: { type: 'geojson', data: areasData },
    'draw-preview': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  },
  layers: [
    ...positron.layers,
    { id: 'areas-fill', type: 'fill', source: 'areas' },
    { id: 'areas-outline', type: 'line', source: 'areas' },
    { id: 'draw-fill', type: 'fill', source: 'draw-preview' },
  ],
};

describe('basemapStyleFor', () => {
  test('dark scheme gets the dark basemap, light gets positron', () => {
    expect(basemapStyleFor(true)).toBe(BASEMAP_STYLES.dark);
    expect(basemapStyleFor(false)).toBe(BASEMAP_STYLES.light);
  });
});

describe('carryOverlays', () => {
  const basemapSourceIds = new Set(Object.keys(positron.sources));

  test('keeps the overlays, with their current data, on top of the new basemap', () => {
    const next = carryOverlays(positronWithOverlays, dark, basemapSourceIds);

    expect(Object.keys(next.sources).sort()).toEqual(['areas', 'draw-preview', 'openmaptiles']);
    expect(next.sources.areas).toEqual({ type: 'geojson', data: areasData });
    expect(next.layers.map((layer: Layer) => layer.id)).toEqual([
      'background',
      'water',
      'areas-fill',
      'areas-outline',
      'draw-fill',
    ]);
  });

  test("drops the outgoing basemap's own sources and layers", () => {
    const next = carryOverlays(positronWithOverlays, dark, basemapSourceIds);

    expect(next.sources.ne2_shaded).toBeUndefined();
    expect(next.layers.find((layer: Layer) => layer.id === 'shaded')).toBeUndefined();
  });

  test('takes everything else from the incoming style, including its version', () => {
    const next = carryOverlays(positronWithOverlays, { ...dark, glyphs: 'g' }, basemapSourceIds);

    expect(next.glyphs).toBe('g');
    expect(next.version).toBe(8);
  });
});

/** Just enough of a MapLibre map for `followColorScheme`. */
function mockMap(initialStyle: Style) {
  const onceHandlers = new Map<string, () => void>();
  return {
    once: (event: string, handler: () => void) => void onceHandlers.set(event, handler),
    getStyle: () => initialStyle,
    setStyle: mock(
      (_url: string, _options: { transformStyle: (previous: Style, next: Style) => Style }) => {},
    ),
    fire: (event: string) => {
      const handler = onceHandlers.get(event);
      onceHandlers.delete(event);
      handler?.();
    },
  };
}

function mockMediaQuery() {
  let onChange: (event: { matches: boolean }) => void = () => {};
  return {
    addEventListener: (_type: 'change', handler: typeof onChange) => {
      onChange = handler;
    },
    change: (matches: boolean) => onChange({ matches }),
  };
}

describe('followColorScheme', () => {
  test('switching to dark swaps the style and carries the overlays', () => {
    const map = mockMap(positron);
    const mediaQuery = mockMediaQuery();
    followColorScheme(map, mediaQuery);
    // Basemap sources are read on the first style.load, before overlays exist.
    map.fire('style.load');

    mediaQuery.change(true);

    expect(map.setStyle).toHaveBeenCalledTimes(1);
    const [url, { transformStyle }] = map.setStyle.mock.calls[0]!;
    expect(url).toBe(BASEMAP_STYLES.dark);
    const next = transformStyle(positronWithOverlays, dark);
    expect(next.sources.areas).toBeDefined();
    expect(next.sources.ne2_shaded).toBeUndefined();
  });

  test('a rebuild after a failed diff, which transforms twice, gives the same result', () => {
    const map = mockMap(positron);
    const mediaQuery = mockMediaQuery();
    followColorScheme(map, mediaQuery);
    map.fire('style.load');

    mediaQuery.change(true);
    const [, { transformStyle }] = map.setStyle.mock.calls[0]!;
    const first = transformStyle(positronWithOverlays, dark);
    const second = transformStyle(positronWithOverlays, dark);

    expect(second).toEqual(first);
    expect(second.sources.ne2_shaded).toBeUndefined();
  });

  test('switching back carries the overlays again, judged against the dark basemap', () => {
    const map = mockMap(positron);
    const mediaQuery = mockMediaQuery();
    followColorScheme(map, mediaQuery);
    map.fire('style.load');
    mediaQuery.change(true);
    const darkWithOverlays = map.setStyle.mock.calls[0]![1].transformStyle(
      positronWithOverlays,
      dark,
    );

    mediaQuery.change(false);

    const [url, { transformStyle }] = map.setStyle.mock.calls[1]!;
    expect(url).toBe(BASEMAP_STYLES.light);
    const next = transformStyle(darkWithOverlays, positron);
    expect(Object.keys(next.sources).sort()).toEqual([
      'areas',
      'draw-preview',
      'ne2_shaded',
      'openmaptiles',
    ]);
    expect(next.layers.filter((layer: Layer) => layer.id === 'areas-fill')).toHaveLength(1);
  });

  test('a change before the first style has loaded is ignored', () => {
    const map = mockMap(positron);
    const mediaQuery = mockMediaQuery();
    followColorScheme(map, mediaQuery);

    mediaQuery.change(true);

    expect(map.setStyle).not.toHaveBeenCalled();
  });
});
