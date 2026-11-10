import { test, expect, describe, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createAppServer, type AppDeps } from '@/infrastructure/http/app-server.ts';
import { ConsoleLogger } from '@/infrastructure/logging/console.logger.ts';
import { PrometheusMetricsCollector } from '@/infrastructure/metrics/prometheus.metrics.ts';
import { mockAreaRepository } from '@/test/mocks.ts';
import { buildArea } from '@/test/factories.ts';
import type { Server } from 'node:http';

const TEST_PORT = 0; // let OS pick an available port

let server: Server;
let baseUrl: string;
let areaRepo: ReturnType<typeof mockAreaRepository>;

beforeAll(async () => {
  areaRepo = mockAreaRepository();

  const deps: AppDeps = {
    areaRepo,
    logger: new ConsoleLogger(),
    metrics: new PrometheusMetricsCollector(),
  };

  const app = createAppServer(deps);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(TEST_PORT, '127.0.0.1', () => {
      resolve();
    });
    server.once('error', reject);
  });

  const addr = server.address();
  if (typeof addr === 'object' && addr?.port) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
    return;
  }

  throw new Error(`Failed to determine test server address: ${String(addr)}`);
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  areaRepo.listAllAreas.mockClear();
  areaRepo.healthCheck.mockClear();
  areaRepo.addArea.mockClear();
  areaRepo.removeArea.mockClear();
});

describe('GET /', () => {
  test('serves the map shell with the HTMX trigger', async () => {
    const res = await fetch(`${baseUrl}/`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('id="map"');
    expect(html).toContain('hx-get="/fragments/areas"');
    expect(html).toContain('/vendor/maplibre/maplibre-gl.css');
  });

  test('puts the draw form outside the polled region so input is not discarded', async () => {
    const html = await fetch(`${baseUrl}/`).then((res) => res.text());

    // The poll replaces #areas every 30s; a form inside it would lose
    // half-typed input, so the panel must be a sibling.
    const areasStart = html.indexOf('id="areas"');
    const polledRegion = html.slice(areasStart, html.indexOf('</div>', areasStart));

    expect(html).toContain('id="draw-form"');
    expect(polledRegion).not.toContain('id="draw-form"');
  });
});

describe('POST /areas', () => {
  const formBody = (fields: Record<string, string>) =>
    ({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }) satisfies RequestInit;

  test('creates an area from the draw form and returns the refreshed legend', async () => {
    const res = await fetch(
      `${baseUrl}/areas`,
      formBody({ userId: 'AB', name: 'Home', lat: '42.3601', lon: '-71.0589', radius: '250' }),
    );

    expect(res.status).toBe(200);
    expect(areaRepo.addArea).toHaveBeenCalledTimes(1);
    expect(areaRepo.addArea.mock.calls[0]![0]).toMatchObject({
      userId: 'AB',
      name: 'Home',
      lat: 42.3601,
      lon: -71.0589,
      radius: 250,
    });
    // The response re-renders the legend so the sidebar and map stay in step.
    expect(await res.text()).toContain('areas-data');
  });

  test('assigns the id itself so a client cannot target an existing area', async () => {
    await fetch(
      `${baseUrl}/areas`,
      formBody({
        id: 'attacker-chosen',
        userId: 'AB',
        name: 'Home',
        lat: '42.36',
        lon: '-71.06',
        radius: '100',
      }),
    );

    const created = areaRepo.addArea.mock.calls[0]![0] as { id: string };
    expect(created.id).not.toBe('attacker-chosen');
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  test('rejects an out-of-range coordinate without clearing the legend', async () => {
    const res = await fetch(
      `${baseUrl}/areas`,
      formBody({ userId: 'AB', name: 'Home', lat: '999', lon: '-71.06', radius: '100' }),
    );

    expect(res.status).toBe(422);
    expect(areaRepo.addArea).not.toHaveBeenCalled();

    const html = await res.text();
    // Error arrives out-of-band alongside the legend, so the sidebar survives.
    expect(html).toContain('id="form-error"');
    expect(html).toContain('hx-swap-oob');
    expect(html).toContain('areas-data');
  });

  test('rejects a zero radius', async () => {
    const res = await fetch(
      `${baseUrl}/areas`,
      formBody({ userId: 'AB', name: 'Home', lat: '42.36', lon: '-71.06', radius: '0' }),
    );

    expect(res.status).toBe(422);
    expect(areaRepo.addArea).not.toHaveBeenCalled();
  });

  test('accepts JSON as well as form posts', async () => {
    const res = await fetch(`${baseUrl}/areas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'CD', name: 'Work', lat: 42.37, lon: -71.1, radius: 400 }),
    });

    expect(res.status).toBe(200);
    expect(areaRepo.addArea).toHaveBeenCalledTimes(1);
  });

  test('reports a store failure without pretending the area was saved', async () => {
    areaRepo.addArea.mockRejectedValueOnce(new Error('db down'));

    const res = await fetch(
      `${baseUrl}/areas`,
      formBody({ userId: 'AB', name: 'Home', lat: '42.36', lon: '-71.06', radius: '100' }),
    );

    expect(res.status).toBe(503);
  });
});

describe('DELETE /areas/:userId/:areaId', () => {
  test('removes the area and returns the refreshed legend', async () => {
    const res = await fetch(`${baseUrl}/areas/AB/a1`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(areaRepo.removeArea).toHaveBeenCalledWith('AB', 'a1');
    expect(await res.text()).toContain('areas-data');
  });

  test('reports a store failure', async () => {
    areaRepo.removeArea.mockRejectedValueOnce(new Error('db down'));

    const res = await fetch(`${baseUrl}/areas/AB/a1`, { method: 'DELETE' });

    expect(res.status).toBe(503);
  });
});

describe('GET /fragments/areas', () => {
  test('renders a legend row per user and embeds the GeoJSON', async () => {
    areaRepo.listAllAreas.mockResolvedValueOnce([
      buildArea({ id: 'a1', userId: 'AB', name: 'Home' }),
      buildArea({ id: 'a2', userId: 'AB', name: 'Gym' }),
      buildArea({ id: 'b1', userId: 'CD', name: 'Work' }),
    ]);

    const res = await fetch(`${baseUrl}/fragments/areas`);
    expect(res.status).toBe(200);
    expect(areaRepo.listAllAreas).toHaveBeenCalledTimes(1);

    const html = await res.text();
    expect(html).toContain('data-user-id="AB"');
    expect(html).toContain('data-user-id="CD"');

    const json = html.match(/id="areas-data">(.*?)<\/script>/s)?.[1];
    const view = JSON.parse(json!);
    expect(view.featureCollection.features).toHaveLength(3);
    expect(view.legend).toHaveLength(2);
  });

  test('shows an empty state when no areas are defined', async () => {
    const res = await fetch(`${baseUrl}/fragments/areas`);

    expect(await res.text()).toContain('No areas defined yet.');
  });

  test('degrades to a visible message when the area store is unreachable', async () => {
    areaRepo.listAllAreas.mockRejectedValueOnce(new Error('Connection has failed'));

    const res = await fetch(`${baseUrl}/fragments/areas`);

    expect(res.status).toBe(503);

    const html = await res.text();
    expect(html).toContain('Could not reach the area store');
    // No data block, so the map keeps its last render instead of blanking out.
    expect(html).not.toContain('areas-data');
  });

  test('escapes area names and user IDs so they cannot inject markup', async () => {
    areaRepo.listAllAreas.mockResolvedValueOnce([
      buildArea({
        id: 'x1',
        userId: '<img src=x onerror=alert(1)>',
        name: '</script><script>alert(2)</script>',
      }),
    ]);

    const html = await fetch(`${baseUrl}/fragments/areas`).then((res) => res.text());

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
    // The only <script> tag may be the data block itself.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toContain('alert(2)</script>');

    const json = html.match(/id="areas-data">(.*?)<\/script>/s)?.[1];
    const view = JSON.parse(json!.replaceAll('\\u003c', '<'));
    expect(view.featureCollection.features[0].properties.name).toBe(
      '</script><script>alert(2)</script>',
    );
  });
});

describe('GET /_health', () => {
  test('returns ok when the area repository is reachable', async () => {
    const res = await fetch(`${baseUrl}/_health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('returns 503 when the area repository is unreachable', async () => {
    areaRepo.healthCheck.mockRejectedValueOnce(new Error('redis down'));

    const res = await fetch(`${baseUrl}/_health`);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'error' });
  });
});
