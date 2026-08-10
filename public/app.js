// maplibre-gl v6 ships named ESM exports only — there is no default export.
import {
  MapLibreMap,
  NavigationControl,
  Popup,
  ScaleControl,
} from '/vendor/maplibre/maplibre-gl.mjs';

const SOURCE_ID = 'areas';
const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };

// Raster OSM basemap. MapLibre needs a style, and this avoids an API key.
const BASEMAP_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

const map = new MapLibreMap({
  container: 'map',
  style: BASEMAP_STYLE,
  center: [0, 0],
  zoom: 1,
});
map.addControl(new NavigationControl(), 'top-right');
map.addControl(new ScaleControl());

/** Latest view from the server, held until the style finishes loading. */
let pendingView = null;
let isStyleLoaded = false;
let hasFramedAreas = false;
const hiddenUserIds = new Set();

map.on('load', () => {
  map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY_COLLECTION });

  map.addLayer({
    id: 'areas-fill',
    type: 'fill',
    source: SOURCE_ID,
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.2 },
  });
  map.addLayer({
    id: 'areas-outline',
    type: 'line',
    source: SOURCE_ID,
    paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
  });

  isStyleLoaded = true;
  if (pendingView) {
    render(pendingView);
  }
});

map.on('click', 'areas-fill', (event) => {
  const feature = event.features?.[0];
  if (!feature) {
    return;
  }

  const { name, userId, radius } = feature.properties;
  new Popup()
    .setLngLat(event.lngLat)
    // setText, not setHTML: area names are untrusted user input.
    .setText(`${name} — ${userId} (${radius}m)`)
    .addTo(map);
});

map.on('mouseenter', 'areas-fill', () => {
  map.getCanvas().style.cursor = 'pointer';
});
map.on('mouseleave', 'areas-fill', () => {
  map.getCanvas().style.cursor = '';
});

function applyUserFilter() {
  if (!isStyleLoaded) {
    return;
  }

  const filter =
    hiddenUserIds.size === 0
      ? null
      : ['!', ['in', ['get', 'userId'], ['literal', [...hiddenUserIds]]]];

  map.setFilter('areas-fill', filter);
  map.setFilter('areas-outline', filter);
}

function render(view) {
  map.getSource(SOURCE_ID).setData(view.featureCollection);
  applyUserFilter();

  // Frame the areas once, on the first load that actually has some.
  if (!hasFramedAreas && view.bounds) {
    map.fitBounds(view.bounds, { padding: 60, maxZoom: 15, duration: 0 });
    hasFramedAreas = true;
  }
}

/**
 * HTMX delivers the areas as a JSON block inside the swapped fragment, so the
 * legend markup and the map data always come from the same response.
 */
function readSwappedView() {
  const dataElement = document.getElementById('areas-data');
  if (!dataElement) {
    return;
  }

  const view = JSON.parse(dataElement.textContent);
  pendingView = view;

  if (isStyleLoaded) {
    render(view);
  }
}

/**
 * The server renders every legend row as checked, so a poll would otherwise
 * show a hidden user as visible while the map still filtered them out. Which
 * users are hidden is client-side state, so it has to be reapplied after each
 * swap replaces the inputs.
 */
function restoreLegendState() {
  for (const input of document.querySelectorAll('#areas input[data-user-id]')) {
    input.checked = !hiddenUserIds.has(input.dataset.userId);
  }
}

document.body.addEventListener('htmx:afterSwap', (event) => {
  if (event.target.id !== 'areas') {
    return;
  }

  readSwappedView();
  restoreLegendState();
});

document.body.addEventListener('change', (event) => {
  const userId = event.target.dataset?.userId;
  if (userId === undefined) {
    return;
  }

  if (event.target.checked) {
    hiddenUserIds.delete(userId);
  } else {
    hiddenUserIds.add(userId);
  }

  applyUserFilter();
});
