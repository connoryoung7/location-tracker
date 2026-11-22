import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

import { attachVisitedPlaces, PLACES_LAYER_ID } from '@/../public/visited-places.js';

type Handler = (event?: unknown) => void;

const PROPOSED = { name: 'Fresh Market', lat: 42.37, lon: -71.04, radius: 100 };

const VIEW = {
  userId: 'AB',
  // place-2 is already one of the user's areas, so it has nothing to propose.
  rows: [{ placeId: 'place-1', proposedArea: PROPOSED }, { placeId: 'place-2' }],
  featureCollection: {
    type: 'FeatureCollection',
    features: ['place-1', 'place-2'].map((placeId) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-71.04, 42.37] },
      properties: { placeId, label: 'Fresh Market', visitCount: 2 } as Record<string, unknown>,
    })),
  },
  bounds: [-71.05, 42.36, -71.04, 42.37],
};

type FeatureCollection = typeof VIEW.featureCollection;

function fakeMap() {
  const handlers: Record<string, Handler[]> = {};
  const source = { setData: mock((_data: FeatureCollection) => {}) };
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
  type PopupContent = {
    textContent: string | null;
    innerHTML: string;
    querySelector(selector: string): { click(): void } | null;
  };
  const popups: { content?: PopupContent; remove: ReturnType<typeof mock> }[] = [];
  class MockPopup {
    remove = mock(() => {});
    constructor() {
      popups.push(this as never);
    }
    setLngLat() {
      return this;
    }
    setDOMContent(content: PopupContent) {
      (this as { content?: unknown }).content = content;
      return this;
    }
    addTo() {
      return this;
    }
  }
  const proposeArea = mock(async (_draft: Record<string, string | number>) => isSaved);
  const places = attachVisitedPlaces(map, {
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
        <button class="place-save-area" data-place-id="place-1">Save as area</button></p></li></ol>
     <script type="application/json" id="places-data">${JSON.stringify(view)}</script>`;

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** The points the map was last given, as a click on one would report them. */
  const rendered = () => map.source.setData.mock.calls.at(-1)![0].features;
  /** Clicks a place's map point and returns the popup it opened. */
  const clickPoint = (placeId: string, features = rendered()) => {
    map.fire(`click:${PLACES_LAYER_ID}`, {
      features: features.filter((feature) => feature.properties.placeId === placeId),
    });
    return popups.at(-1)!;
  };

  return {
    document,
    map,
    popups,
    list,
    swap,
    fragment,
    proposeArea,
    flush,
    rendered,
    clickPoint,
    places,
  };
}

describe('attachVisitedPlaces', () => {
  test('adds its layer once the map loads and shows a result that arrived earlier', () => {
    const { map, swap, fragment, rendered } = setup();

    swap(fragment(VIEW));
    expect(map.source.setData).not.toHaveBeenCalled();
    map.fire('load');

    expect(map.addLayer.mock.calls[0]![0].id).toBe(PLACES_LAYER_ID);
    expect(rendered().map((feature) => feature.properties.placeId)).toEqual(['place-1', 'place-2']);
    expect(map.fitBounds).toHaveBeenCalledWith(VIEW.bounds, { padding: 60, maxZoom: 15 });
  });

  test('shows each new result and puts visit times in local time', () => {
    const { map, list, swap, fragment, rendered } = setup();
    map.fire('load');

    swap(fragment(VIEW));

    expect(rendered().map((feature) => feature.properties.placeId)).toEqual(['place-1', 'place-2']);
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

    expect(proposeArea).toHaveBeenCalledWith({ userId: 'AB', ...PROPOSED });
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

  test("a point's popup offers the same draft, and closes to show it", async () => {
    const { map, list, swap, fragment, proposeArea, flush, clickPoint } = setup();
    map.fire('load');
    swap(fragment(VIEW));

    const popup = clickPoint('place-1');
    popup.content!.querySelector('.popup-save-area')!.click();
    await flush();

    expect(popup.remove).toHaveBeenCalled();
    expect(proposeArea).toHaveBeenCalledWith({ userId: 'AB', ...PROPOSED });
    // Saved from the map, the list row says so as well.
    expect(list.querySelector('.place-propose')!.textContent).toBe('Saved as an area.');
    const reopened = clickPoint('place-1');
    expect(reopened.content!.querySelector('.popup-save-area')).toBeNull();
    expect(reopened.content!.textContent).toContain('Saved as an area.');
  });

  test('a popup for a place saved from the list says it is saved', async () => {
    const { map, list, swap, fragment, flush, clickPoint } = setup();
    map.fire('load');
    swap(fragment(VIEW));

    (list.querySelector('.place-save-area') as unknown as { click(): void }).click();
    await flush();

    expect(clickPoint('place-1').content!.textContent).toContain('Saved as an area.');
  });

  test('a new result closes an open popup, and its stale button proposes nothing', async () => {
    const { map, swap, fragment, proposeArea, flush, clickPoint } = setup();
    map.fire('load');
    swap(fragment(VIEW));
    const stale = clickPoint('place-1');

    // Same IDs, but place-1 is now someone else's place.
    swap(fragment({ ...VIEW, userId: 'CD' }));
    stale.content!.querySelector('.popup-save-area')!.click();
    await flush();

    expect(stale.remove).toHaveBeenCalled();
    expect(proposeArea).not.toHaveBeenCalled();
  });

  test('saving from the list closes an open popup and its button cannot propose again', async () => {
    const { map, list, swap, fragment, proposeArea, flush, clickPoint } = setup();
    map.fire('load');
    swap(fragment(VIEW));
    const popup = clickPoint('place-1');

    (list.querySelector('.place-save-area') as unknown as { click(): void }).click();
    await flush();
    popup.content!.querySelector('.popup-save-area')!.click();
    await flush();

    expect(popup.remove).toHaveBeenCalled();
    expect(proposeArea).toHaveBeenCalledTimes(1);
  });

  test('a place that is already an area gets no popup button', () => {
    const { map, swap, fragment, clickPoint } = setup();
    map.fire('load');
    swap(fragment(VIEW));

    expect(clickPoint('place-2').content!.querySelector('.popup-save-area')).toBeNull();
  });

  test('a newer result while the draft is open is left alone', async () => {
    const { map, list, swap, fragment, proposeArea, flush, clickPoint } = setup();
    let finishSaving = (_isSaved: boolean) => {};
    proposeArea.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (finishSaving = resolve)),
    );
    map.fire('load');
    swap(fragment(VIEW));

    (list.querySelector('.place-save-area') as unknown as { click(): void }).click();
    // In the new result, place-1 may be a different place altogether.
    swap(fragment(VIEW));
    finishSaving(true);
    await flush();

    expect(list.querySelector('.place-save-area')).not.toBeNull();
    expect(clickPoint('place-1').content!.querySelector('.popup-save-area')).not.toBeNull();
  });

  test('a point opens a popup that treats names as text', () => {
    const { map, swap, fragment, clickPoint } = setup();
    const hostile = '<img src=x onerror=alert(1)>';
    const properties = {
      placeId: 'place-1',
      label: hostile,
      category: 'Grocery store',
      visitCount: 2,
      durationLabel: '1h 10m',
    };
    map.fire('load');
    swap(
      fragment({
        ...VIEW,
        featureCollection: {
          ...VIEW.featureCollection,
          features: [{ ...VIEW.featureCollection.features[0]!, properties }],
        },
      }),
    );

    const content = clickPoint('place-1').content!;
    expect(content.textContent).toContain(hostile);
    expect(content.textContent).toContain('Grocery store · 2 visits · 1h 10m');
    expect(content.innerHTML).not.toContain('<img');
  });

  test('points do nothing while an area is being drawn', () => {
    const { map, popups, swap, fragment, clickPoint } = setup({ isDrawing: true });
    map.fire('load');
    swap(fragment(VIEW));

    clickPoint('place-1');

    expect(popups).toHaveLength(0);
  });

  test('a point from an older result, still drawn until setData lands, opens nothing', () => {
    const { map, popups, swap, fragment, rendered, clickPoint } = setup();
    map.fire('load');
    swap(fragment(VIEW));
    const oldPoints = rendered();

    // Same place IDs, but a different user's places.
    swap(fragment({ ...VIEW, userId: 'CD' }));
    clickPoint('place-1', oldPoints);

    expect(popups).toHaveLength(0);
  });

  test('clearing for a user switch drops the list, points and popup, and nothing old still works', async () => {
    const { map, list, popups, swap, fragment, rendered, clickPoint, proposeArea, places, flush } =
      setup();
    map.fire('load');
    swap(fragment(VIEW));
    const oldPoints = rendered();
    const popup = clickPoint('place-1');

    places.clear();

    expect(list.innerHTML).toBe('');
    expect(rendered()).toEqual([]);
    expect(popup.remove).toHaveBeenCalled();
    // The old popup's button, and the old points until MapLibre removes them, do nothing.
    popup.content!.querySelector('.popup-save-area')!.click();
    await flush();
    expect(proposeArea).not.toHaveBeenCalled();
    clickPoint('place-1', oldPoints);
    expect(popups).toHaveLength(1);
  });
});
