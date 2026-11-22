import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

import { attachVisitedPlaces, PLACES_LAYER_ID } from '@/../public/visited-places.js';

type Handler = (event?: unknown) => void;

const VIEW = {
  userId: 'AB',
  featureCollection: {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-71.04, 42.37] } }],
  },
  bounds: [-71.05, 42.36, -71.04, 42.37],
};

function fakeMap() {
  const handlers: Record<string, Handler[]> = {};
  const source = { setData: mock((_data: unknown) => {}) };
  return {
    source,
    on(event: string, layerOrHandler: string | Handler, handler?: Handler) {
      const key = handler ? `${event}:${String(layerOrHandler)}` : event;
      (handlers[key] ??= []).push((handler ?? layerOrHandler) as Handler);
    },
    fire(key: string, event?: unknown) {
      for (const handler of handlers[key] ?? []) handler(event);
    },
    addSource: mock(() => {}),
    addLayer: mock((_layer: { id: string }) => {}),
    getSource: () => source,
    fitBounds: mock((_bounds: unknown, _options: unknown) => {}),
    flyTo: mock((_options: unknown) => {}),
    getZoom: () => 12,
    getCanvas: () => ({ style: { cursor: '' } }),
  };
}

function setup({ isDrawing = false, isSaved = true } = {}) {
  const document = new Window().document;
  document.body.innerHTML = '<div id="places"></div>';
  const map = fakeMap();
  const popups: { content?: { textContent: string | null; innerHTML: string } }[] = [];
  class MockPopup {
    constructor() {
      popups.push(this as never);
    }
    setLngLat() {
      return this;
    }
    setDOMContent(content: { textContent: string | null; innerHTML: string }) {
      (this as { content?: unknown }).content = content;
      return this;
    }
    addTo() {
      return this;
    }
  }
  const proposeArea = mock(async (_draft: Record<string, string>) => isSaved);
  attachVisitedPlaces(map, {
    Popup: MockPopup,
    isDrawing: () => isDrawing,
    proposeArea,
    root: document,
  });
  const list = document.getElementById('places')!;

  /** What htmx does when a places fragment arrives. */
  const swap = (html: string) => {
    list.innerHTML = html;
    list.dispatchEvent(new document.defaultView!.CustomEvent('htmx:afterSwap', { bubbles: true }));
  };
  const fragment = (view: unknown) =>
    `<ol><li><button class="place-locate" data-lon="-71.04" data-lat="42.37">
      <time datetime="2023-11-14T22:43:20.000Z">2023-11-14T22:43:20.000Z</time></button>
      <p class="place-propose">Make this a saved area?
        <button class="place-save-area" data-user-id="AB" data-name="Fresh Market" data-lat="42.37"
          data-lon="-71.04" data-radius="100">Save as area</button></p></li></ol>
     <script type="application/json" id="places-data">${JSON.stringify(view)}</script>`;

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  return { document, map, popups, list, swap, fragment, proposeArea, flush };
}

describe('attachVisitedPlaces', () => {
  test('adds its layer once the map loads and shows a result that arrived earlier', () => {
    const { map, swap, fragment } = setup();

    swap(fragment(VIEW));
    expect(map.source.setData).not.toHaveBeenCalled();
    map.fire('load');

    expect(map.addLayer.mock.calls[0]![0].id).toBe(PLACES_LAYER_ID);
    expect(map.source.setData).toHaveBeenLastCalledWith(VIEW.featureCollection);
    expect(map.fitBounds).toHaveBeenCalledWith(VIEW.bounds, { padding: 60, maxZoom: 15 });
  });

  test('shows each new result and puts visit times in local time', () => {
    const { map, list, swap, fragment } = setup();
    map.fire('load');

    swap(fragment(VIEW));

    expect(map.source.setData).toHaveBeenLastCalledWith(VIEW.featureCollection);
    const time = list.querySelector('time')!;
    expect(time.textContent).toBe(new Date('2023-11-14T22:43:20.000Z').toLocaleString());
  });

  test('keeps the last result on the map when an error replaces the list', () => {
    const { map, swap, fragment } = setup();
    map.fire('load');
    swap(fragment(VIEW));
    map.source.setData.mockClear();

    swap('<p class="notice">Could not find places. Please retry.</p>');

    expect(map.source.setData).not.toHaveBeenCalled();
  });

  test('ignores swaps into other elements', () => {
    const { document, map } = setup();
    map.fire('load');
    // Loading draws an empty collection; only later calls matter here.
    map.source.setData.mockClear();
    const other = document.createElement('div');
    document.body.append(other);

    other.dispatchEvent(new document.defaultView!.CustomEvent('htmx:afterSwap', { bubbles: true }));

    expect(map.source.setData).not.toHaveBeenCalled();
  });

  test('clicking a row flies to the place', () => {
    const { map, list, swap, fragment } = setup();
    map.fire('load');
    swap(fragment(VIEW));

    (list.querySelector('.place-locate') as unknown as { click(): void }).click();

    expect(map.flyTo).toHaveBeenCalledWith({ center: [-71.04, 42.37], zoom: 16 });
  });

  test('saving a place as an area hands its draft over and confirms once saved', async () => {
    const { map, list, swap, fragment, proposeArea, flush } = setup();
    map.fire('load');
    swap(fragment(VIEW));

    (list.querySelector('.place-save-area') as unknown as { click(): void }).click();
    await flush();

    expect(proposeArea).toHaveBeenCalledWith({
      userId: 'AB',
      name: 'Fresh Market',
      lat: '42.37',
      lon: '-71.04',
      radius: '100',
    });
    expect(list.querySelector('.place-propose')!.textContent).toBe('Saved as an area.');
    // The button is not inside the row's locate button, so it does not also fly there.
    expect(map.flyTo).not.toHaveBeenCalled();
  });

  test('keeps asking when the draft is abandoned', async () => {
    const { map, list, swap, fragment, flush } = setup({ isSaved: false });
    map.fire('load');
    swap(fragment(VIEW));

    (list.querySelector('.place-save-area') as unknown as { click(): void }).click();
    await flush();

    expect(list.querySelector('.place-save-area')).not.toBeNull();
  });

  test('a point opens a popup that treats names as text', () => {
    const { map, popups } = setup();
    const hostile = '<img src=x onerror=alert(1)>';

    map.fire(`click:${PLACES_LAYER_ID}`, {
      features: [
        {
          geometry: { coordinates: [-71.04, 42.37] },
          properties: {
            label: hostile,
            category: 'Grocery store',
            visitCount: 2,
            durationLabel: '1h 10m',
          },
        },
      ],
    });

    const content = popups[0]!.content!;
    expect(content.textContent).toContain(hostile);
    expect(content.textContent).toContain('Grocery store · 2 visits · 1h 10m');
    expect(content.innerHTML).not.toContain('<img');
  });

  test('points do nothing while an area is being drawn', () => {
    const { map, popups } = setup({ isDrawing: true });

    map.fire(`click:${PLACES_LAYER_ID}`, {
      features: [{ geometry: { coordinates: [0, 0] }, properties: { label: 'x', visitCount: 1 } }],
    });

    expect(popups).toHaveLength(0);
  });
});
