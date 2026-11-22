/**
 * OpenFreeMap vector basemaps: free, no API key, and muted enough that the
 * per-user area colours stand out. One per colour scheme, matching Pico's.
 */
export const BASEMAP_STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

export function basemapStyleFor(isDark) {
  return isDark ? BASEMAP_STYLES.dark : BASEMAP_STYLES.light;
}

/**
 * Builds the next style with the page's own sources and layers (areas, events,
 * draft preview, places…) carried over from the previous one. Anything whose
 * source isn't part of the outgoing basemap counts as the page's own.
 * MapLibre serialises a GeoJSON source with its latest `setData`, so the
 * overlays come across with what they were showing, and stay drawn on top.
 */
export function carryOverlays(previous, next, basemapSourceIds) {
  const overlaySourceIds = Object.keys(previous.sources).filter(
    (id) => !basemapSourceIds.has(id),
  );
  const overlaySources = Object.fromEntries(
    overlaySourceIds.map((id) => [id, previous.sources[id]]),
  );
  const overlayLayers = previous.layers.filter((layer) => overlaySourceIds.includes(layer.source));

  return {
    ...next,
    sources: { ...next.sources, ...overlaySources },
    layers: [...next.layers, ...overlayLayers],
  };
}

/**
 * Swaps the basemap whenever the OS colour scheme changes, without a reload.
 * The sidebar already follows the scheme through Pico's CSS.
 *
 * Call it straight after creating the map, before any overlay is added: the
 * basemap's own sources are read on the first `style.load`, and everything
 * added after that is treated as an overlay to keep.
 *
 * MapLibre's default diff mode applies the new style in one step, serialising
 * the current one at that moment, so overlay data set while the new style was
 * being fetched is carried too. If the diff fails, MapLibre rebuilds the style
 * and calls `transformStyle` a second time; reading the outgoing basemap from
 * this switch's own snapshot keeps that second call correct.
 */
export function followColorScheme(map, mediaQuery) {
  let basemapSourceIds = null;

  map.once('style.load', () => {
    basemapSourceIds = new Set(Object.keys(map.getStyle().sources));
  });

  mediaQuery.addEventListener('change', (event) => {
    // Nothing to carry until the first style has loaded. A change that early is
    // rare (the page is still opening) and the next one will still apply.
    if (basemapSourceIds === null) return;

    const outgoingSourceIds = basemapSourceIds;
    map.setStyle(basemapStyleFor(event.matches), {
      transformStyle: (previous, next) => {
        basemapSourceIds = new Set(Object.keys(next.sources));
        return carryOverlays(previous, next, outgoingSourceIds);
      },
    });
  });
}
