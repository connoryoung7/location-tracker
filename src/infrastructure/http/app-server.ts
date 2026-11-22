import express from 'express';
import escapeHtml from 'escape-html';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildAreaEventView, type AreaEventView } from '@/application/build-area-event-view.ts';
import { buildAreaListView, type AreaListView } from '@/application/build-area-list-view.ts';
import { buildAreaMapView, type AreaMapView } from '@/application/build-area-map-view.ts';
import { CreateAreaSchema } from '@/domain/schemas.ts';
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

function renderAreasFragment(view: AreaMapView): string {
  const legendRows = view.legend
    .map(
      (row) => `
      <li class="legend-row">
        <label>
          <input type="checkbox" checked data-user-id="${escapeHtml(row.userId)}" />
          <span class="legend-swatch" style="background:${escapeHtml(row.color)}"></span>
          <span class="legend-user">${escapeHtml(row.userId)}</span>
          <span class="legend-count">${row.areaCount}</span>
        </label>
      </li>`,
    )
    .join('');

  const emptyState =
    view.legend.length === 0
      ? '<p class="legend-empty">No areas defined yet. Use <strong>Add area</strong> to draw one.</p>'
      : '';

  return `
    ${emptyState}
    <ul class="legend-list">${legendRows}</ul>
    <script type="application/json" id="areas-data">${escapeJsonForScript(view)}</script>
  `;
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

function renderAreaListFragment(view: AreaListView): string {
  if (view.rows.length === 0) {
    return '<p class="legend-empty">No areas defined yet.</p>';
  }

  const rows = view.rows
    .map(
      (row) => `
        <tr>
          <th scope="row" class="area-list-name">${escapeHtml(row.name)}</th>
          <td>
            <span class="area-list-user">
              <span class="legend-swatch" style="background:${escapeHtml(row.color)}"></span>
              ${escapeHtml(row.userId)}
            </span>
          </td>
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
        <tr><th scope="col">Name</th><th scope="col">User</th><th scope="col">Centre</th><th scope="col">Radius</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/** How many of the selected user's most recent events the panel shows. */
const EVENT_LIST_LIMIT = 100;

function renderEventsFragment(view: AreaEventView): string {
  const rows = view.rows
    .map(
      (row) => `
      <li class="event-row event-${row.kind}">
        <button type="button" class="event-locate" data-lon="${row.lon}" data-lat="${row.lat}">
          <span class="event-kind">${row.kind === 'entered' ? 'Entered' : 'Exited'}</span>
          <span class="event-area">${escapeHtml(row.areaLabel)}</span>
          <time datetime="${row.isoTime}">${row.isoTime}</time>
        </button>
      </li>`,
    )
    .join('');

  const emptyState =
    view.rows.length === 0 ? '<p class="events-empty">No events for this user yet.</p>' : '';

  return `
    ${emptyState}
    <ol class="event-list">${rows}</ol>
    <script type="application/json" id="events-data">${escapeJsonForScript(view)}</script>
  `;
}

/**
 * Shown before a user is chosen. Carries an empty `events-data` block so the map
 * drops the previous user's points instead of leaving them behind.
 */
function renderEventsPrompt(): string {
  return `
    <p class="events-empty">Select a user to see their events.</p>
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

/**
 * Out-of-band element carrying the draw form's error text. Sent alongside the
 * legend so a rejected area reports itself without blanking the sidebar; empty
 * on success, which also clears a previous error.
 */
function renderFormErrorOob(message: string): string {
  return `<p id="form-error" hx-swap-oob="true" class="notice" data-tone="error" role="status">${escapeHtml(message)}</p>`;
}

function renderPage(): string {
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
      </header>

      <section class="panel" aria-labelledby="areas-heading">
        <div class="panel-header">
          <h2 id="areas-heading">Areas</h2>
          <button type="button" id="area-list-open" class="secondary outline">List areas</button>
        </div>
        <div
          id="areas"
          hx-get="/fragments/areas"
          hx-trigger="load, refresh, every ${REFRESH_INTERVAL}"
          hx-swap="innerHTML"
        ></div>
      </section>

      <!--
        The draw panel sits outside #areas on purpose: the poll replaces that
        element every ${REFRESH_INTERVAL}, which would discard half-typed input.
      -->
      <section class="panel" id="draw-panel" aria-labelledby="draw-heading">
        <h2 id="draw-heading">New area</h2>
        <button type="button" id="draw-start" class="block">Add area</button>
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
            <label>User <select name="userId" required data-user-select disabled><option value="">Loading users…</option></select></label>
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
        <form id="events-filter">
          <label>User <select name="userId" data-user-select disabled><option value="">Loading users…</option></select></label>
        </form>
        <!-- Refreshed when the user changes, after a recompute, and on the same poll as the areas. -->
        <div
          id="events"
          hx-get="/fragments/events"
          hx-include="#events-filter"
          hx-trigger="load, change from:#events-filter, refresh, every ${REFRESH_INTERVAL}"
          hx-swap="innerHTML"
        ></div>
      </section>

      <section class="panel" aria-labelledby="recompute-heading">
        <h2 id="recompute-heading">Event history</h2>
        <p class="panel-hint">Rebuild a user's entry and exit events from their stored locations and the current areas.</p>
        <form id="recompute-form" class="recompute-form" hx-post="/users/recompute" hx-target="#recompute-result" hx-confirm="Replace this user's event history using current areas?" hx-disabled-elt="find button">
          <label>User <select name="userId" required data-user-select disabled><option value="">Loading users…</option></select></label>
          <button type="submit" class="secondary" data-user-submit disabled>Recompute events</button>
          <span class="htmx-indicator" aria-busy="true">Recomputing…</span>
        </form>
        <p id="user-status" class="notice" data-tone="info" role="status"></p>
        <p id="recompute-result" class="notice" data-tone="info" role="status"></p>
      </section>

      <!-- Loaded each time it opens, so it never shows a stale copy of the poll. -->
      <dialog id="area-list-dialog" aria-labelledby="area-list-title">
        <article>
          <header>
            <button type="button" id="area-list-close" aria-label="Close" rel="prev"></button>
            <h3 id="area-list-title">All areas</h3>
          </header>
          <div id="area-list" hx-get="/fragments/area-list" hx-trigger="refresh" hx-swap="innerHTML"></div>
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

  app.get('/', (_req, res) => {
    res.type('html').send(renderPage());
  });

  app.get('/fragments/areas', async (_req, res) => {
    await sendAreasFragment(res);
  });

  app.get('/fragments/area-list', async (_req, res) => {
    try {
      const areas = await deps.areaRepo.listAllAreas();
      res.type('html').send(renderAreaListFragment(buildAreaListView(areas)));
    } catch (error) {
      deps.logger.error('Failed to load the area list', error);
      res.status(503).type('html').send(renderAreasError());
    }
  });

  app.get('/fragments/events', async (req, res) => {
    const userId = req.query.userId;
    if (typeof userId !== 'string' || !userId.trim()) {
      res.type('html').send(renderEventsPrompt());
      return;
    }
    if (userId.length > 64) {
      res
        .status(422)
        .type('html')
        .send('<p class="notice legend-error" data-tone="error" role="alert">Unknown user.</p>');
      return;
    }

    try {
      const events = await deps.areaEvents.listAreaEvents(userId, { limit: EVENT_LIST_LIMIT });
      res.type('html').send(renderEventsFragment(buildAreaEventView(userId, events)));
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
    const userId = req.body?.userId;
    if (typeof userId !== 'string' || !userId.trim() || userId.length > 64) {
      res.status(422).send('Enter a user ID.');
      return;
    }
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
      await sendAreasFragment(res, { status: 422, formError: message });
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

    // Respond with the refreshed legend so the sidebar and map update together.
    await sendAreasFragment(res);
  });

  app.delete('/areas/:userId/:areaId', async (req, res) => {
    try {
      await deps.areaRepo.removeArea(req.params.userId, req.params.areaId);
    } catch (error) {
      deps.logger.error('Failed to delete area', error);
      res.status(503).type('html').send(renderAreasError());
      return;
    }

    await sendAreasFragment(res);
  });

  async function sendAreasFragment(
    res: express.Response,
    options: { status?: number; formError?: string } = {},
  ): Promise<void> {
    try {
      const areas = await deps.areaRepo.listAllAreas();
      res
        .status(options.status ?? 200)
        .type('html')
        .send(
          renderAreasFragment(buildAreaMapView(areas)) +
            renderFormErrorOob(options.formError ?? ''),
        );
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
