import { createDraftMarker } from '/static/draft-marker.js';
import { createAreaForm, updateUserSelects } from '/static/area-form.js';
// maplibre-gl v6 ships named ESM exports only — there is no default export.
import {
  MapLibreMap,
  Marker,
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

/**
 * OpenFreeMap vector basemaps: free, no API key, and muted enough that the
 * per-user area colours stand out. Picked once at load to match the sidebar's
 * colour scheme; switching live would need setStyle, which drops the area layers.
 */
const BASEMAP_STYLE = window.matchMedia('(prefers-color-scheme: dark)').matches
  ? 'https://tiles.openfreemap.org/styles/dark'
  : 'https://tiles.openfreemap.org/styles/positron';

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
  // Opts the popup into Pico's scoped styles; the map itself stays outside them.
  container.className = 'pico popup';
  const label = document.createElement('p');
  label.className = 'popup-label';
  label.textContent = `${name} — ${userId} (${Math.round(radius)}m)`;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'popup-delete outline';
  remove.textContent = 'Delete';
  remove.setAttribute(
    'hx-delete',
    `/areas/${encodeURIComponent(userId)}/${encodeURIComponent(areaId)}`,
  );
  remove.setAttribute('hx-target', '#areas');
  remove.setAttribute('hx-swap', 'innerHTML');
  remove.setAttribute('hx-confirm', `Delete "${name}"?`);

  container.append(label, remove);

  const popup = new Popup().setLngLat(event.lngLat).setDOMContent(container).addTo(map);
  // The button was created after htmx scanned the page, so wire it up by hand.
  window.htmx?.process(container);
  // Closed once the request is actually sent: the confirm dialog is async, so
  // closing on click would detach the button before the user had answered.
  remove.addEventListener('htmx:beforeRequest', () => popup.remove());
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

const drawReadout = document.getElementById('draw-readout');

/** 'idle' | 'placing' | 'sizing' | 'editing' */
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

const draftMarker = createDraftMarker(map, Marker, (centre, radius) => {
  drawState = 'editing';
  map.getCanvas().style.cursor = '';
  areaForm.setGeometry(centre, radius);
  document.getElementById('draw-coordinates').open = true;
  document.getElementById('draw-placement-hint').textContent =
    'Drag the centre marker or edit the coordinates and radius. Choose Review area when ready.';
});

const areaForm = createAreaForm(document, {
  preview: (centre, radius) => {
    setPreview(centre, radius);
    draftMarker.update(centre, radius);
    drawCentre = centre;
    drawRadius = radius;
    drawReadout.textContent = centre
      ? `Centre ${centre[1]}, ${centre[0]} · radius ${radius}m`
      : 'Set a valid centre and radius';
  },
  editingChanged: (isEditable) => draftMarker.setEditable(isEditable),
  started: () => {
    drawState = 'placing';
    drawCentre = null;
    drawRadius = 0;
    drawReadout.textContent = 'Click the map to place the centre';
    map.getCanvas().style.cursor = 'crosshair';
    setPreview(null, 0);
    draftMarker.update(null, 0);
  },
  placementChanged: (mode) => {
    drawState = mode === 'map' ? 'placing' : 'editing';
    drawCentre = null;
    drawRadius = 0;
    map.getCanvas().style.cursor = mode === 'map' ? 'crosshair' : '';
  },
  cancelled: () => {
    drawState = 'idle';
    drawCentre = null;
    drawRadius = 0;
    map.getCanvas().style.cursor = '';
  },
  saved: () => window.htmx?.trigger('#areas', 'refresh'),
});

document.getElementById('draw-form').addEventListener('input', (event) => {
  // Naming an area or selecting a user must not cancel pending map placement.
  if (['lat', 'lon', 'radius'].includes(event.target.name)) {
    drawState = 'editing';
    map.getCanvas().style.cursor = '';
  }
});
document.getElementById('draw-form').addEventListener('submit', () => {
  if (drawCentre !== null) drawState = 'editing';
  map.getCanvas().style.cursor = drawState === 'placing' ? 'crosshair' : '';
});

// User polling updates only options; it never replaces draft fields or review.
async function refreshUsers() {
  try {
    const response = await fetch('/users');
    if (!response.ok) throw new Error('Could not load users. Retrying…');
    const users = await response.json();
    updateUserSelects(document, users);
    setNotice(
      'user-status',
      'info',
      users.length ? '' : 'No tracked users yet. Send a location to get started.',
    );
  } catch (error) {
    setNotice('user-status', 'error', error.message);
  }
}
refreshUsers();
setInterval(refreshUsers, 30000);

map.on('click', (event) => {
  if (drawState !== 'placing' && drawState !== 'sizing') return;

  const point = [((((event.lngLat.lng + 180) % 360) + 360) % 360) - 180, event.lngLat.lat];

  if (drawState === 'placing') {
    drawCentre = point;
    drawState = 'sizing';
    drawRadius = 0;
    draftMarker.update(point, 0);
    drawReadout.textContent = 'Move out to size it, then click to fix';
    return;
  }

  // Use the click position too, so two taps work without mousemove events.
  drawRadius = distanceMeters(drawCentre, point);
  if (drawRadius > 0) {
    drawState = 'editing';
    drawReadout.textContent = `Centre set · radius ${Math.round(drawRadius)}m`;
    areaForm.setGeometry(drawCentre, drawRadius);
    document.getElementById('draw-coordinates').open = true;
    document.getElementById('draw-placement-hint').textContent =
      'Drag the centre marker or edit the coordinates and radius. Choose Review area when ready.';
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
  areaForm.setGeometry(drawCentre, drawRadius);
});

/** Sets a status line's text and tone; an empty message hides it via CSS. */
function setNotice(id, tone, message) {
  const element = document.getElementById(id);
  element.dataset.tone = tone;
  element.textContent = message;
}

// The recompute endpoint answers 422/503 with plain text into the same target
// as a success, so the tone has to come from the status code.
document.body.addEventListener('htmx:afterSwap', (event) => {
  const { target, xhr } = event.detail;
  if (target?.id === 'recompute-result') {
    target.dataset.tone = xhr.status < 400 ? 'success' : 'error';
  }
});

/**
 * Replaces the browser's native `confirm()` for every `hx-confirm` with a
 * styled dialog. htmx waits until `issueRequest` is called, so cancelling (the
 * button, Escape, or a backdrop click) simply never sends the request.
 */
const confirmDialog = document.getElementById('confirm-dialog');
let pendingConfirm = null;

document.body.addEventListener('htmx:confirm', (event) => {
  if (!event.detail.question) return;
  event.preventDefault();
  pendingConfirm = event.detail;
  document.getElementById('confirm-message').textContent = event.detail.question;
  confirmDialog.showModal();
  document.getElementById('confirm-accept').focus();
});

document.getElementById('confirm-accept').addEventListener('click', () => {
  const detail = pendingConfirm;
  pendingConfirm = null;
  confirmDialog.close();
  detail?.issueRequest(true);
});

document.getElementById('confirm-cancel').addEventListener('click', () => confirmDialog.close());

confirmDialog.addEventListener('click', (event) => {
  if (event.target === confirmDialog) confirmDialog.close();
});

confirmDialog.addEventListener('close', () => {
  pendingConfirm = null;
});
