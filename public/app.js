// maplibre-gl v6 ships named ESM exports only — there is no default export.
import {
  MapLibreMap,
  NavigationControl,
  Popup,
  ScaleControl,
} from '/vendor/maplibre/maplibre-gl.mjs';

const SOURCE_ID = 'areas';
const DRAW_SOURCE_ID = 'draw-preview';
const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };

/**
 * Must match EARTH_RADIUS_METERS in `@/application/build-area-map-view.ts`. The
 * server computes the geometry that actually gets stored; this is only the live
 * preview while dragging, so a small divergence would be cosmetic.
 */
const EARTH_RADIUS_METERS = 6_371_008.8;
const PREVIEW_VERTICES = 64;

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

  map.addSource(DRAW_SOURCE_ID, { type: 'geojson', data: EMPTY_COLLECTION });
  map.addLayer({
    id: 'draw-fill',
    type: 'fill',
    source: DRAW_SOURCE_ID,
    paint: { 'fill-color': '#111827', 'fill-opacity': 0.15 },
  });
  map.addLayer({
    id: 'draw-outline',
    type: 'line',
    source: DRAW_SOURCE_ID,
    paint: { 'line-color': '#111827', 'line-width': 2, 'line-dasharray': [2, 2] },
  });

  isStyleLoaded = true;
  if (pendingView) {
    render(pendingView);
  }
});

map.on('click', 'areas-fill', (event) => {
  // While drawing, a click is placing the new area, not inspecting an old one.
  if (drawState !== 'idle') {
    return;
  }

  const feature = event.features?.[0];
  if (!feature) {
    return;
  }

  const { name, userId, radius, areaId } = feature.properties;

  // Built as DOM rather than an HTML string: area names and user IDs are
  // untrusted, and textContent cannot be escaped wrong.
  const container = document.createElement('div');
  const label = document.createElement('p');
  label.className = 'popup-label';
  label.textContent = `${name} — ${userId} (${Math.round(radius)}m)`;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'popup-delete';
  remove.textContent = 'Delete';
  remove.setAttribute('hx-delete', `/areas/${encodeURIComponent(userId)}/${encodeURIComponent(areaId)}`);
  remove.setAttribute('hx-target', '#areas');
  remove.setAttribute('hx-swap', 'innerHTML');
  remove.setAttribute('hx-confirm', `Delete "${name}"?`);

  container.append(label, remove);

  const popup = new Popup().setLngLat(event.lngLat).setDOMContent(container).addTo(map);
  // The button was created after htmx scanned the page, so wire it up by hand.
  window.htmx?.process(container);
  remove.addEventListener('click', () => popup.remove());
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

// --- Drawing a new area -----------------------------------------------------

const drawForm = document.getElementById('draw-form');
const drawStart = document.getElementById('draw-start');
const drawCancel = document.getElementById('draw-cancel');
const drawReadout = document.getElementById('draw-readout');

/** 'idle' | 'placing' (awaiting a centre) | 'sizing' (dragging the radius) */
let drawState = 'idle';
let drawCentre = null;
let drawRadius = 0;

/** Great-circle distance in metres between two `[lon, lat]` points. */
function distanceMeters([lonA, latA], [lonB, latB]) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(latB - latA);
  const deltaLon = toRadians(lonB - lonA);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(latA)) * Math.cos(toRadians(latB)) * Math.sin(deltaLon / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

/** Preview ring; mirrors `circleToRing` on the server. */
function previewRing([lon, lat], radius) {
  const latitudeDelta = (radius / EARTH_RADIUS_METERS) * (180 / Math.PI);
  const longitudeDelta = latitudeDelta / Math.cos((lat * Math.PI) / 180);

  const ring = [];
  for (let vertex = 0; vertex < PREVIEW_VERTICES; vertex += 1) {
    const angle = (vertex / PREVIEW_VERTICES) * 2 * Math.PI;
    ring.push([lon + longitudeDelta * Math.cos(angle), lat + latitudeDelta * Math.sin(angle)]);
  }
  ring.push(ring[0]);

  return ring;
}

function setPreview(centre, radius) {
  const source = map.getSource(DRAW_SOURCE_ID);
  if (!source) {
    return;
  }

  source.setData(
    centre === null || radius <= 0
      ? EMPTY_COLLECTION
      : {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'Polygon', coordinates: [previewRing(centre, radius)] },
            },
          ],
        },
  );
}

function enterDrawMode() {
  drawState = 'placing';
  drawCentre = null;
  drawRadius = 0;
  drawForm.hidden = false;
  drawStart.hidden = true;
  drawReadout.textContent = 'Click the map to place the centre';
  map.getCanvas().style.cursor = 'crosshair';
  setPreview(null, 0);
}

function exitDrawMode() {
  drawState = 'idle';
  drawCentre = null;
  drawRadius = 0;
  drawForm.hidden = true;
  drawForm.reset();
  drawStart.hidden = false;
  map.getCanvas().style.cursor = '';
  setPreview(null, 0);
}

function writeDrawFields() {
  drawForm.elements.lat.value = drawCentre === null ? '' : String(drawCentre[1]);
  drawForm.elements.lon.value = drawCentre === null ? '' : String(drawCentre[0]);
  drawForm.elements.radius.value = drawRadius > 0 ? String(Math.round(drawRadius)) : '';
}

drawStart.addEventListener('click', enterDrawMode);
drawCancel.addEventListener('click', exitDrawMode);

map.on('click', (event) => {
  if (drawState === 'idle') {
    return;
  }

  const point = [event.lngLat.lng, event.lngLat.lat];

  if (drawState === 'placing') {
    drawCentre = point;
    drawState = 'sizing';
    drawReadout.textContent = 'Move out to size it, then click to fix';
    return;
  }

  // Second click fixes the radius. A zero-radius area is rejected server-side,
  // so keep sizing until the pointer has actually moved off the centre.
  if (drawRadius > 0) {
    drawState = 'placing';
    drawReadout.textContent = `Centre set · radius ${Math.round(drawRadius)}m`;
    writeDrawFields();
    map.getCanvas().style.cursor = '';
  }
});

map.on('mousemove', (event) => {
  if (drawState !== 'sizing' || drawCentre === null) {
    return;
  }

  drawRadius = distanceMeters(drawCentre, [event.lngLat.lng, event.lngLat.lat]);
  drawReadout.textContent = `Radius ${Math.round(drawRadius)}m`;
  setPreview(drawCentre, drawRadius);
  writeDrawFields();
});

// A successful save re-renders the legend; clear the draw state so the panel is
// ready for the next one. Failures keep the form so the input can be corrected.
document.body.addEventListener('htmx:afterRequest', (event) => {
  if (event.target !== drawForm) {
    return;
  }

  if (event.detail.successful && event.detail.xhr?.status === 200) {
    exitDrawMode();
  }
});
