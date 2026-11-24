import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { createAppServer, type AppDeps } from '@/infrastructure/http/app-server.ts';
import type { DayTimeline, TimelineStop, TimelineTrip } from '@/application/build-day-timeline.ts';
import { zonedDayRange } from '@/application/zoned-day.ts';
import { ConsoleLogger } from '@/infrastructure/logging/console.logger.ts';
import { PrometheusMetricsCollector } from '@/infrastructure/metrics/prometheus.metrics.ts';
import {
  mockAreaCategoryRepository,
  mockAreaEventRepository,
  mockAreaRepository,
} from '@/test/mocks.ts';
import { buildArea } from '@/test/factories.ts';
import type { Server } from 'node:http';
import type { GeofenceEvent } from '@/domain/events.ts';
import type { VisitedPlace } from '@/application/infer-visited-places.ts';

const TEST_PORT = 0; // let OS pick an available port

let server: Server;
let baseUrl: string;
let areaRepo: ReturnType<typeof mockAreaRepository>;
let areaEvents: ReturnType<typeof mockAreaEventRepository>;
let areaCategories: ReturnType<typeof mockAreaCategoryRepository>;
const visitedPlaces = mock(
  async (_userId: string, _range: { from?: number }): Promise<VisitedPlace[]> => [],
);
const emptyDay = (userId: string, date: string, timeZone: string): DayTimeline => ({
  userId,
  date,
  timeZone,
  day: zonedDayRange(date, timeZone),
  entries: [],
});
const dayTimeline = mock(
  async (userId: string, day: { date: string; timeZone: string }): Promise<DayTimeline> =>
    emptyDay(userId, day.date, day.timeZone),
);

beforeAll(async () => {
  areaRepo = mockAreaRepository();
  areaEvents = mockAreaEventRepository();
  areaCategories = mockAreaCategoryRepository();

  const deps: AppDeps = {
    areaRepo,
    areaEvents,
    areaCategories,
    users: { listUserIds: async () => ['AB', 'CD'] },
    recompute: async () => ({ locations: 10, before: 2, after: 4 }),
    visitedPlaces,
    dayTimeline,
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
  areaRepo.listAreas.mockClear();
  areaRepo.healthCheck.mockClear();
  areaRepo.addArea.mockClear();
  areaRepo.removeArea.mockClear();
  areaRepo.getArea.mockClear();
  areaRepo.updateArea.mockClear();
  areaRepo.setAreaCategory.mockClear();
  areaCategories = Object.assign(areaCategories, mockAreaCategoryRepository());
  areaEvents.listAreaEvents.mockReset();
  areaEvents.listAreaEvents.mockImplementation(() => Promise.resolve([]));
  visitedPlaces.mockReset();
  visitedPlaces.mockImplementation(async () => []);
  dayTimeline.mockReset();
  dayTimeline.mockImplementation(async (userId, day) => emptyDay(userId, day.date, day.timeZone));
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

describe('the page-wide user', () => {
  /** The markup of one element, from its opening tag to the matching closing tag name. */
  const elementHtml = (html: string, opening: string, closingTag: string) => {
    const start = html.indexOf(opening);
    return html.slice(start, html.indexOf(`</${closingTag}>`, start));
  };

  test('the page has exactly one user select, in the header', async () => {
    const html = await fetch(`${baseUrl}/`).then((res) => res.text());

    expect(html.match(/<select[^>]*name="userId"/g)).toHaveLength(1);
    const header = elementHtml(html, '<header class="app-header">', 'header');
    expect(header).toContain('<form id="user-scope"');
    expect(header).toContain('id="user-select"');
  });

  test('every panel reads the user from the header instead of keeping its own', async () => {
    const html = await fetch(`${baseUrl}/`).then((res) => res.text());

    for (const opening of ['id="areas"', 'id="events"', 'id="area-list"']) {
      const tag = html.slice(html.indexOf(opening), html.indexOf('>', html.indexOf(opening)));
      expect(tag).toContain('hx-include="#user-scope"');
      // A request still in flight for the previous user is cancelled, not shown.
      expect(tag).toContain('hx-sync="this:replace"');
    }
    for (const opening of ['id="areas"', 'id="events"']) {
      const tag = html.slice(html.indexOf(opening), html.indexOf('>', html.indexOf(opening)));
      expect(tag).toContain('change from:#user-scope');
    }
    for (const form of ['<form id="recompute-form"', '<form id="places-form"']) {
      const markup = elementHtml(html, form, 'form');
      expect(markup).toContain('hx-include="#user-scope"');
      expect(markup).not.toContain('name="userId"');
    }
    expect(elementHtml(html, '<form id="draw-form"', 'form')).not.toContain('name="userId"');
  });

  test('without ?user= the select waits, disabled, for the user poll', async () => {
    const html = await fetch(`${baseUrl}/`).then((res) => res.text());

    expect(html).toContain(
      '<select id="user-select" name="userId" disabled><option value="">Loading users…</option></select>',
    );
  });

  test('?user= preselects the user and keeps the select enabled for the first loads', async () => {
    const html = await fetch(`${baseUrl}/?user=AB`).then((res) => res.text());

    // htmx leaves disabled fields out of requests, so it must not be disabled.
    expect(html).toContain(
      '<select id="user-select" name="userId"><option value="AB" selected>AB</option></select>',
    );
  });

  test('escapes ?user= and ignores one too long to be a user ID', async () => {
    const hostile = await fetch(
      `${baseUrl}/?user=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`,
    ).then((res) => res.text());
    const tooLong = await fetch(`${baseUrl}/?user=${'x'.repeat(65)}`).then((res) => res.text());

    expect(hostile).not.toContain('<img');
    expect(hostile).toContain('value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;" selected');
    expect(tooLong).toContain('<option value="">Loading users…</option>');
  });

  test('user actions start disabled until a user is selected', async () => {
    const html = await fetch(`${baseUrl}/`).then((res) => res.text());

    expect(html).toContain('<button type="button" id="draw-start" class="block" disabled>');
    expect(html).toMatch(/id="area-list-open"[^>]*data-user-submit disabled/);
  });
});

describe('GET /fragments/area-list', () => {
  test('the page has a list button and a dialog that loads the list', async () => {
    const html = await fetch(`${baseUrl}/`).then((res) => res.text());

    expect(html).toContain('id="area-list-open"');
    expect(html).toContain('<dialog id="area-list-dialog"');
    expect(html).toContain('hx-get="/fragments/area-list"');
  });

  test("lists only the selected user's areas, with centre, radius, and actions", async () => {
    areaRepo.listAreas.mockImplementationOnce(() =>
      Promise.resolve([
        buildArea({ id: 'w', userId: 'AB', name: 'Work', radius: 80.4 }),
        buildArea({ id: 'h', userId: 'AB', name: 'Home', lat: 42.3601, lon: -71.0589 }),
      ]),
    );

    const res = await fetch(`${baseUrl}/fragments/area-list?userId=AB`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(areaRepo.listAreas).toHaveBeenCalledWith('AB');
    expect(areaRepo.listAllAreas).not.toHaveBeenCalled();
    expect(html).toContain('2 areas');
    expect(html.indexOf('Home')).toBeLessThan(html.indexOf('Work'));
    expect(html).toContain('42.36010, -71.05890');
    expect(html).toContain('80 m');
    expect(html).toContain('hx-delete="/areas/AB/h"');
    // Every row is the same user, so the table no longer has a User column.
    expect(html).not.toContain('<th scope="col">User</th>');
    // Show only zooms: there are no hidden users left to reveal.
    expect(html).toMatch(/class="area-list-show[^"]*" data-bounds="\[/);
    // Edit carries the area so the form can open it pre-filled.
    const edit = html.match(/<button[^>]*class="area-list-edit[^>]*>/s)![0];
    expect(edit).toContain('data-user-id="AB"');
    expect(edit).toContain('data-area-id="h"');
    expect(edit).toContain('data-name="Home"');
    expect(edit).toContain('data-lat="42.3601"');
    expect(edit).toContain('data-lon="-71.0589"');
    expect(edit).toContain('data-radius="100"');
  });

  test('escapes area names and user IDs', async () => {
    areaRepo.listAreas.mockImplementationOnce(() =>
      Promise.resolve([buildArea({ name: '<img src=x onerror=alert(1)>', userId: '"><b>' })]),
    );

    const html = await fetch(
      `${baseUrl}/fragments/area-list?userId=${encodeURIComponent('"><b>')}`,
    ).then((res) => res.text());

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('hx-delete="/areas/%22%3E%3Cb%3E/area-1"');
    expect(html).toContain('data-name="&lt;img src=x onerror=alert(1)&gt;"');
    expect(html).toContain('data-user-id="&quot;&gt;&lt;b&gt;"');
  });

  test('says so when the user has no areas', async () => {
    const html = await fetch(`${baseUrl}/fragments/area-list?userId=AB`).then((res) => res.text());

    expect(html).toContain('No areas for AB yet.');
  });

  test('prompts for a user before one is selected, and rejects an over-long ID', async () => {
    const none = await fetch(`${baseUrl}/fragments/area-list?userId=`);
    const tooLong = await fetch(`${baseUrl}/fragments/area-list?userId=${'x'.repeat(65)}`);

    expect(await none.text()).toContain('Select a user above');
    expect(tooLong.status).toBe(422);
    expect(areaRepo.listAreas).not.toHaveBeenCalled();
  });

  test('shows a retry message when the store fails', async () => {
    areaRepo.listAreas.mockRejectedValueOnce(new Error('down'));

    const res = await fetch(`${baseUrl}/fragments/area-list?userId=AB`);

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
    const tag = html.slice(
      html.indexOf('id="events"'),
      html.indexOf('>', html.indexOf('id="events"')),
    );
    expect(tag).toContain('hx-include="#user-scope"');
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

  test('the page-wide user form sends a time zone field with the user', async () => {
    const html = await fetch(`${baseUrl}/`).then((res) => res.text());
    const scope = html.slice(html.indexOf('<form id="user-scope"'));

    expect(scope.slice(0, scope.indexOf('</form>'))).toContain('name="tz"');
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

  test("names events after the user's areas as they are now, not as stored", async () => {
    areaEvents.listAreaEvents.mockImplementation(() =>
      Promise.resolve([{ ...entered, areaName: 'Hom' }]),
    );
    areaRepo.listAreas.mockResolvedValueOnce([
      buildArea({ id: 'home-id', userId: 'AB', name: 'Home' }),
    ]);

    const html = await fetch(`${baseUrl}/fragments/events?userId=AB`).then((res) => res.text());

    expect(areaRepo.listAreas).toHaveBeenCalledWith('AB');
    expect(readEventsData(html).rows[0].areaLabel).toBe('Home');
    expect(html).not.toContain('Hom<');
  });

  test('still lists events, under their stored names, when the areas cannot be loaded', async () => {
    areaEvents.listAreaEvents.mockImplementation(() =>
      Promise.resolve([{ ...entered, areaName: 'Hom' }]),
    );
    areaRepo.listAreas.mockRejectedValueOnce(new Error('area store down'));

    const res = await fetch(`${baseUrl}/fragments/events?userId=AB`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(readEventsData(html).rows[0].areaLabel).toBe('Hom');
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

describe('GET /fragments/timeline', () => {
  const DAY = zonedDayRange('2026-11-22', 'America/New_York');
  const HOME = { lat: 42.3467, lon: -71.0972 };
  const MARKET = { lat: 42.3603, lon: -71.0554 };
  const home: TimelineStop = {
    kind: 'stop',
    label: 'Home',
    category: 'Saved area',
    isFromOpenStreetMap: false,
    ...HOME,
    arrivedAt: DAY.from - 6 * 3600,
    departedAt: DAY.from + 9 * 3600,
  };
  const toMarket: TimelineTrip = {
    kind: 'trip',
    startedAt: DAY.from + 9 * 3600,
    endedAt: DAY.from + 9 * 3600 + 23 * 60,
    path: [
      { ...HOME, tst: DAY.from + 9 * 3600 },
      { ...MARKET, tst: DAY.from + 9 * 3600 + 23 * 60 },
    ],
    distanceMeters: 3_240,
    isPathEstimated: false,
    isOngoing: false,
    fromLabel: 'Home',
    toLabel: 'Fresh Market',
  };
  const market: TimelineStop = {
    kind: 'stop',
    label: 'Fresh Market',
    category: 'Grocery store',
    isFromOpenStreetMap: true,
    ...MARKET,
    arrivedAt: DAY.from + 9 * 3600 + 23 * 60,
    departedAt: DAY.from + 10 * 3600 + 33 * 60,
  };
  const timelineDay = (entries: DayTimeline['entries']): DayTimeline => ({
    userId: 'AB',
    date: '2026-11-22',
    timeZone: 'America/New_York',
    day: DAY,
    entries,
  });
  const readTimelineData = (html: string) =>
    JSON.parse(
      html.match(/<script type="application\/json" id="timeline-data">(.*?)<\/script>/s)![1]!,
    );

  test('the page has a timeline form that loads the fragment on request', async () => {
    const html = await fetch(`${baseUrl}/`).then((res) => res.text());

    expect(html).toContain('id="timeline-form"');
    expect(html).toContain('hx-get="/fragments/timeline"');
    expect(html).toContain('<input type="date" name="date" id="timeline-date" required />');
  });

  test("lists the day's stops and trips in the viewer's zone and embeds them for the map", async () => {
    dayTimeline.mockImplementation(async () => timelineDay([home, toMarket, market]));

    const res = await fetch(
      `${baseUrl}/fragments/timeline?userId=AB&date=2026-11-22&tz=America%2FNew_York`,
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(dayTimeline).toHaveBeenCalledWith('AB', {
      date: '2026-11-22',
      timeZone: 'America/New_York',
    });
    expect(html).toContain('Sunday, November 22, 2026');
    expect(html).toContain('<span class="timeline-time">Until 9:00 AM</span>');
    expect(html).toContain('<span class="timeline-label">Home → Fresh Market</span>');
    expect(html).toContain('<span class="timeline-detail">23 min · 3.2 km</span>');
    expect(html).toContain('id="timeline-scrubber"');
    expect(html).toContain('openstreetmap.org/copyright');
    const view = readTimelineData(html);
    expect(view.userId).toBe('AB');
    expect(view.rows).toHaveLength(3);
    expect(view.featureCollection.features).toHaveLength(3);
  });

  test('an unknown time zone falls back to UTC', async () => {
    await fetch(`${baseUrl}/fragments/timeline?userId=AB&date=2026-11-22&tz=Mars%2FOlympus`);

    expect(dayTimeline).toHaveBeenCalledWith('AB', { date: '2026-11-22', timeZone: 'UTC' });
  });

  test('says so when the day has no locations, still clearing the map', async () => {
    const html = await fetch(`${baseUrl}/fragments/timeline?userId=AB&date=2026-11-22`).then(
      (res) => res.text(),
    );

    expect(html).toContain('No locations on this day.');
    expect(html).not.toContain('timeline-scrubber');
    expect(readTimelineData(html).rows).toEqual([]);
  });

  test('rejects a missing user or a day that is not a real date', async () => {
    const noUser = await fetch(`${baseUrl}/fragments/timeline?userId=&date=2026-11-22`);
    const badDate = await fetch(`${baseUrl}/fragments/timeline?userId=AB&date=2026-02-30`);
    const noDate = await fetch(`${baseUrl}/fragments/timeline?userId=AB`);

    expect(noUser.status).toBe(422);
    expect(await noUser.text()).toContain('Select a user');
    expect(badDate.status).toBe(422);
    expect(await badDate.text()).toContain('Choose a day');
    expect(noDate.status).toBe(422);
    expect(dayTimeline).not.toHaveBeenCalled();
  });

  test('escapes place names in the list and the embedded JSON', async () => {
    const hostile = '</script><img src=x onerror=alert(1)>';
    dayTimeline.mockImplementation(async () =>
      timelineDay([
        { ...home, label: hostile },
        { ...toMarket, fromLabel: hostile },
      ]),
    );

    const html = await fetch(`${baseUrl}/fragments/timeline?userId=AB&date=2026-11-22`).then(
      (res) => res.text(),
    );

    expect(html).not.toContain('<img');
    expect(readTimelineData(html).rows[0].label).toBe(hostile);
  });

  test('shows a retry message without map data when the timeline fails', async () => {
    dayTimeline.mockImplementation(async () => {
      throw new Error('db down');
    });

    const res = await fetch(`${baseUrl}/fragments/timeline?userId=AB&date=2026-11-22`);
    const html = await res.text();

    expect(res.status).toBe(503);
    expect(html).toContain('Could not build the timeline');
    expect(html).not.toContain('timeline-data');
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

  test('asks whether a place should become an area, with a draft to start from', async () => {
    visitedPlaces.mockImplementation(async () => [grocery]);

    const html = await fetch(`${baseUrl}/fragments/places?userId=AB`).then((res) => res.text());

    expect(html).toContain('Make this a saved area?');
    const button = html.match(/<button[^>]*class="place-save-area[^>]*>/)![0];
    expect(button).toContain('data-place-id="place-1"');
    // The list button and the map popup both read the draft from the data block.
    expect(readPlacesData(html).rows[0].proposedArea).toEqual({
      name: 'Fresh Market',
      lat: 42.37,
      lon: -71.04,
      radius: 100,
    });
  });

  test('does not offer to save a place that is already an area', async () => {
    visitedPlaces.mockImplementation(async () => [
      { ...grocery, area: { id: 'shop', name: 'The shop' }, lookup: 'area' },
    ]);

    const html = await fetch(`${baseUrl}/fragments/places?userId=AB`).then((res) => res.text());

    expect(html).toContain('The shop');
    expect(html).not.toContain('place-save-area');
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
    expect(readPlacesData(html).rows[0].proposedArea.name).toBe(hostile);
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

  test("creates an area and returns that user's refreshed areas", async () => {
    const res = await fetch(
      `${baseUrl}/areas`,
      formBody({ userId: 'AB', name: 'Home', lat: '42.3601', lon: '-71.0589', radius: '250' }),
    );

    expect(res.status).toBe(200);
    expect(areaRepo.listAreas).toHaveBeenCalledWith('AB');
    expect(areaRepo.addArea).toHaveBeenCalledTimes(1);
    expect(areaRepo.addArea.mock.calls[0]![0]).toMatchObject({
      userId: 'AB',
      name: 'Home',
      lat: 42.3601,
      lon: -71.0589,
      radius: 250,
    });
    // The response re-renders the areas so the sidebar and map stay in step.
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

  test('rejects an out-of-range coordinate without clearing the areas panel', async () => {
    const res = await fetch(
      `${baseUrl}/areas`,
      formBody({ userId: 'AB', name: 'Home', lat: '999', lon: '-71.06', radius: '100' }),
    );

    expect(res.status).toBe(422);
    expect(areaRepo.addArea).not.toHaveBeenCalled();

    const html = await res.text();
    // Error arrives out-of-band alongside the areas, so the sidebar survives.
    expect(html).toContain('id="form-error"');
    expect(html).toContain('hx-swap-oob');
    expect(html).toContain('areas-data');
    expect(areaRepo.listAreas).toHaveBeenCalledWith('AB');
  });

  test("rejects a missing user without reading anyone else's areas", async () => {
    const res = await fetch(
      `${baseUrl}/areas`,
      formBody({ userId: '', name: 'Home', lat: '42.36', lon: '-71.06', radius: '100' }),
    );

    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('Select a user above');
    expect(html).toContain('hx-swap-oob');
    expect(areaRepo.listAreas).not.toHaveBeenCalled();
    expect(areaRepo.listAllAreas).not.toHaveBeenCalled();
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

describe('PUT /areas/:userId/:areaId', () => {
  const put = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  const CHANGES = { name: 'Gym', lat: '42.35', lon: '-71.06', radius: '75.5' };
  const readError = async (res: Response) => ((await res.json()) as { error: string }).error;

  test('replaces the name and circle in one write, keeping the ID and owner', async () => {
    areaRepo.updateArea.mockResolvedValueOnce(true);

    const res = await put('/areas/AB/a1', CHANGES);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'a1' });
    expect(areaRepo.updateArea).toHaveBeenCalledTimes(1);
    expect(areaRepo.updateArea.mock.calls[0]![0]).toEqual({
      id: 'a1',
      userId: 'AB',
      name: 'Gym',
      lat: 42.35,
      lon: -71.06,
      radius: 75.5,
    });
    // The upsert could recreate an area deleted meanwhile, so it is never used here.
    expect(areaRepo.addArea).not.toHaveBeenCalled();
  });

  test('never moves an area to another user', async () => {
    areaRepo.updateArea.mockResolvedValueOnce(true);

    await put('/areas/AB/a1', { ...CHANGES, userId: 'CD', id: 'other' });

    expect(areaRepo.updateArea.mock.calls[0]![0]).toMatchObject({ id: 'a1', userId: 'AB' });
  });

  test('cannot create an area: an unknown or deleted one is not found', async () => {
    const res = await put('/areas/AB/missing', CHANGES);

    expect(res.status).toBe(404);
    expect(await readError(res)).toBe('This area no longer exists.');
    expect(areaRepo.addArea).not.toHaveBeenCalled();
  });

  test('rejects invalid changes, naming the field', async () => {
    const res = await put('/areas/AB/a1', { ...CHANGES, radius: '0' });

    expect(res.status).toBe(422);
    expect(await readError(res)).toContain('radius');
    expect(areaRepo.updateArea).not.toHaveBeenCalled();
  });

  test('reports a store failure without claiming the edit was saved', async () => {
    areaRepo.updateArea.mockRejectedValueOnce(new Error('db down'));

    const res = await put('/areas/AB/a1', CHANGES);

    expect(res.status).toBe(503);
    expect(await readError(res)).toContain('Could not save changes');
  });
});

describe('DELETE /areas/:userId/:areaId', () => {
  test("removes the area and returns that user's refreshed areas", async () => {
    const res = await fetch(`${baseUrl}/areas/AB/a1`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(areaRepo.removeArea).toHaveBeenCalledWith('AB', 'a1');
    expect(areaRepo.listAreas).toHaveBeenCalledWith('AB');
    expect(await res.text()).toContain('areas-data');
  });

  test('reports a store failure', async () => {
    areaRepo.removeArea.mockRejectedValueOnce(new Error('db down'));

    const res = await fetch(`${baseUrl}/areas/AB/a1`, { method: 'DELETE' });

    expect(res.status).toBe(503);
  });
});

describe('GET /fragments/areas', () => {
  const readAreasData = (html: string) =>
    JSON.parse(html.match(/id="areas-data">(.*?)<\/script>/s)![1]!.replaceAll('\\u003c', '<'));

  test("lists the selected user's areas and embeds their circles for the map", async () => {
    areaRepo.listAreas.mockResolvedValueOnce([
      buildArea({ id: 'a1', userId: 'AB', name: 'Home' }),
      buildArea({ id: 'a2', userId: 'AB', name: 'Gym', radius: 40.4 }),
    ]);

    const res = await fetch(`${baseUrl}/fragments/areas?userId=AB`);
    expect(res.status).toBe(200);
    expect(areaRepo.listAreas).toHaveBeenCalledWith('AB');
    expect(areaRepo.listAllAreas).not.toHaveBeenCalled();

    const html = await res.text();
    expect(html).toContain('2 areas');
    // Sorted by name, and each one zooms the map to its circle.
    expect(html.indexOf('Gym')).toBeLessThan(html.indexOf('Home'));
    expect(html).toContain('40 m');
    expect(html.match(/class="area-locate" data-bounds="\[/g)).toHaveLength(2);
    // No per-user legend: there is only one user on the page.
    expect(html).not.toContain('type="checkbox"');

    const view = readAreasData(html);
    expect(view.userId).toBe('AB');
    expect(view.featureCollection.features).toHaveLength(2);
    expect(view.legend).toBeUndefined();
  });

  test('prompts for a user and clears the map when none is selected', async () => {
    const html = await fetch(`${baseUrl}/fragments/areas?userId=`).then((res) => res.text());

    expect(html).toContain('Select a user above');
    expect(readAreasData(html)).toEqual({
      userId: '',
      featureCollection: { type: 'FeatureCollection', features: [] },
      categories: [],
    });
    expect(areaRepo.listAreas).not.toHaveBeenCalled();
  });

  test('rejects an over-long user ID without touching the map', async () => {
    const res = await fetch(`${baseUrl}/fragments/areas?userId=${'x'.repeat(65)}`);

    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain('areas-data');
    expect(areaRepo.listAreas).not.toHaveBeenCalled();
  });

  test('shows an empty state when the user has no areas', async () => {
    const html = await fetch(`${baseUrl}/fragments/areas?userId=AB`).then((res) => res.text());

    expect(html).toContain('No areas for AB yet.');
    expect(readAreasData(html).userId).toBe('AB');
  });

  test('degrades to a visible message when the area store is unreachable', async () => {
    areaRepo.listAreas.mockRejectedValueOnce(new Error('Connection has failed'));

    const res = await fetch(`${baseUrl}/fragments/areas?userId=AB`);

    expect(res.status).toBe(503);

    const html = await res.text();
    expect(html).toContain('Could not reach the area store');
    // No data block, so the map keeps its last render instead of blanking out.
    expect(html).not.toContain('areas-data');
  });

  test('escapes area names and user IDs so they cannot inject markup', async () => {
    const userId = '<img src=x onerror=alert(1)>';
    areaRepo.listAreas.mockResolvedValueOnce([
      buildArea({ id: 'x1', userId, name: '</script><script>alert(2)</script>' }),
    ]);

    const html = await fetch(
      `${baseUrl}/fragments/areas?userId=${encodeURIComponent(userId)}`,
    ).then((res) => res.text());

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;/script&gt;');
    // The only <script> tag may be the data block itself.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toContain('alert(2)</script>');

    const view = readAreasData(html);
    expect(view.userId).toBe(userId);
    expect(view.featureCollection.features[0].properties.name).toBe(
      '</script><script>alert(2)</script>',
    );
  });

  test("an empty state escapes the user's ID", async () => {
    const html = await fetch(
      `${baseUrl}/fragments/areas?userId=${encodeURIComponent('<b>AB</b>')}`,
    ).then((res) => res.text());

    expect(html).toContain('No areas for &lt;b&gt;AB&lt;/b&gt; yet.');
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

test('recompute asks for a user when none is selected', async () => {
  const response = await fetch(`${baseUrl}/users/recompute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: '' }),
  });
  expect(response.status).toBe(422);
  expect(await response.text()).toBe('Select a user above.');
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
  expect(areaRepo.listAreas).not.toHaveBeenCalled();
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
