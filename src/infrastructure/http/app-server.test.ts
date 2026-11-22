import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { createAppServer, type AppDeps } from '@/infrastructure/http/app-server.ts';
import { ConsoleLogger } from '@/infrastructure/logging/console.logger.ts';
import { PrometheusMetricsCollector } from '@/infrastructure/metrics/prometheus.metrics.ts';
import { mockAreaEventRepository, mockAreaRepository } from '@/test/mocks.ts';
import { buildArea } from '@/test/factories.ts';
import type { Server } from 'node:http';
import type { GeofenceEvent } from '@/domain/events.ts';
import type { VisitedPlace } from '@/application/infer-visited-places.ts';

const TEST_PORT = 0; // let OS pick an available port

let server: Server;
let baseUrl: string;
let areaRepo: ReturnType<typeof mockAreaRepository>;
let areaEvents: ReturnType<typeof mockAreaEventRepository>;
const visitedPlaces = mock(
  async (_userId: string, _range: { from?: number }): Promise<VisitedPlace[]> => [],
);

beforeAll(async () => {
  areaRepo = mockAreaRepository();
  areaEvents = mockAreaEventRepository();

  const deps: AppDeps = {
    areaRepo,
    areaEvents,
    users: { listUserIds: async () => ['AB', 'CD'] },
    recompute: async () => ({ locations: 10, before: 2, after: 4 }),
    visitedPlaces,
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
  areaEvents.listAreaEvents.mockReset();
  areaEvents.listAreaEvents.mockImplementation(() => Promise.resolve([]));
  visitedPlaces.mockReset();
  visitedPlaces.mockImplementation(async () => []);
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

describe('GET /fragments/area-list', () => {
  test('the page has a list button and a dialog that loads the list', async () => {
    const html = await fetch(`${baseUrl}/`).then((res) => res.text());

    expect(html).toContain('id="area-list-open"');
    expect(html).toContain('<dialog id="area-list-dialog"');
    expect(html).toContain('hx-get="/fragments/area-list"');
  });

  test('lists every area with its user, centre, radius, and actions', async () => {
    areaRepo.listAllAreas.mockImplementationOnce(() =>
      Promise.resolve([
        buildArea({ id: 'w', userId: 'CD', name: 'Work', radius: 80.4 }),
        buildArea({ id: 'h', userId: 'AB', name: 'Home', lat: 42.3601, lon: -71.0589 }),
      ]),
    );

    const res = await fetch(`${baseUrl}/fragments/area-list`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('2 areas');
    expect(html.indexOf('Home')).toBeLessThan(html.indexOf('Work'));
    expect(html).toContain('42.36010, -71.05890');
    expect(html).toContain('80 m');
    expect(html).toContain('hx-delete="/areas/AB/h"');
    // The owner lets Show reveal a user hidden in the legend before zooming.
    expect(html).toMatch(/class="area-list-show[^"]*" data-owner-id="AB" data-bounds="\[/);
  });

  test('escapes area names and user IDs', async () => {
    areaRepo.listAllAreas.mockImplementationOnce(() =>
      Promise.resolve([buildArea({ name: '<img src=x onerror=alert(1)>', userId: '"><b>' })]),
    );

    const html = await fetch(`${baseUrl}/fragments/area-list`).then((res) => res.text());

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('hx-delete="/areas/%22%3E%3Cb%3E/area-1"');
  });

  test('says so when there are no areas', async () => {
    const html = await fetch(`${baseUrl}/fragments/area-list`).then((res) => res.text());

    expect(html).toContain('No areas defined yet.');
  });

  test('shows a retry message when the store fails', async () => {
    areaRepo.listAllAreas.mockRejectedValueOnce(new Error('down'));

    const res = await fetch(`${baseUrl}/fragments/area-list`);

    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Could not reach the area store');
  });
});

describe('GET /fragments/events', () => {
  const entered: GeofenceEvent = {
    _type: 'area.entered',
    userId: 'AB',
    areaId: 'home-id',
    areaName: 'Home',
    lat: 42.36,
    lon: -71.06,
    tst: 1_700_000_000,
  };

  const readEventsData = (html: string) =>
    JSON.parse(
      html.match(/<script type="application\/json" id="events-data">(.*?)<\/script>/s)![1]!,
    );

  test('the page polls the events fragment with the selected user', async () => {
    const html = await fetch(`${baseUrl}/`).then((res) => res.text());

    expect(html).toContain('hx-get="/fragments/events"');
    expect(html).toContain('hx-include="#events-filter"');
  });

  test("lists the selected user's events and embeds them for the map", async () => {
    areaEvents.listAreaEvents.mockImplementation(() =>
      Promise.resolve([{ ...entered, _type: 'area.exited', tst: 1_700_000_600 }, entered]),
    );

    const res = await fetch(`${baseUrl}/fragments/events?userId=AB`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(areaEvents.listAreaEvents).toHaveBeenCalledWith('AB', { limit: 100 });
    expect(html).toContain('Exited');
    expect(html).toContain('Entered');
    expect(html).toContain('<time datetime="2023-11-14T22:13:20.000Z">');
    const view = readEventsData(html);
    expect(view.userId).toBe('AB');
    expect(view.featureCollection.features).toHaveLength(2);
  });

  test('the events filter sends a time zone field with the user', async () => {
    const html = await fetch(`${baseUrl}/`).then((res) => res.text());
    const filter = html.slice(html.indexOf('<form id="events-filter">'));

    expect(filter.slice(0, filter.indexOf('</form>'))).toContain('name="tz"');
  });

  test("groups events under headings for the viewer's days", async () => {
    // 03:00 UTC on Nov 15, 2023 is still the evening of Nov 14 in New York.
    const lateEvening = Date.parse('2023-11-15T03:00:00Z') / 1000;
    areaEvents.listAreaEvents.mockImplementation(() =>
      Promise.resolve([{ ...entered, tst: lateEvening }, entered]),
    );

    const newYork = await fetch(
      `${baseUrl}/fragments/events?userId=AB&tz=${encodeURIComponent('America/New_York')}`,
    ).then((res) => res.text());
    const utc = await fetch(`${baseUrl}/fragments/events?userId=AB&tz=UTC`).then((res) =>
      res.text(),
    );

    expect(newYork.match(/class="event-day"/g)).toHaveLength(1);
    expect(newYork).toContain('<time datetime="2023-11-14">Tue, Nov 14, 2023</time>');
    expect(newYork).toContain('2 events');
    expect(newYork).toContain('>10:00 PM</time>');
    expect(readEventsData(newYork).timeZone).toBe('America/New_York');

    expect(utc.match(/class="event-day"/g)).toHaveLength(2);
    expect(utc).toContain('<time datetime="2023-11-15">');
    expect(utc).toContain('1 event<');
  });

  test('falls back to UTC days for an unknown time zone', async () => {
    areaEvents.listAreaEvents.mockImplementation(() => Promise.resolve([entered]));

    const html = await fetch(`${baseUrl}/fragments/events?userId=AB&tz=Not%2FAZone`).then((res) =>
      res.text(),
    );

    expect(html).toContain('<time datetime="2023-11-14">');
    expect(readEventsData(html).timeZone).toBe('UTC');
  });

  test('escapes area names in the list and the embedded JSON', async () => {
    areaEvents.listAreaEvents.mockImplementation(() =>
      Promise.resolve([{ ...entered, areaName: '</script><img src=x onerror=alert(1)>' }]),
    );

    const html = await fetch(`${baseUrl}/fragments/events?userId=AB`).then((res) => res.text());

    expect(html).not.toContain('<img');
    expect(readEventsData(html).rows[0].areaLabel).toBe('</script><img src=x onerror=alert(1)>');
  });

  test('prompts for a user and clears the map when none is selected', async () => {
    const html = await fetch(`${baseUrl}/fragments/events?userId=`).then((res) => res.text());

    expect(html).toContain('Select a user');
    expect(readEventsData(html)).toBeNull();
    expect(areaEvents.listAreaEvents).not.toHaveBeenCalled();
  });

  test('shows a retry message without map data when the store fails', async () => {
    areaEvents.listAreaEvents.mockImplementation(() => Promise.reject(new Error('down')));

    const res = await fetch(`${baseUrl}/fragments/events?userId=AB`);
    const html = await res.text();

    expect(res.status).toBe(503);
    expect(html).toContain('Could not load events');
    expect(html).not.toContain('events-data');
  });
});

describe('GET /fragments/places', () => {
  const grocery: VisitedPlace = {
    lat: 42.37,
    lon: -71.04,
    visits: [
      {
        lat: 42.37,
        lon: -71.04,
        arrivedAt: 1_700_000_000,
        departedAt: 1_700_001_800,
        locationCount: 30,
      },
      {
        lat: 42.37,
        lon: -71.04,
        arrivedAt: 1_700_100_000,
        departedAt: 1_700_101_200,
        locationCount: 20,
      },
    ],
    totalSeconds: 3_000,
    candidates: [
      {
        id: 'node/1',
        name: 'Fresh Market',
        category: 'Grocery store',
        lat: 42.37,
        lon: -71.04,
        distanceMeters: 6,
      },
      {
        id: 'node/2',
        name: 'Corner Café',
        category: 'Café',
        lat: 42.37,
        lon: -71.04,
        distanceMeters: 48.6,
      },
    ],
    lookup: 'found',
  };

  const readPlacesData = (html: string) =>
    JSON.parse(
      html.match(/<script type="application\/json" id="places-data">(.*?)<\/script>/s)![1]!,
    );

  test('the page has a places form that loads the fragment on request', async () => {
    const html = await fetch(`${baseUrl}/`).then((res) => res.text());

    expect(html).toContain('id="places-form"');
    expect(html).toContain('hx-get="/fragments/places"');
    expect(html).toContain('<option value="30" selected>Last 30 days</option>');
  });

  test('lists places with what they probably are and embeds them for the map', async () => {
    visitedPlaces.mockImplementation(async () => [grocery]);

    const res = await fetch(`${baseUrl}/fragments/places?userId=AB&days=all`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(visitedPlaces).toHaveBeenCalledWith('AB', {});
    expect(html).toContain('Fresh Market');
    expect(html).toContain('2 visits');
    expect(html).toContain('Grocery store · 50 min');
    expect(html).toContain('Corner Café <span>Café · 49 m</span>');
    expect(html).toContain('Grocery store <strong>2</strong>');
    expect(html).toContain('<time datetime="2023-11-16T02:20:00.000Z">');
    expect(html).toContain('openstreetmap.org/copyright');
    const view = readPlacesData(html);
    expect(view.userId).toBe('AB');
    expect(view.featureCollection.features).toHaveLength(1);
  });

  test('reads only the chosen period, defaulting to 30 days', async () => {
    const now = Math.floor(Date.now() / 1000);

    await fetch(`${baseUrl}/fragments/places?userId=AB&days=7`);
    await fetch(`${baseUrl}/fragments/places?userId=AB`);

    const [week, month] = visitedPlaces.mock.calls.map(([, range]) => range as { from: number });
    expect(week!.from).toBeGreaterThanOrEqual(now - 7 * 86_400);
    expect(week!.from).toBeLessThanOrEqual(now - 7 * 86_400 + 5);
    expect(month!.from).toBeGreaterThanOrEqual(now - 30 * 86_400);
    expect(month!.from).toBeLessThanOrEqual(now - 30 * 86_400 + 5);
  });

  test('rejects a missing user or an unknown period', async () => {
    const noUser = await fetch(`${baseUrl}/fragments/places?userId=`);
    const badPeriod = await fetch(`${baseUrl}/fragments/places?userId=AB&days=toString`);

    expect(noUser.status).toBe(422);
    expect(await noUser.text()).toContain('Select a user');
    expect(badPeriod.status).toBe(422);
    expect(visitedPlaces).not.toHaveBeenCalled();
  });

  test('escapes place names in the list and the embedded JSON', async () => {
    const hostile = '</script><img src=x onerror=alert(1)>';
    visitedPlaces.mockImplementation(async () => [
      { ...grocery, candidates: [{ ...grocery.candidates[0]!, name: hostile, category: hostile }] },
    ]);

    const html = await fetch(`${baseUrl}/fragments/places?userId=AB`).then((res) => res.text());

    expect(html).not.toContain('<img');
    expect(readPlacesData(html).rows[0].label).toBe(hostile);
  });

  test('says so when the user made no stops', async () => {
    const html = await fetch(`${baseUrl}/fragments/places?userId=AB`).then((res) => res.text());

    expect(html).toContain('No stops of 5 minutes or more');
    expect(readPlacesData(html).rows).toEqual([]);
  });

  test('shows a retry message without map data when inference fails', async () => {
    visitedPlaces.mockImplementation(async () => {
      throw new Error('db down');
    });

    const res = await fetch(`${baseUrl}/fragments/places?userId=AB`);
    const html = await res.text();

    expect(res.status).toBe(503);
    expect(html).toContain('Could not find places');
    expect(html).not.toContain('places-data');
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

test('recompute form confirms and endpoint returns a result summary', async () => {
  const page = await (await fetch(baseUrl)).text();
  expect(page).toContain('hx-confirm=');
  expect(page).toContain('Recomputing…');
  const response = await fetch(`${baseUrl}/users/recompute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'u' }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('10 locations. Events: 2 before, 4 after.');
});

test('user options come from the tracked-user repository', async () => {
  expect(await (await fetch(`${baseUrl}/users`)).json()).toEqual(['AB', 'CD']);
});

test('JSON confirmation returns success after saving without depending on a legend refresh', async () => {
  const response = await fetch(`${baseUrl}/areas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ userId: 'AB', name: 'Home', lat: 0, lon: 0, radius: 100 }),
  });
  expect(response.status).toBe(201);
  expect(((await response.json()) as { id: string }).id).toBe(
    areaRepo.addArea.mock.calls[0]![0].id,
  );
  expect(areaRepo.listAllAreas).not.toHaveBeenCalled();
});

test('JSON confirmation rejects blank coordinates without persisting', async () => {
  const response = await fetch(`${baseUrl}/areas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ userId: 'AB', name: 'Home', lat: '', lon: 0, radius: 100 }),
  });
  expect(response.status).toBe(422);
  expect(((await response.json()) as { error: string }).error).toContain('lat');
  expect(areaRepo.addArea).not.toHaveBeenCalled();
});
