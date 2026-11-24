import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

import {
  attachDayTimeline,
  describeMoment,
  positionAt,
  TIMELINE_LAYER_IDS,
} from '@/../public/day-timeline.js';

type Handler = (event?: unknown) => void;

const HOME: [number, number] = [-71.0972, 42.3467];
const MARKET: [number, number] = [-71.0554, 42.3603];
const T = 1_795_000_000;

const ROWS = [
  {
    entryId: 'entry-1',
    kind: 'stop',
    label: 'Home',
    startsAt: T,
    endsAt: T + 3600,
    bounds: [...HOME, ...HOME],
  },
  {
    entryId: 'entry-2',
    kind: 'trip',
    label: 'Home → Fresh Market',
    startsAt: T + 3600,
    endsAt: T + 4800,
    bounds: [HOME[0], HOME[1], MARKET[0], MARKET[1]],
  },
];

const VIEW = {
  userId: 'AB',
  rows: ROWS,
  featureCollection: { type: 'FeatureCollection', features: [{ type: 'Feature' }] },
  bounds: [HOME[0], HOME[1], MARKET[0], MARKET[1]],
  track: [
    [...HOME, T],
    [...HOME, T + 3600],
    [...MARKET, T + 4800],
  ],
};

function fakeMap() {
  const handlers: Record<string, Handler[]> = {};
  const source = { setData: mock((_data: unknown) => {}) };
  return {
    source,
    on(event: string, handler: Handler) {
      (handlers[event] ??= []).push(handler);
    },
    fire(event: string) {
      for (const handler of handlers[event] ?? []) handler();
    },
    addSource: mock(() => {}),
    addLayer: mock((_layer: { id: string }) => {}),
    getSource: () => source,
    fitBounds: mock((_bounds: unknown, _options: unknown) => {}),
    flyTo: mock((_options: unknown) => {}),
    getZoom: () => 12,
  };
}

function setup() {
  const document = new Window().document;
  document.body.innerHTML = '<div id="timeline"></div>';
  const map = fakeMap();
  const markers: MockMarker[] = [];
  class MockMarker {
    position: unknown;
    remove = mock(() => {});
    constructor(_options: unknown) {
      markers.push(this);
    }
    setLngLat(position: unknown) {
      this.position = position;
      return this;
    }
    addTo() {
      return this;
    }
  }
  const timeline = attachDayTimeline(map, { Marker: MockMarker, root: document });
  const list = document.getElementById('timeline')!;

  /** What htmx does when a timeline fragment arrives. */
  const swap = (html: string) => {
    list.innerHTML = html;
    list.dispatchEvent(new document.defaultView!.CustomEvent('htmx:afterSwap', { bubbles: true }));
  };
  const fragment = (view: unknown) =>
    `<ol>${ROWS.map((row) => `<li><button class="timeline-locate" data-entry-id="${row.entryId}">${row.label}</button></li>`).join('')}</ol>
     <input type="range" id="timeline-scrubber" min="${T}" max="${T + 4800}" value="${T}" />
     <p id="timeline-caption"></p>
     <script type="application/json" id="timeline-data">${JSON.stringify(view)}</script>`;
  const click = (entryId: string) =>
    (list.querySelector(`[data-entry-id="${entryId}"]`) as unknown as { click(): void }).click();
  const scrub = (tst: number) => {
    const scrubber = document.getElementById('timeline-scrubber') as unknown as {
      value: string;
      dispatchEvent(event: unknown): void;
    };
    scrubber.value = String(tst);
    scrubber.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
  };
  const caption = () => document.getElementById('timeline-caption')!.textContent;

  return { document, map, markers, timeline, list, swap, fragment, click, scrub, caption };
}

describe('positionAt', () => {
  const track = VIEW.track as [number, number, number][];

  test('holds still at a stop and follows a trip in a straight line between points', () => {
    expect(positionAt(track, T + 1800)).toEqual(HOME);
    const halfway = positionAt(track, T + 4200)!;
    expect(halfway[0]).toBeCloseTo((HOME[0] + MARKET[0]) / 2, 6);
    expect(halfway[1]).toBeCloseTo((HOME[1] + MARKET[1]) / 2, 6);
    expect(positionAt(track, T + 4800)).toEqual(MARKET);
  });

  test('is nowhere before the track starts or after it ends', () => {
    expect(positionAt(track, T - 1)).toBeNull();
    expect(positionAt(track, T + 4801)).toBeNull();
    expect(positionAt([], T)).toBeNull();
  });
});

describe('describeMoment', () => {
  test('says where the user was, or that there is no data', () => {
    expect(describeMoment(ROWS, T + 60)).toBe('At Home');
    expect(describeMoment(ROWS, T + 4000)).toBe('On the way: Home → Fresh Market');
    expect(describeMoment(ROWS, T + 9999)).toBe('No location data');
  });
});

describe('attachDayTimeline', () => {
  test('adds its layers once the map loads and frames a day that arrived earlier', () => {
    const { map, swap, fragment } = setup();

    swap(fragment(VIEW));
    expect(map.source.setData).not.toHaveBeenCalled();
    map.fire('load');

    expect(map.addLayer.mock.calls.map(([layer]) => layer.id)).toEqual([
      TIMELINE_LAYER_IDS.trips,
      TIMELINE_LAYER_IDS.estimatedTrips,
      TIMELINE_LAYER_IDS.stops,
    ]);
    expect(map.source.setData).toHaveBeenLastCalledWith(VIEW.featureCollection);
    expect(map.fitBounds).toHaveBeenCalledWith(VIEW.bounds, { padding: 60, maxZoom: 15 });
  });

  test('puts the playback marker and caption at the start of the day', () => {
    const { map, markers, swap, fragment, caption } = setup();
    map.fire('load');

    swap(fragment(VIEW));

    expect(markers).toHaveLength(1);
    expect(markers[0]!.position).toEqual(HOME);
    expect(caption()).toContain('At Home');
  });

  test('scrubbing moves the one marker along the route', () => {
    const { map, markers, swap, fragment, scrub, caption } = setup();
    map.fire('load');
    swap(fragment(VIEW));

    scrub(T + 4800);

    expect(markers).toHaveLength(1);
    expect(markers[0]!.position).toEqual(MARKET);
    expect(caption()).toContain('On the way: Home → Fresh Market');
  });

  test('clicking a trip frames its route and jumps playback to it; a stop flies to it', () => {
    const { map, markers, swap, fragment, click } = setup();
    map.fire('load');
    swap(fragment(VIEW));

    click('entry-2');
    expect(map.fitBounds).toHaveBeenLastCalledWith(ROWS[1]!.bounds, { padding: 60, maxZoom: 16 });
    expect(markers[0]!.position).toEqual(HOME);

    click('entry-1');
    expect(map.flyTo).toHaveBeenCalledWith({ center: HOME, zoom: 16 });
  });

  test('keeps the last day on the map when an error replaces the list', () => {
    const { map, swap, fragment } = setup();
    map.fire('load');
    swap(fragment(VIEW));
    map.source.setData.mockClear();

    swap('<p class="notice">Could not build the timeline. Please retry.</p>');

    expect(map.source.setData).not.toHaveBeenCalled();
  });

  test('clear drops the day, its features and the marker, as a user switch needs', () => {
    const { map, markers, timeline, list, swap, fragment } = setup();
    map.fire('load');
    swap(fragment(VIEW));

    timeline.clear();

    expect(map.source.setData).toHaveBeenLastCalledWith({
      type: 'FeatureCollection',
      features: [],
    });
    expect(list.children).toHaveLength(0);
    expect(markers[0]!.remove).toHaveBeenCalled();
  });
});
