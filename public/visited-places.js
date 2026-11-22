/**
 * Map layer and list behaviour for the Places visited panel. Kept apart from
 * app.js: it owns its own source, layer, popup, and fragment handling, and
 * only needs the map and a way to tell whether a click belongs to drawing.
 */

const SOURCE_ID = 'visited-places';
export const PLACES_LAYER_ID = 'places-points';
/** Matches `--place-color` in app.css. */
const PLACE_COLOR = '#7c3aed';
const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };

function formatTime(isoTime) {
  return new Date(isoTime).toLocaleString();
}

export function attachVisitedPlaces(map, { Popup, isDrawing, root = document }) {
  /** Latest view from the server, held until the style finishes loading. */
  let pendingView = null;
  let isLoaded = false;

  map.on('load', () => {
    map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY_COLLECTION });
    map.addLayer({
      id: PLACES_LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      paint: {
        // Busier places draw larger.
        'circle-radius': ['interpolate', ['linear'], ['get', 'visitCount'], 1, 6, 10, 12],
        'circle-color': PLACE_COLOR,
        'circle-opacity': 0.85,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });
    isLoaded = true;
    show(pendingView);
  });

  function show(view) {
    if (!isLoaded) return;

    map.getSource(SOURCE_ID).setData(view ? view.featureCollection : EMPTY_COLLECTION);
    // Results are only ever fetched on request, so framing them never fights a poll.
    if (view?.bounds) {
      map.fitBounds(view.bounds, { padding: 60, maxZoom: 15 });
    }
  }

  map.on('click', PLACES_LAYER_ID, (event) => {
    if (isDrawing()) return;

    const feature = event.features?.[0];
    if (!feature) return;

    const { label, category, note, visitCount, durationLabel } = feature.properties;
    // Place names come from OpenStreetMap and area names from users: both untrusted.
    const container = root.createElement('div');
    container.className = 'pico popup';
    const title = root.createElement('p');
    title.className = 'popup-label';
    title.textContent = label;
    const detail = root.createElement('p');
    detail.className = 'popup-detail';
    detail.textContent = [
      category ?? note,
      `${visitCount} ${visitCount === 1 ? 'visit' : 'visits'}`,
      durationLabel,
    ]
      .filter(Boolean)
      .join(' · ');
    container.append(title, detail);

    new Popup().setLngLat(feature.geometry.coordinates).setDOMContent(container).addTo(map);
  });

  map.on('mouseenter', PLACES_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', PLACES_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });

  const list = root.getElementById('places');

  list.addEventListener('click', (event) => {
    const button = event.target.closest('.place-locate');
    if (!button) return;

    map.flyTo({
      center: [Number(button.dataset.lon), Number(button.dataset.lat)],
      zoom: Math.max(map.getZoom(), 16),
    });
  });

  root.body.addEventListener('htmx:afterSwap', (event) => {
    if (event.target !== list) return;

    // The server renders UTC so it never guesses a zone; show the viewer's local time.
    for (const time of list.querySelectorAll('time[datetime]')) {
      time.textContent = formatTime(time.dateTime);
    }

    // An error swap has no data block: keep showing the last good result.
    const dataElement = root.getElementById('places-data');
    if (!dataElement) return;
    pendingView = JSON.parse(dataElement.textContent);
    show(pendingView);
  });
}
