import express from 'express';
import escapeHtml from 'escape-html';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildAreaMapView, type AreaMapView } from '@/application/build-area-map-view.ts';
import { CreateAreaSchema } from '@/domain/schemas.ts';
import type { AreaRepository, Logger, MetricsCollector } from '@/domain/ports.ts';

/**
 * The map UI only reads and writes areas, so it deliberately does not reuse the
 * ingestion app's `Deps` (location repository, decryptor, geofence evaluator,
 * event publisher).
 */
export interface AppDeps {
  areaRepo: AreaRepository;
  logger: Logger;
  metrics: MetricsCollector;
}

/** How often the browser re-fetches the areas fragment. */
const REFRESH_INTERVAL = '30s';

const VENDOR_PACKAGES = {
  maplibre: 'maplibre-gl/dist/maplibre-gl.mjs',
  htmx: 'htmx.org/dist/htmx.min.js',
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
    view.legend.length === 0 ? '<p class="legend-empty">No areas defined yet.</p>' : '';

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
  return `<p class="legend-error">Could not reach the area store. Retrying…</p>`;
}

/**
 * Out-of-band element carrying the draw form's error text. Sent alongside the
 * legend so a rejected area reports itself without blanking the sidebar; empty
 * on success, which also clears a previous error.
 */
function renderFormErrorOob(message: string): string {
  return `<p id="form-error" hx-swap-oob="true" class="form-error">${escapeHtml(message)}</p>`;
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
    <link rel="stylesheet" href="/vendor/maplibre/maplibre-gl.css" />
    <link rel="stylesheet" href="/static/app.css" />
    <script src="/vendor/htmx/htmx.min.js" defer></script>
    <script type="module" src="/static/app.js"></script>
  </head>
  <body>
    <aside id="legend">
      <h1>Areas</h1>
      <div
        id="areas"
        hx-get="/fragments/areas"
        hx-trigger="load, every ${REFRESH_INTERVAL}"
        hx-swap="innerHTML"
      ></div>

      <!--
        The draw panel sits outside #areas on purpose: the poll replaces that
        element every ${REFRESH_INTERVAL}, which would discard half-typed input.
      -->
      <section id="draw-panel">
        <button type="button" id="draw-start">Add area</button>
        <form id="draw-form" hidden hx-post="/areas" hx-target="#areas" hx-swap="innerHTML">
          <p class="draw-hint">Click the map to place the centre, then drag to size it.</p>
          <label>Name <input type="text" name="name" required maxlength="200" /></label>
          <label>User <input type="text" name="userId" required maxlength="64" /></label>
          <p class="draw-readout" id="draw-readout">No centre set</p>
          <input type="hidden" name="lat" />
          <input type="hidden" name="lon" />
          <input type="hidden" name="radius" />
          <div class="draw-actions">
            <button type="submit">Save</button>
            <button type="button" id="draw-cancel">Cancel</button>
          </div>
        </form>
        <p id="form-error" class="form-error"></p>
      </section>
    </aside>
    <div id="map"></div>
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

  app.post('/areas', async (req, res) => {
    const result = CreateAreaSchema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      await sendAreasFragment(res, { status: 422, formError: message });
      return;
    }

    try {
      // The server owns the ID so a client cannot overwrite an existing area by
      // posting a known one.
      await deps.areaRepo.addArea({ id: randomUUID(), ...result.data });
    } catch (error) {
      deps.logger.error('Failed to create area', error);
      res.status(503).type('html').send(renderAreasError());
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
