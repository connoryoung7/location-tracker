/**
 * Hover tooltip for the map's dots. After the cursor has rested on dots for a
 * moment, it lists when each one under it happened, newest first, so dots
 * drawn on top of one another can still be told apart without clicking.
 *
 * Each layer brings its own `describe(properties)`, which turns one of its
 * dots into a tooltip entry, or returns null for a dot that should not be
 * listed (such as one left over from the previous user while MapLibre
 * redraws). Entries are `{ key, color, label, isoTime, timePrefix? }`:
 * `key` identifies the dot, so a dot found twice is listed once.
 */

/** Long enough that sweeping the cursor across the map doesn't flash tooltips. */
const HOVER_DELAY_MS = 400;
/** A tight cluster can hold dozens of dots; past this, the rest are counted. */
const MAX_LISTED = 8;

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Turns the features under the cursor into tooltip entries, newest first.
 * Dots their layer leaves out, and repeats of the same dot, are dropped.
 */
export function listDotEntries(features, describers) {
  const keys = new Set();
  const entries = [];
  for (const feature of features) {
    const entry = describers[feature.layer.id]?.(feature.properties);
    if (!entry || keys.has(entry.key)) continue;
    keys.add(entry.key);
    entries.push(entry);
  }
  // ISO 8601 UTC strings sort chronologically as text.
  return entries.sort((a, b) => b.isoTime.localeCompare(a.isoTime));
}

/** The tooltip's content. Labels are untrusted, so it is built with textContent. */
export function renderDotEntries(root, entries) {
  const container = root.createElement('div');
  container.className = 'pico popup';
  const list = root.createElement('ul');
  list.className = 'dot-times';
  for (const entry of entries.slice(0, MAX_LISTED)) {
    const item = root.createElement('li');
    const swatch = root.createElement('span');
    swatch.className = 'dot-swatch';
    swatch.style.background = entry.color;
    const label = root.createElement('span');
    label.className = 'dot-label';
    label.textContent = entry.label;
    const time = root.createElement('time');
    time.dateTime = entry.isoTime;
    const formatted = timeFormat.format(new Date(entry.isoTime));
    time.textContent = entry.timePrefix ? `${entry.timePrefix} ${formatted}` : formatted;
    item.append(swatch, label, time);
    list.append(item);
  }
  container.append(list);

  const hiddenCount = entries.length - MAX_LISTED;
  if (hiddenCount > 0) {
    const more = root.createElement('p');
    more.className = 'popup-detail';
    more.textContent = `+${hiddenCount} more`;
    container.append(more);
  }
  return container;
}

/**
 * Shows the tooltip for the layers in `describers` (layer ID → `describe`).
 * `isEnabled()` turns it off while the map is busy with something else, such
 * as drawing an area. Returns `reset()`, for when the dots on the map stop
 * meaning what they did (another user was selected).
 */
export function attachDotTooltip(
  map,
  { Popup, describers, isEnabled, root = document, delayMs = HOVER_DELAY_MS },
) {
  let timer = null;
  let tooltip = null;
  /** The dots under the cursor, as a key. The tooltip waits again only when it changes. */
  let hoveredKey = '';
  let lastLngLat = null;

  function dismiss() {
    clearTimeout(timer);
    timer = null;
    tooltip?.remove();
    tooltip = null;
  }

  function reset() {
    hoveredKey = '';
    dismiss();
  }

  function entriesAt(point) {
    // A basemap switch rebuilds the style, and querying a missing layer throws.
    const layers = Object.keys(describers).filter((id) => map.getLayer(id));
    if (layers.length === 0) return [];
    return listDotEntries(map.queryRenderedFeatures(point, { layers }), describers);
  }

  map.on('mousemove', (event) => {
    lastLngLat = event.lngLat;
    // While panning, dots slide under a cursor that isn't resting on them.
    if (!isEnabled() || map.isMoving()) {
      reset();
      return;
    }

    const entries = entriesAt(event.point);
    const key = entries.map((entry) => entry.key).join('\n');
    // Still on the same dots: keep the tooltip, or keep waiting for it.
    if (key === hoveredKey) return;
    hoveredKey = key;
    dismiss();
    if (entries.length === 0) return;

    timer = setTimeout(() => {
      timer = null;
      tooltip = new Popup({
        closeButton: false,
        closeOnClick: false,
        className: 'dot-tooltip',
        offset: 14,
        maxWidth: '320px',
      })
        .setLngLat(lastLngLat)
        .setDOMContent(renderDotEntries(root, entries))
        .addTo(map);
    }, delayMs);
  });

  // Leaving the map, the cursor is on no dot at all.
  map.on('mouseout', reset);
  // A click opens the dot's own popup, and a press may start a pan. Either
  // way the tooltip goes, and stays gone until the cursor finds other dots.
  map.on('mousedown', dismiss);

  return { reset };
}
