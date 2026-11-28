/**
 * Map layer and list behaviour for the Places visited panel. Kept apart from
 * app.js: it owns its own source, layer, popup, and fragment handling, and
 * only needs the map, a way to tell whether a click belongs to drawing, and a
 * way to open an area draft for a place.
 */

const SOURCE_ID = 'visited-places';
export const PLACES_LAYER_ID = 'places-points';
/** Matches `--place-color` in app.css. */
const PLACE_COLOR = '#7c3aed';
const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };

function formatTime(isoTime) {
  return new Date(isoTime).toLocaleString();
}

/**
 * `proposeArea(draft)` opens a pre-filled area draft and resolves true once
 * the user saves it, false if they abandon it.
 */
export function attachVisitedPlaces(map, { Popup, isDrawing, proposeArea, root = document }) {
  /** Latest view from the server, held until the style finishes loading. */
  let pendingView = null;
  let isLoaded = false;
  /** Places of the current view saved as areas; a new view starts over. */
  let savedPlaceIds = new Set();
  /** The place popup last opened. Its content describes one view, so it closes with it. */
  let openPopup = null;
  /** Counts views. Each view's points carry its number as `viewGeneration`. */
  let viewGeneration = 0;
  const SAVED_MESSAGE = 'Saved as an area.';
  const list = root.getElementById('places');

  function findRow(view, placeId) {
    return view?.rows.find((row) => row.placeId === placeId);
  }

  function closePopup() {
    openPopup?.remove();
    openPopup = null;
  }

  /**
   * Opens the place's area draft, from the list or a popup alike. Once it is
   * saved, the list row says so and later popups for it do too. The next Find
   * places names it after the area.
   *
   * `view` is the result the button came from. Place IDs restart with every
   * result, so a button from an older one, or for a place already saved, does
   * nothing rather than propose some other place.
   */
  async function saveAsArea(placeId, view) {
    if (view !== pendingView || savedPlaceIds.has(placeId)) return;
    const row = findRow(view, placeId);
    if (!row?.proposedArea) return;

    // The draft's circle and centre marker would sit right under the popup. No
    // other popup can open meanwhile: points ignore clicks while drawing.
    closePopup();
    const isSaved = await proposeArea({ userId: view.userId, ...row.proposedArea });
    // A newer result replaced the rows, and its place IDs mean different places.
    if (!isSaved || view !== pendingView) return;
    savedPlaceIds.add(placeId);
    for (const button of list.querySelectorAll('.place-save-area')) {
      if (button.dataset.placeId === placeId) {
        button.closest('.place-propose').replaceChildren(SAVED_MESSAGE);
      }
    }
  }

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

    // Optional: the source is briefly missing if a basemap switch has to rebuild the style.
    map.getSource(SOURCE_ID)?.setData(view ? view.featureCollection : EMPTY_COLLECTION);
    // Results are only ever fetched on request, so framing them never fights a poll.
    if (view?.bounds) {
      map.fitBounds(view.bounds, { padding: 60, maxZoom: 15 });
    }
  }

  map.on('click', PLACES_LAYER_ID, (event) => {
    if (isDrawing()) return;

    const feature = event.features?.[0];
    if (!feature) return;
    // setData applies asynchronously, so an older view's points stay clickable
    // for a moment. Their place IDs would name different places in this view.
    if (feature.properties.viewGeneration !== viewGeneration) return;

    const { placeId, label, category, note, visitCount, durationLabel } = feature.properties;
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

    const view = pendingView;
    const row = findRow(view, placeId);
    if (savedPlaceIds.has(placeId)) {
      const saved = root.createElement('p');
      saved.className = 'popup-detail';
      saved.textContent = SAVED_MESSAGE;
      container.append(saved);
    } else if (row?.proposedArea) {
      const save = root.createElement('button');
      save.type = 'button';
      save.className = 'popup-save-area outline';
      save.textContent = 'Save as area';
      save.addEventListener('click', () => saveAsArea(placeId, view));
      container.append(save);
    }

    closePopup();
    openPopup = new Popup()
      .setLngLat(feature.geometry.coordinates)
      .setDOMContent(container)
      .addTo(map);
  });

  map.on('mouseenter', PLACES_LAYER_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', PLACES_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
  });

  list.addEventListener('click', (event) => {
    const save = event.target.closest('.place-save-area');
    if (save) {
      // The list and pendingView are swapped together, so the row is from this view.
      saveAsArea(save.dataset.placeId, pendingView);
      return;
    }

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
    viewGeneration += 1;
    for (const feature of pendingView.featureCollection.features) {
      feature.properties.viewGeneration = viewGeneration;
    }
    savedPlaceIds = new Set();
    closePopup();
    show(pendingView);
  });

  return {
    /**
     * A place point's entry in the map's hover tooltip (see dot-tooltip.js),
     * or null for a point from an older view, whose place ID now names a
     * different place.
     */
    describeDot(properties) {
      if (properties.viewGeneration !== viewGeneration) return null;
      return {
        key: `place:${viewGeneration}:${properties.placeId}`,
        color: PLACE_COLOR,
        label: properties.label,
        isoTime: properties.lastVisitIso,
        timePrefix: 'Last visit',
      };
    },

    /**
     * Drops the results and their map points, for when the selected user
     * changes. Places are only ever found on request, so nothing reloads.
     * Like a new result, it starts a new view: the old points ignore clicks
     * while MapLibre removes them, and nothing counts as saved any more.
     */
    clear() {
      pendingView = null;
      viewGeneration += 1;
      savedPlaceIds = new Set();
      closePopup();
      list.replaceChildren();
      show(null);
    },
  };
}
