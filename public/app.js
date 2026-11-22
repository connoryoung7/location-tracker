import { createDraftMarker } from '/static/draft-marker.js';
import { createAreaForm } from '/static/area-form.js';
import {
  guardStaleResponses,
  rememberUserSelection,
  restoreUserSelection,
  syncUserActions,
  updateUserSelect,
  watchUserScope,
} from '/static/user-scope.js';
import { attachVisitedPlaces, PLACES_LAYER_ID } from '/static/visited-places.js';
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
const EVENTS_SOURCE_ID = 'events';
const EVENT_COLORS = { entered: '#16a34a', exited: '#dc2626' };
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

/** The page-wide user. Everything on the page shows or acts on this one user. */
const userSelect = document.getElementById('user-select');

/** Latest view from the server, held until the style finishes loading. */
let pendingView = null;
let isStyleLoaded = false;
/** Latest events view, held until the style finishes loading. */
let pendingEventsView = null;
/**
 * The user the map was last framed for. Each user is framed once, by whichever
 * of their areas or events arrives first, so polls never move the view.
 */
let framedUserId = null;
/** The open popup, closed when the user changes so it can't act on the previous user. */
let activePopup = null;

function showPopup(popup) {
  activePopup?.remove();
  activePopup = popup.addTo(map);
  return activePopup;
}

function frameUserOnce(userId, bounds) {
  if (!userId || !bounds || userId === framedUserId) {
    return;
  }

  // Jump straight there on page load; animate only when switching users.
  const isFirstFrame = framedUserId === null;
  framedUserId = userId;
  map.fitBounds(bounds, { padding: 60, maxZoom: 15, ...(isFirstFrame ? { duration: 0 } : {}) });
}

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

  // Added after the areas so the points sit on top of the circles they mark.
  map.addSource(EVENTS_SOURCE_ID, { type: 'geojson', data: EMPTY_COLLECTION });
  map.addLayer({
    id: 'events-points',
    type: 'circle',
    source: EVENTS_SOURCE_ID,
    paint: {
      'circle-radius': 6,
      'circle-color': [
        'match',
        ['get', 'kind'],
        'entered',
        EVENT_COLORS.entered,
        EVENT_COLORS.exited,
      ],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  });

  isStyleLoaded = true;
  if (pendingView) {
    render(pendingView);
  }
  renderEvents(pendingEventsView);
});

// Registered after the load handler above, so place points draw over the areas.
// `drawState` and `areaForm` are declared further down; these only run once a click arrives.
const visitedPlaces = attachVisitedPlaces(map, {
  Popup,
  isDrawing: () => drawState !== 'idle',
  proposeArea: (draft) => {
    const proposal = areaForm.propose(draft);
    map.flyTo({
      center: [Number(draft.lon), Number(draft.lat)],
      zoom: Math.max(map.getZoom(), 16),
    });
    return proposal;
  },
});

function formatEventTime(isoTime) {
  return new Date(isoTime).toLocaleString();
}

map.on('click', 'events-points', (event) => {
  if (drawState !== 'idle') {
    return;
  }

  const feature = event.features?.[0];
  if (!feature) {
    return;
  }

  const { kind, areaLabel, isoTime } = feature.properties;
  // Area names are untrusted, so the popup is built with textContent.
  const container = document.createElement('div');
  container.className = 'pico popup';
  const label = document.createElement('p');
  label.className = 'popup-label';
  label.textContent = `${kind === 'entered' ? 'Entered' : 'Exited'} ${areaLabel} · ${formatEventTime(isoTime)}`;
  container.append(label);

  showPopup(new Popup().setLngLat(feature.geometry.coordinates).setDOMContent(container));
});

map.on('mouseenter', 'events-points', () => {
  map.getCanvas().style.cursor = 'pointer';
});
map.on('mouseleave', 'events-points', () => {
  map.getCanvas().style.cursor = '';
});

/** `null` clears the points, which happens when no user is selected. */
function renderEvents(view) {
  if (!isStyleLoaded) {
    return;
  }

  map.getSource(EVENTS_SOURCE_ID).setData(view ? view.featureCollection : EMPTY_COLLECTION);
  frameUserOnce(view?.userId, view?.bounds);
}

// Only the selected user's responses are ever swapped in (see `guardStaleResponses`),
// so whatever lands here is theirs.
function readSwappedEvents() {
  const dataElement = document.getElementById('events-data');
  if (!dataElement) {
    return;
  }

  pendingEventsView = JSON.parse(dataElement.textContent);
  renderEvents(pendingEventsView);
}

// The server groups events into days; send the viewer's zone so they are the viewer's days.
// Runs before htmx's `load` trigger: module scripts execute before DOMContentLoaded.
document.getElementById('user-scope-tz').value = Intl.DateTimeFormat().resolvedOptions().timeZone;

document.getElementById('events').addEventListener('click', (event) => {
  const button = event.target.closest('.event-locate');
  if (!button) {
    return;
  }

  map.flyTo({
    center: [Number(button.dataset.lon), Number(button.dataset.lat)],
    zoom: Math.max(map.getZoom(), 15),
  });
});

// --- Areas list dialog ------------------------------------------------------

const areaListDialog = document.getElementById('area-list-dialog');

document.getElementById('area-list-open').addEventListener('click', () => {
  // textContent: user IDs are untrusted.
  document.getElementById('area-list-title').textContent = userSelect.value
    ? `Areas for ${userSelect.value}`
    : 'Areas';
  areaListDialog.showModal();
  window.htmx?.trigger('#area-list', 'refresh');
});

document.getElementById('area-list-close').addEventListener('click', () => areaListDialog.close());

// Pico's modal fills the viewport, so a click that lands on the dialog itself is the backdrop.
areaListDialog.addEventListener('click', (event) => {
  if (event.target === areaListDialog) areaListDialog.close();
});

document.getElementById('area-list').addEventListener('click', (event) => {
  const button = event.target.closest('.area-list-show');
  if (!button) {
    return;
  }

  areaListDialog.close();
  map.fitBounds(JSON.parse(button.dataset.bounds), { padding: 60, maxZoom: 17 });
});

// Each area in the Areas panel zooms the map to its circle.
document.getElementById('areas').addEventListener('click', (event) => {
  const button = event.target.closest('.area-locate');
  if (!button) {
    return;
  }

  map.fitBounds(JSON.parse(button.dataset.bounds), { padding: 60, maxZoom: 17 });
});

// A delete from the list refreshes #areas (and so the map); reload the list too.
document.body.addEventListener('htmx:afterRequest', (event) => {
  if (event.detail.elt.classList?.contains('area-list-delete') && event.detail.successful) {
    window.htmx?.trigger('#area-list', 'refresh');
  }
});

// Recompute replaces the user's history, so reload the list once it succeeds.
document.body.addEventListener('htmx:afterRequest', (event) => {
  if (event.detail.elt.id === 'recompute-form' && event.detail.successful) {
    window.htmx?.trigger('#events', 'refresh');
  }
});

map.on('click', 'areas-fill', (event) => {
  // While drawing, a click is placing the new area, not inspecting an old one.
  if (drawState !== 'idle') {
    return;
  }
  // An event or place point inside the area opens its own popup instead.
  if (
    map.queryRenderedFeatures(event.point, { layers: ['events-points', PLACES_LAYER_ID] }).length >
    0
  ) {
    return;
  }

  const feature = event.features?.[0];
  if (!feature) {
    return;
  }

  const { name, userId, radius, areaId } = feature.properties;

  // Built as DOM rather than an HTML string: area names are untrusted, and
  // textContent cannot be escaped wrong.
  const container = document.createElement('div');
  // Opts the popup into Pico's scoped styles; the map itself stays outside them.
  container.className = 'pico popup';
  const label = document.createElement('p');
  label.className = 'popup-label';
  label.textContent = `${name} (${Math.round(radius)}m)`;

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

  const popup = showPopup(new Popup().setLngLat(event.lngLat).setDOMContent(container));
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

function render(view) {
  map.getSource(SOURCE_ID).setData(view.featureCollection);
  frameUserOnce(view.userId, view.bounds);
}

/**
 * HTMX delivers the areas as a JSON block inside the swapped fragment, so the
 * panel markup and the map data always come from the same response.
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

document.body.addEventListener('htmx:afterSwap', (event) => {
  if (event.target.id === 'events') {
    readSwappedEvents();
    return;
  }

  if (event.target.id === 'areas') {
    readSwappedView();
  }
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
  // Naming an area must not cancel pending map placement.
  if (['lat', 'lon', 'radius'].includes(event.target.name)) {
    drawState = 'editing';
    map.getCanvas().style.cursor = '';
  }
});
document.getElementById('draw-form').addEventListener('submit', () => {
  if (drawCentre !== null) drawState = 'editing';
  map.getCanvas().style.cursor = drawState === 'placing' ? 'crosshair' : '';
});

// --- The page-wide user ------------------------------------------------------

// Runs before htmx's `load` trigger, so the first fragment loads carry the user.
guardStaleResponses(document);
const initialSelection = restoreUserSelection(document);
rememberUserSelection(document, initialSelection.userId);
syncUserActions(document, initialSelection.userId);
updateTitle(initialSelection.userId);

/** What the header's status line is currently saying, so a poll knows what it may clear. */
let userNotice = null;
let hasCheckedRequestedUser = false;

function showUserNotice(kind, tone, message) {
  userNotice = kind;
  setNotice('user-status', tone, message);
}

function updateTitle(userId) {
  document.title = userId ? `${userId} — Location Tracker` : 'Location Tracker';
}

watchUserScope(document, {
  isDraftOpen: () => areaForm.isOpen(),
  discardDraft: () => areaForm.discard(),
  confirmSwitch: (next) =>
    askToConfirm(`Switch to ${next || 'no user'}? The area you're drafting will be discarded.`),
  // Creating an area takes a moment; its completion closes the form, so it has
  // to finish for the current user before anyone else's draft can start.
  isSwitchBlocked: () => areaForm.isSaving(),
  onSwitchBlocked: () => {
    // Shown beside the button being waited on; saving or failing replaces it.
    document.getElementById('form-error').textContent =
      'Still saving this area. Switch users once it is done.';
  },
  onChange: (userId) => {
    rememberUserSelection(document, userId);
    syncUserActions(document, userId);
    updateTitle(userId);
    if (userNotice === 'unknown-user') showUserNotice(null, 'info', '');

    // Nothing of the previous user's may stay on the map while the new user's
    // panels load. Their fragments reload themselves via `change from:#user-scope`.
    activePopup?.remove();
    pendingView = null;
    pendingEventsView = null;
    if (isStyleLoaded) {
      map.getSource(SOURCE_ID).setData(EMPTY_COLLECTION);
      map.getSource(EVENTS_SOURCE_ID).setData(EMPTY_COLLECTION);
    }
    // A Find places still running for the previous user would only be discarded
    // when it answers; cancel it now so its button is free for the new user.
    window.htmx?.trigger('#places-form', 'htmx:abort');
    visitedPlaces.clear();
    setNotice('recompute-result', 'info', '');
  },
});

// User polling updates only options; it never replaces draft fields or review.
async function refreshUsers() {
  try {
    const response = await fetch('/users');
    if (!response.ok) throw new Error('Could not load users. Retrying…');
    const users = await response.json();
    // The first poll is where an unknown `?user=` is found out; fall back to the
    // user remembered in this browser before the sole user or the placeholder.
    updateUserSelect(document, users, {
      fallback: hasCheckedRequestedUser ? '' : initialSelection.remembered,
    });
    syncUserActions(document, userSelect.value);

    if (!hasCheckedRequestedUser) {
      hasCheckedRequestedUser = true;
      // A user named in the URL who doesn't exist is worth saying so; a stale
      // remembered one is just replaced.
      const requested = initialSelection.source === 'url' ? initialSelection.userId : '';
      if (requested && !users.includes(requested)) {
        showUserNotice(
          'unknown-user',
          'error',
          `There's no tracked user “${requested}”. ${
            userSelect.value ? `Showing ${userSelect.value} instead.` : 'Select a user to continue.'
          }`,
        );
        return;
      }
    }

    if (users.length === 0) {
      showUserNotice('no-users', 'info', 'No tracked users yet. Send a location to get started.');
    } else if (userNotice === 'no-users' || userNotice === 'poll-error') {
      showUserNotice(null, 'info', '');
    }
  } catch (error) {
    showUserNotice('poll-error', 'error', error.message);
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
 * A styled replacement for the browser's native `confirm()`, used for every
 * `hx-confirm` and for questions the page asks itself. Cancelling (the button,
 * Escape, or a backdrop click) runs `onDismiss`; htmx then never sends its request.
 */
const confirmDialog = document.getElementById('confirm-dialog');
let pendingConfirm = null;

function openConfirm(question, onAccept, onDismiss = () => {}) {
  pendingConfirm = { onAccept, onDismiss };
  document.getElementById('confirm-message').textContent = question;
  confirmDialog.showModal();
  document.getElementById('confirm-accept').focus();
}

/** Resolves true if the question is confirmed, false if it is dismissed. */
function askToConfirm(question) {
  return new Promise((resolve) => {
    openConfirm(
      question,
      () => resolve(true),
      () => resolve(false),
    );
  });
}

document.body.addEventListener('htmx:confirm', (event) => {
  if (!event.detail.question) return;
  event.preventDefault();
  const { detail } = event;
  openConfirm(detail.question, () => detail.issueRequest(true));
});

document.getElementById('confirm-accept').addEventListener('click', () => {
  const pending = pendingConfirm;
  // Cleared first, so the close handler below doesn't treat this as a dismissal.
  pendingConfirm = null;
  confirmDialog.close();
  pending?.onAccept();
});

document.getElementById('confirm-cancel').addEventListener('click', () => confirmDialog.close());

confirmDialog.addEventListener('click', (event) => {
  if (event.target === confirmDialog) confirmDialog.close();
});

confirmDialog.addEventListener('close', () => {
  const pending = pendingConfirm;
  pendingConfirm = null;
  pending?.onDismiss();
});
