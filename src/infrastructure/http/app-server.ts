import express from 'express';
import escapeHtml from 'escape-html';
import { dirname } from 'node:path';
import { buildAreaMapView, type AreaMapView } from '@/application/build-area-map-view.ts';
import type { AreaRepository, Logger, MetricsCollector } from '@/domain/ports.ts';

/**
 * The map UI reads areas out of Redis and nothing else, so it deliberately does
 * not reuse the ingestion app's `Deps` (location repository, decryptor, geofence
 * evaluator, event publisher).
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

function renderPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!--
      htmx does not swap 4xx/5xx responses by default, which would hide the
      areas-unavailable message. Opt 503 in specifically; the rest of the
      defaults are repeated verbatim because this replaces the whole array.
    -->
    <meta
      name="htmx-config"
      content='{"responseHandling":[{"code":"204","swap":false},{"code":"503","swap":true},{"code":"[23]..","swap":true},{"code":"[45]..","swap":false,"error":true}]}'
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
    </aside>
    <div id="map"></div>
  </body>
</html>`;
}

export function createAppServer(deps: AppDeps) {
  const app = express();

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
    try {
      const areas = await deps.areaRepo.listAllAreas();
      res.type('html').send(renderAreasFragment(buildAreaMapView(areas)));
    } catch (error) {
      // The page polls this endpoint, so a Redis outage would otherwise leave a
      // blank sidebar with the reason buried in the server log. Degrade to a
      // visible message and let the next poll recover on its own.
      deps.logger.error('Failed to load areas', error);
      res.status(503).type('html').send(renderAreasError());
    }
  });

  return app;
}
