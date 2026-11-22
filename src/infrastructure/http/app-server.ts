import express from 'express';
import escapeHtml from 'escape-html';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildAreaEventView,
  type AreaEventListRow,
  type AreaEventView,
} from '@/application/build-area-event-view.ts';
import { buildAreaListView, type AreaListView } from '@/application/build-area-list-view.ts';
import { buildAreaMapView, type AreaMapView } from '@/application/build-area-map-view.ts';
import {
  buildVisitedPlaceView,
  type VisitedPlaceRow,
  type VisitedPlaceView,
} from '@/application/build-visited-place-view.ts';
import type { VisitedPlace } from '@/application/infer-visited-places.ts';
import { CreateAreaSchema } from '@/domain/schemas.ts';
import type { Area } from '@/domain/types.ts';
import type {
  AreaEventRepository,
  AreaRepository,
  Logger,
  MetricsCollector,
  TrackedUserRepository,
} from '@/domain/ports.ts';

/**
 * The map UI manages areas and triggers event-history recomputation, so it deliberately does not reuse the
 * ingestion app's `Deps` (location repository, decryptor, geofence evaluator,
 * event publisher).
 */
export interface AppDeps {
  users: TrackedUserRepository;
  recompute?: (userId: string) => Promise<{ locations: number; before: number; after: number }>;
  /** Works out where a user stopped within `range` (Unix epoch seconds). */
  visitedPlaces?: (userId: string, range: { from?: number }) => Promise<VisitedPlace[]>;
  areaRepo: AreaRepository;
  areaEvents: AreaEventRepository;
  logger: Logger;
  metrics: MetricsCollector;
}

/** How often the browser re-fetches the areas fragment. */
const REFRESH_INTERVAL = '30s';

const VENDOR_PACKAGES = {
  maplibre: 'maplibre-gl/dist/maplibre-gl.mjs',
  htmx: 'htmx.org/dist/htmx.min.js',
  pico: '@picocss/pico',
} as const;

/**
 * Serializes JSON for embedding in a `<script>` block. Escaping `<` is what stops
 * an area named `</script><script>…` from breaking out of the element. This is a
 * JSON string escape, not HTML sanitization — the value stays byte-identical once
 * `JSON.parse` runs in the browser.
 */
function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** Same limit as `CreateAreaSchema`, so every route accepts the same IDs. */
const MAX_USER_ID_LENGTH = 64;

type UserIdParam = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'valid'; userId: string };

/**
 * Reads the page-wide user from a query string or body. Blank means no user is
 * selected yet, which fragments answer with a prompt rather than an error.
 */
function parseUserId(value: unknown): UserIdParam {
  if (typeof value !== 'string' || !value.trim()) return { kind: 'missing' };
  if (value.length > MAX_USER_ID_LENGTH) return { kind: 'invalid' };
  return { kind: 'valid', userId: value };
}

/** The areas data the map reads, tagged with whose areas they are. */
type AreasPanelData = AreaMapView & { userId: string };

function renderAreasData(data: AreasPanelData): string {
  return `<script type="application/json" id="areas-data">${escapeJsonForScript(data)}</script>`;
}

function renderAreasFragment(userId: string, areas: Area[]): string {
  const data = renderAreasData({ userId, ...buildAreaMapView(areas) });
  const { rows } = buildAreaListView(areas);
  if (rows.length === 0) {
    return `
    <p class="legend-empty">No areas for ${escapeHtml(userId)} yet. Use <strong>Add area</strong> to draw one.</p>
    ${data}
  `;
  }

  const items = rows
    .map(
      (row) => `
      <li>
        <button type="button" class="area-locate" data-bounds="${escapeHtml(JSON.stringify(row.bounds))}">
          <span class="legend-swatch" style="background:${escapeHtml(row.color)}"></span>
          <span class="area-name">${escapeHtml(row.name)}</span>
          <span class="area-radius">${Math.round(row.radius)} m</span>
        </button>
      </li>`,
    )
    .join('');

  return `
    <p class="area-count">${rows.length} ${rows.length === 1 ? 'area' : 'areas'}</p>
    <ul class="area-names">${items}</ul>
    ${data}
  `;
}

/**
 * Shown until a user is selected. Carries an empty data block so the map drops
 * the previous user's circles instead of leaving them behind.
 */
function renderAreasPrompt(): string {
  return `
    <p class="legend-empty">Select a user above to see their areas.</p>
    ${renderAreasData({ userId: '', ...buildAreaMapView([]) })}
  `;
}

/** A user ID no route will accept. Carries no data block, so the map is left as it was. */
function renderUserError(): string {
  return '<p class="notice legend-error" data-tone="error" role="alert">Unknown user.</p>';
}

/**
 * Shown in place of the legend when the areas cannot be read. Deliberately
 * carries no `areas-data` block, so the map keeps whatever it last rendered
 * rather than blanking out.
 */
function renderAreasError(): string {
  return `<p class="notice legend-error" data-tone="error" role="alert">Could not reach the area store. Retrying…</p>`;
}

function formatCoordinate(value: number): string {
  return value.toFixed(5);
}

function renderAreaListFragment(userId: string, view: AreaListView): string {
  if (view.rows.length === 0) {
    return `<p class="legend-empty">No areas for ${escapeHtml(userId)} yet.</p>`;
  }

  const rows = view.rows
    .map(
      (row) => `
        <tr>
          <th scope="row" class="area-list-name">${escapeHtml(row.name)}</th>
          <td class="area-list-number">${formatCoordinate(row.lat)}, ${formatCoordinate(row.lon)}</td>
          <td class="area-list-number">${Math.round(row.radius)} m</td>
          <td class="area-list-actions">
            <button type="button" class="area-list-show secondary outline" data-bounds="${escapeHtml(JSON.stringify(row.bounds))}">Show</button>
            <button
              type="button"
              class="area-list-delete outline"
              hx-delete="/areas/${encodeURIComponent(row.userId)}/${encodeURIComponent(row.areaId)}"
              hx-target="#areas"
              hx-swap="innerHTML"
              hx-confirm="${escapeHtml(`Delete "${row.name}"?`)}"
            >Delete</button>
          </td>
        </tr>`,
    )
    .join('');

  return `
    <p class="area-list-count">${view.rows.length} ${view.rows.length === 1 ? 'area' : 'areas'}</p>
    <table class="area-list">
      <thead>
        <tr><th scope="col">Name</th><th scope="col">Centre</th><th scope="col">Radius</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/** How many of the selected user's most recent events the panel shows. */
const EVENT_LIST_LIMIT = 100;

function renderEventRow(row: AreaEventListRow): string {
  return `
            <li class="event-row event-${row.kind}">
              <button type="button" class="event-locate" data-lon="${row.lon}" data-lat="${row.lat}">
                <span class="event-kind">${row.kind === 'entered' ? 'Entered' : 'Exited'}</span>
                <span class="event-area">${escapeHtml(row.areaLabel)}</span>
                <time datetime="${row.isoTime}">${escapeHtml(row.timeLabel)}</time>
              </button>
            </li>`;
}

function renderEventsFragment(view: AreaEventView): string {
  const days = view.days
    .map((day) => {
      const count = `${day.rows.length} ${day.rows.length === 1 ? 'event' : 'events'}`;
      return `
      <li class="event-day">
        <h3 class="event-day-heading">
          <time datetime="${day.dateKey}">${escapeHtml(day.label)}</time>
          <span class="event-day-count">${count}</span>
        </h3>
        <ol class="event-list">${day.rows.map(renderEventRow).join('')}
        </ol>
      </li>`;
    })
    .join('');

  const emptyState =
    view.rows.length === 0 ? '<p class="events-empty">No events for this user yet.</p>' : '';

  return `
    ${emptyState}
    <ol class="event-days">${days}</ol>
    <script type="application/json" id="events-data">${escapeJsonForScript(view)}</script>
  `;
}

/**
 * Shown before a user is chosen. Carries an empty `events-data` block so the map
 * drops the previous user's points instead of leaving them behind.
 */
function renderEventsPrompt(): string {
  return `
    <p class="events-empty">Select a user above to see their events.</p>
    <script type="application/json" id="events-data">null</script>
  `;
}

/**
 * Like the areas error, it carries no `events-data` block, so the map keeps the
 * points it last rendered until the next poll succeeds.
 */
function renderEventsError(): string {
  return `<p class="notice legend-error" data-tone="error" role="alert">Could not load events. Retrying…</p>`;
}

/** The periods the places form offers, in days; `all` reads the whole history. */
const PLACE_PERIOD_DAYS: Record<string, number | undefined> = {
  '7': 7,
  '30': 30,
  '90': 90,
  all: undefined,
};

/** How many kinds of place the summary line names. */
const PLACE_CATEGORY_LIMIT = 4;

/**
 * Asks whether a place that is not yet an area should become one. The button
 * only opens a pre-filled draft in the New area form; nothing is saved until
 * the user confirms it there. The draft itself comes from the row's
 * `proposedArea` in the `places-data` block, which the map popup reads too.
 */
function renderAreaProposal(row: VisitedPlaceRow): string {
  if (!row.proposedArea) return '';
  return `
        <p class="place-propose">Make this a saved area?
          <button type="button" class="place-save-area outline" data-place-id="${escapeHtml(row.placeId)}">Save as area</button>
        </p>`;
}

function renderPlaceRow(row: VisitedPlaceRow): string {
  const detail = [row.category ?? row.note, row.durationLabel].filter(Boolean).join(' · ');
  const alternatives =
    row.alternatives.length === 0
      ? ''
      : `
        <details class="place-alternatives">
          <summary>Or nearby: ${row.alternatives.length} more</summary>
          <ul>${row.alternatives
            .map(
              (alternative) =>
                `<li>${escapeHtml(alternative.name)} <span>${escapeHtml(alternative.category)} · ${alternative.distanceMeters} m</span></li>`,
            )
            .join('')}</ul>
        </details>`;

  return `
      <li class="place-row place-${row.lookup}">
        <button type="button" class="place-locate" data-lon="${row.lon}" data-lat="${row.lat}">
          <span class="place-label">${escapeHtml(row.label)}</span>
          <span class="place-visits">${row.visitCount} ${row.visitCount === 1 ? 'visit' : 'visits'}</span>
          <span class="place-detail">${escapeHtml(detail)}</span>
          <span class="place-last">Last <time datetime="${row.lastVisitIso}">${row.lastVisitIso}</time></span>
        </button>${alternatives}${renderAreaProposal(row)}
      </li>`;
}

function renderPlacesFragment(view: VisitedPlaceView): string {
  const data = `<script type="application/json" id="places-data">${escapeJsonForScript(view)}</script>`;
  if (view.rows.length === 0) {
    return `<p class="events-empty">No stops of 5 minutes or more in this period.</p>${data}`;
  }

  const categories = view.categories
    .slice(0, PLACE_CATEGORY_LIMIT)
    .map(
      (category) =>
        `<li>${escapeHtml(category.category)} <strong>${category.visitCount}</strong></li>`,
    )
    .join('');
  const summary = categories
    ? `<ul class="place-categories" aria-label="Visits by kind of place">${categories}</ul>`
    : '';
  // OpenStreetMap data is ODbL-licensed and must be credited wherever it is shown.
  const usesOpenStreetMap = view.rows.some((row) => row.lookup === 'found');
  const attribution = usesOpenStreetMap
    ? '<p class="place-attribution">Nearest named place first, from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>. Each name is a best guess.</p>'
    : '';

  return `
    ${summary}
    <ol class="place-list">${view.rows.map(renderPlaceRow).join('')}</ol>
    ${attribution}
    ${data}
  `;
}

/**
 * Like the events error, it carries no `places-data` block, so the map keeps
 * the places it last showed.
 */
function renderPlacesNotice(message: string): string {
  return `<p class="notice legend-error" data-tone="error" role="alert">${escapeHtml(message)}</p>`;
}

/**
 * Out-of-band element carrying the draw form's error text. Sent alongside the
 * legend so a rejected area reports itself without blanking the sidebar; empty
 * on success, which also clears a previous error.
 */
function renderFormErrorOob(message: string): string {
  return `<p id="form-error" hx-swap-oob="true" class="notice" data-tone="error" role="status">${escapeHtml(message)}</p>`;
}

/**
 * @param selectedUserId From `?user=`. Rendered as the select's chosen option so
 *   the very first fragment loads already carry it, before `/users` answers.
 */
function renderPage(selectedUserId?: string): string {
  // htmx leaves disabled fields out of requests, so a preselected user keeps the
  // select enabled; with none, it waits disabled until the user poll fills it.
  const userSelect = selectedUserId
    ? `<select id="user-select" name="userId"><option value="${escapeHtml(selectedUserId)}" selected>${escapeHtml(selectedUserId)}</option></select>`
    : '<select id="user-select" name="userId" disabled><option value="">Loading users…</option></select>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!--
      htmx does not swap 4xx/5xx responses by default, which would hide the
      areas-unavailable message and form validation errors. Opt 422 and 503 in
      specifically; the rest of the defaults are repeated verbatim because this
      replaces the whole array.
    -->
    <meta
      name="htmx-config"
      content='{"responseHandling":[{"code":"204","swap":false},{"code":"422","swap":true},{"code":"503","swap":true},{"code":"[23]..","swap":true},{"code":"[45]..","swap":false,"error":true}]}'
    />
    <title>Location Tracker — Areas</title>
    <link rel="stylesheet" href="/vendor/pico/pico.conditional.min.css" />
    <link rel="stylesheet" href="/vendor/maplibre/maplibre-gl.css" />
    <link rel="stylesheet" href="/static/app.css" />
    <script src="/vendor/htmx/htmx.min.js" defer></script>
    <script type="module" src="/static/app.js"></script>
  </head>
  <body>
    <aside id="sidebar" class="pico">
      <header class="app-header">
        <svg class="app-logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7Zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Z" />
        </svg>
        <div>
          <h1>Location Tracker</h1>
          <p>Areas and geofence events</p>
        </div>
        <!--
          The one user the whole page shows. Every panel includes this form instead
          of keeping a selection of its own, and reloads when it changes.
        -->
        <form id="user-scope" class="user-scope">
          <!-- Set by app.js to the browser's zone, so events are grouped into the viewer's days. -->
          <input type="hidden" name="tz" id="user-scope-tz" />
          <label for="user-select">User</label>
          ${userSelect}
        </form>
        <p id="user-status" class="notice user-status" data-tone="info" role="status"></p>
      </header>

      <section class="panel" aria-labelledby="areas-heading">
        <div class="panel-header">
          <h2 id="areas-heading">Areas</h2>
          <button type="button" id="area-list-open" class="secondary outline" data-user-submit disabled>List areas</button>
        </div>
        <div
          id="areas"
          hx-get="/fragments/areas"
          hx-include="#user-scope"
          hx-trigger="load, change from:#user-scope, refresh, every ${REFRESH_INTERVAL}"
          hx-sync="this:replace"
          hx-swap="innerHTML"
        ></div>
      </section>

      <!--
        The draw panel sits outside #areas on purpose: the poll replaces that
        element every ${REFRESH_INTERVAL}, which would discard half-typed input.
      -->
      <section class="panel" id="draw-panel" aria-labelledby="draw-heading">
        <h2 id="draw-heading">New area</h2>
        <button type="button" id="draw-start" class="block" disabled>Add area</button>
        <form id="draw-form" hidden>
          <ol class="draw-steps" aria-label="Progress">
            <li class="draw-step-edit">Place &amp; adjust</li>
            <li class="draw-step-review">Review</li>
          </ol>
          <fieldset id="draw-fields">
            <label>Place circle
              <select id="draw-placement">
                <option value="map" selected>On the map</option>
                <option value="coordinates">Enter coordinates</option>
              </select>
            </label>
            <p class="draw-hint" id="draw-placement-hint">Click the map to place the centre, move to size the circle, then click again.</p>
            <label>Name <input type="text" name="name" required maxlength="200" /></label>
            <p class="draw-readout" id="draw-readout">No centre set</p>
            <details id="draw-coordinates">
              <summary>Adjust coordinates and radius</summary>
              <label>Latitude <input type="number" name="lat" required min="-90" max="90" step="any" /></label>
              <label>Longitude <input type="number" name="lon" required min="-180" max="180" step="any" /></label>
              <label>Radius (metres) <input type="number" name="radius" required min="0.01" max="100000" step="any" /></label>
            </details>
          </fieldset>
          <section id="draw-confirmation" class="draw-review" hidden aria-label="Confirm area">
            <h3>Review area</h3>
            <p>The circle is a draft. Confirm and create adds it to your saved areas.</p>
            <p id="draw-summary"></p>
            <button type="button" id="draw-back" class="secondary outline">Back to editing</button>
          </section>
          <div class="draw-actions">
            <button type="submit" id="draw-submit" data-user-submit disabled>Review area</button>
            <button type="button" id="draw-cancel" class="secondary outline">Cancel</button>
          </div>
        </form>
        <p id="form-error" class="notice" data-tone="error" role="status"></p>
      </section>

      <section class="panel" id="events-panel" aria-labelledby="events-heading">
        <h2 id="events-heading">Recent events</h2>
        <!-- Refreshed when the user changes, after a recompute, and on the same poll as the areas. -->
        <div
          id="events"
          hx-get="/fragments/events"
          hx-include="#user-scope"
          hx-trigger="load, change from:#user-scope, refresh, every ${REFRESH_INTERVAL}"
          hx-sync="this:replace"
          hx-swap="innerHTML"
        ></div>
      </section>

      <section class="panel" aria-labelledby="recompute-heading">
        <h2 id="recompute-heading">Event history</h2>
        <p class="panel-hint">Rebuild this user's entry and exit events from their stored locations and their current areas.</p>
        <form id="recompute-form" class="recompute-form" hx-post="/users/recompute" hx-include="#user-scope" hx-target="#recompute-result" hx-confirm="Replace this user's event history using their current areas?" hx-disabled-elt="find button">
          <button type="submit" class="secondary" data-user-submit disabled>Recompute events</button>
          <span class="htmx-indicator" aria-busy="true">Recomputing…</span>
        </form>
        <p id="recompute-result" class="notice" data-tone="info" role="status"></p>
      </section>

      <!-- Loaded only on request: each run reads the whole period and may look places up online. -->
      <section class="panel" id="places-panel" aria-labelledby="places-heading">
        <h2 id="places-heading">Places visited</h2>
        <p class="panel-hint">Find where this user stopped for 5 minutes or more, and what was there.</p>
        <form id="places-form" class="places-form" hx-get="/fragments/places" hx-include="#user-scope" hx-target="#places" hx-swap="innerHTML" hx-disabled-elt="find button">
          <label>Period
            <select name="days">
              <option value="7">Last 7 days</option>
              <option value="30" selected>Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="all">All time</option>
            </select>
          </label>
          <button type="submit" class="secondary" data-user-submit disabled>Find places</button>
          <span class="htmx-indicator" aria-busy="true">Finding places…</span>
        </form>
        <div id="places"></div>
      </section>

      <!-- Loaded each time it opens, so it never shows a stale copy of the poll. -->
      <dialog id="area-list-dialog" aria-labelledby="area-list-title">
        <article>
          <header>
            <button type="button" id="area-list-close" aria-label="Close" rel="prev"></button>
            <h3 id="area-list-title">Areas</h3>
          </header>
          <div id="area-list" hx-get="/fragments/area-list" hx-include="#user-scope" hx-trigger="refresh" hx-sync="this:replace" hx-swap="innerHTML"></div>
        </article>
      </dialog>

      <dialog id="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-message">
        <article>
          <header><h3 id="confirm-title">Please confirm</h3></header>
          <p id="confirm-message"></p>
          <footer>
            <button type="button" id="confirm-cancel" class="secondary outline">Cancel</button>
            <button type="button" id="confirm-accept">Confirm</button>
          </footer>
        </article>
      </dialog>
    </aside>
    <main id="map" aria-label="Map of areas"></main>
  </body>
</html>`;
}

export function createAppServer(deps: AppDeps) {
  const app = express();

  // The draw form posts urlencoded; JSON is accepted so the routes stay usable
  // from curl and scripts.
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      deps.logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
      deps.metrics.recordRequest(req.method, req.path, res.statusCode, duration);
    });
    next();
  });

  // MapLibre resolves its shared chunk and web worker relative to its own module
  // URL, so the whole dist directory has to be reachable, not just the entry file.
  for (const [route, entry] of Object.entries(VENDOR_PACKAGES)) {
    app.use(`/vendor/${route}`, express.static(dirname(Bun.resolveSync(entry, import.meta.dir))));
  }
  app.use('/static', express.static(new URL('../../../public', import.meta.url).pathname));

  app.get('/_metrics', async (_req, res) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(await deps.metrics.getMetricsText());
  });

  app.get('/_health', async (_req, res) => {
    try {
      await deps.areaRepo.healthCheck();
      res.status(200).json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'error' });
    }
  });

  app.get('/', (req, res) => {
    // An over-long `?user=` is ignored rather than rejected: the page still
    // loads, and the user is picked as if none had been named.
    const user = parseUserId(req.query.user);
    res.type('html').send(renderPage(user.kind === 'valid' ? user.userId : undefined));
  });

  app.get('/fragments/areas', async (req, res) => {
    const user = parseUserId(req.query.userId);
    if (user.kind === 'missing') {
      res.type('html').send(renderAreasPrompt());
      return;
    }
    if (user.kind === 'invalid') {
      res.status(422).type('html').send(renderUserError());
      return;
    }
    await sendAreasFragment(res, user.userId);
  });

  app.get('/fragments/area-list', async (req, res) => {
    const user = parseUserId(req.query.userId);
    if (user.kind === 'missing') {
      res.type('html').send('<p class="legend-empty">Select a user above to see their areas.</p>');
      return;
    }
    if (user.kind === 'invalid') {
      res.status(422).type('html').send(renderUserError());
      return;
    }
    try {
      const areas = await deps.areaRepo.listAreas(user.userId);
      res.type('html').send(renderAreaListFragment(user.userId, buildAreaListView(areas)));
    } catch (error) {
      deps.logger.error('Failed to load the area list', error);
      res.status(503).type('html').send(renderAreasError());
    }
  });

  app.get('/fragments/events', async (req, res) => {
    const user = parseUserId(req.query.userId);
    if (user.kind === 'missing') {
      res.type('html').send(renderEventsPrompt());
      return;
    }
    if (user.kind === 'invalid') {
      res.status(422).type('html').send(renderUserError());
      return;
    }

    const { userId } = user;
    try {
      const events = await deps.areaEvents.listAreaEvents(userId, { limit: EVENT_LIST_LIMIT });
      const timeZone = typeof req.query.tz === 'string' ? req.query.tz : undefined;
      res.type('html').send(renderEventsFragment(buildAreaEventView(userId, events, { timeZone })));
    } catch (error) {
      deps.logger.error('Failed to load events', error);
      res.status(503).type('html').send(renderEventsError());
    }
  });

  app.get('/users', async (_req, res) => {
    try {
      res.json(await deps.users.listUserIds());
    } catch (error) {
      deps.logger.error('Failed to load users', error);
      res.status(503).json({ error: 'Could not load users. Retrying…' });
    }
  });

  app.post('/users/recompute', async (req, res) => {
    const user = parseUserId(req.body?.userId);
    if (user.kind !== 'valid') {
      res.status(422).send('Select a user above.');
      return;
    }
    const { userId } = user;
    try {
      if (!deps.recompute) throw new Error('Recompute is unavailable');
      const result = await deps.recompute(userId);
      res
        .type('html')
        .send(
          `Processed ${result.locations} locations. Events: ${result.before} before, ${result.after} after.`,
        );
    } catch (error) {
      deps.logger.error('Recompute failed', error);
      res.status(503).send('Could not recompute events. Please retry.');
    }
  });

  app.get('/fragments/places', async (req, res) => {
    const user = parseUserId(req.query.userId);
    if (user.kind !== 'valid') {
      res.status(422).type('html').send(renderPlacesNotice('Select a user above.'));
      return;
    }
    const { userId } = user;
    const period = typeof req.query.days === 'string' ? req.query.days : '30';
    if (!Object.hasOwn(PLACE_PERIOD_DAYS, period)) {
      res.status(422).type('html').send(renderPlacesNotice('Choose a period from the list.'));
      return;
    }

    const days = PLACE_PERIOD_DAYS[period];
    const range = days === undefined ? {} : { from: Math.floor(Date.now() / 1000) - days * 86_400 };
    try {
      if (!deps.visitedPlaces) throw new Error('Visited places are unavailable');
      const places = await deps.visitedPlaces(userId, range);
      res.type('html').send(renderPlacesFragment(buildVisitedPlaceView(userId, places)));
    } catch (error) {
      deps.logger.error('Failed to find visited places', error);
      res.status(503).type('html').send(renderPlacesNotice('Could not find places. Please retry.'));
    }
  });

  app.post('/areas', async (req, res) => {
    const result = CreateAreaSchema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      if (req.get('accept') === 'application/json') {
        res.status(422).json({ error: message });
        return;
      }
      const user = parseUserId(req.body?.userId);
      if (user.kind === 'valid') {
        await sendAreasFragment(res, user.userId, { status: 422, formError: message });
      } else {
        res
          .status(422)
          .type('html')
          .send(renderAreasPrompt() + renderFormErrorOob(message));
      }
      return;
    }

    const id = randomUUID();
    try {
      // The server owns the ID so a client cannot overwrite an existing area by
      // posting a known one.
      await deps.areaRepo.addArea({ id, ...result.data });
    } catch (error) {
      deps.logger.error('Failed to create area', error);
      res.status(503).type('html').send(renderAreasError());
      return;
    }

    if (req.get('accept') === 'application/json') {
      res.status(201).json({ id });
      return;
    }

    // Respond with the refreshed areas so the sidebar and map update together.
    await sendAreasFragment(res, result.data.userId);
  });

  app.delete('/areas/:userId/:areaId', async (req, res) => {
    try {
      await deps.areaRepo.removeArea(req.params.userId, req.params.areaId);
    } catch (error) {
      deps.logger.error('Failed to delete area', error);
      res.status(503).type('html').send(renderAreasError());
      return;
    }

    await sendAreasFragment(res, req.params.userId);
  });

  /** The areas panel for one user: their area names plus the circles for the map. */
  async function sendAreasFragment(
    res: express.Response,
    userId: string,
    options: { status?: number; formError?: string } = {},
  ): Promise<void> {
    try {
      const areas = await deps.areaRepo.listAreas(userId);
      res
        .status(options.status ?? 200)
        .type('html')
        .send(renderAreasFragment(userId, areas) + renderFormErrorOob(options.formError ?? ''));
    } catch (error) {
      // The page polls this endpoint, so an outage would otherwise leave a blank
      // sidebar with the reason buried in the server log. Degrade to a visible
      // message and let the next poll recover on its own.
      deps.logger.error('Failed to load areas', error);
      res.status(503).type('html').send(renderAreasError());
    }
  }

  return app;
}
