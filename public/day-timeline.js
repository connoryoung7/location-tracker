/**
 * Map layers, list behaviour and playback for the Day timeline panel. Kept
 * apart from app.js, like visited-places.js: it owns its own source, layers,
 * marker and fragment handling, and only needs the map and a marker class.
 */

const SOURCE_ID = 'day-timeline';
export const TIMELINE_LAYER_IDS = {
  trips: 'timeline-trips',
  estimatedTrips: 'timeline-trips-estimated',
  stops: 'timeline-stops',
};
/** Matches `--timeline-color` in app.css. */
const TIMELINE_COLOR = '#ea580c';
const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };

/**
 * Where the track puts the user at `tst` (Unix seconds): between two of its
 * points, a straight-line share of the way. `[lon, lat]`, or null before the
 * track starts or after it ends.
 */
export function positionAt(track, tst) {
  if (track.length === 0 || tst < track[0][2] || tst > track.at(-1)[2]) return null;

  // The last point at or before `tst`; the track is oldest first.
  let low = 0;
  let high = track.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (track[middle][2] <= tst) low = middle;
    else high = middle - 1;
  }

  const [lon, lat, at] = track[low];
  const next = track[low + 1];
  if (!next || next[2] === at) return [lon, lat];
  const share = (tst - at) / (next[2] - at);
  // The short way round in longitude, so a trip over the 180° meridian stays near it.
  let lonDelta = next[0] - lon;
  if (lonDelta > 180) lonDelta -= 360;
  else if (lonDelta < -180) lonDelta += 360;
  let position = lon + lonDelta * share;
  if (position > 180) position -= 360;
  else if (position < -180) position += 360;
  return [position, lat + (next[1] - lat) * share];
}

/** What the user was doing at `tst`, from the timeline rows, e.g. `At Home`. */
export function describeMoment(rows, tst) {
  const row = rows.find((candidate) => candidate.startsAt <= tst && tst <= candidate.endsAt);
  if (!row) return 'No location data';
  return row.kind === 'stop' ? `At ${row.label}` : `On the way: ${row.label}`;
}

/** The server labels rows in the viewer's zone, sent from this browser, so local time matches. */
function formatClock(tst) {
  return new Date(tst * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function attachDayTimeline(map, { Marker, root = document }) {
  /** Latest view from the server, held until the style finishes loading. */
  let pendingView = null;
  let isLoaded = false;
  /** Shows where the user was at the playback slider's time. */
  let marker = null;
  /**
   * Set when the source was missing for a moment, as it is while a basemap
   * switch rebuilds the style, so the day is drawn once the new style loads.
   */
  let isRedrawPending = false;
  const list = root.getElementById('timeline');

  map.on('load', () => {
    map.addSource(SOURCE_ID, { type: 'geojson', data: EMPTY_COLLECTION });
    map.addLayer({
      id: TIMELINE_LAYER_IDS.trips,
      type: 'line',
      source: SOURCE_ID,
      filter: ['all', ['==', ['get', 'kind'], 'trip'], ['!', ['get', 'isPathEstimated']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': TIMELINE_COLOR, 'line-width': 4, 'line-opacity': 0.85 },
    });
    // No fixes on the way: a straight guess between the stops, so drawn dashed.
    map.addLayer({
      id: TIMELINE_LAYER_IDS.estimatedTrips,
      type: 'line',
      source: SOURCE_ID,
      filter: ['all', ['==', ['get', 'kind'], 'trip'], ['get', 'isPathEstimated']],
      paint: {
        'line-color': TIMELINE_COLOR,
        'line-width': 3,
        'line-opacity': 0.7,
        'line-dasharray': [2, 2],
      },
    });
    map.addLayer({
      id: TIMELINE_LAYER_IDS.stops,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['==', ['get', 'kind'], 'stop'],
      paint: {
        'circle-radius': 6,
        'circle-color': '#ffffff',
        'circle-stroke-color': TIMELINE_COLOR,
        'circle-stroke-width': 3,
      },
    });
    isLoaded = true;
    show(pendingView);
  });

  function draw(view) {
    const source = map.getSource(SOURCE_ID);
    if (!source) {
      isRedrawPending = true;
      return;
    }
    source.setData(view ? view.featureCollection : EMPTY_COLLECTION);
  }

  function show(view) {
    if (!isLoaded) return;

    draw(view);
    // Timelines are only ever fetched on request, so framing them never fights a poll.
    if (view?.bounds) {
      map.fitBounds(view.bounds, { padding: 60, maxZoom: 15 });
    }
  }

  // The rebuilt style carries the source over with the data it last had; draw
  // whatever arrived meanwhile, without framing the map again.
  map.on('style.load', () => {
    if (!isLoaded || !isRedrawPending) return;
    isRedrawPending = false;
    draw(pendingView);
  });

  function removeMarker() {
    marker?.remove();
    marker = null;
  }

  /** Moves the playback marker and caption to `tst`. */
  function play(tst) {
    if (!pendingView) return;

    const caption = root.getElementById('timeline-caption');
    if (caption)
      caption.textContent = `${formatClock(tst)} · ${describeMoment(pendingView.rows, tst)}`;

    const position = positionAt(pendingView.track, tst);
    if (!position) {
      removeMarker();
      return;
    }
    if (marker) {
      marker.setLngLat(position);
    } else {
      marker = new Marker({ color: TIMELINE_COLOR }).setLngLat(position).addTo(map);
    }
  }

  list.addEventListener('click', (event) => {
    const button = event.target.closest('.timeline-locate');
    const row = pendingView?.rows.find(
      (candidate) => candidate.entryId === button?.dataset.entryId,
    );
    if (!row) return;

    const [west, south, east, north] = row.bounds;
    if (west === east && south === north) {
      map.flyTo({ center: [west, south], zoom: Math.max(map.getZoom(), 16) });
    } else {
      map.fitBounds(row.bounds, { padding: 60, maxZoom: 16 });
    }

    // Playback jumps to the start of what was clicked.
    const scrubber = root.getElementById('timeline-scrubber');
    if (scrubber) {
      scrubber.value = String(row.startsAt);
      play(row.startsAt);
    }
  });

  list.addEventListener('input', (event) => {
    if (event.target.id === 'timeline-scrubber') play(Number(event.target.value));
  });

  root.body.addEventListener('htmx:afterSwap', (event) => {
    if (event.target !== list) return;

    // An error swap has no data block: keep showing the last good day.
    const dataElement = root.getElementById('timeline-data');
    if (!dataElement) return;
    pendingView = JSON.parse(dataElement.textContent);
    removeMarker();
    show(pendingView);
    const scrubber = root.getElementById('timeline-scrubber');
    if (scrubber) play(Number(scrubber.value));
  });

  return {
    /** Drops the day and its map features, for when the selected user changes. */
    clear() {
      pendingView = null;
      removeMarker();
      list.replaceChildren();
      show(null);
    },
  };
}
