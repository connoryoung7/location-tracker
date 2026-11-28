import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { HTMLElement } from 'happy-dom';

import { attachDotTooltip, listDotEntries, renderDotEntries } from './dot-tooltip.js';

type MockEntry = { key: string; color: string; label: string; isoTime: string };
type MockFeature = { layer: { id: string }; properties: MockEntry & { isStale?: boolean } };

const describeMock = (properties: MockFeature['properties']) =>
  properties.isStale ? null : properties;
const describers = { events: describeMock, places: describeMock };

function mockFeature(layer: string, key: string, isoTime: string, isStale = false): MockFeature {
  return { layer: { id: layer }, properties: { key, color: '#000', label: key, isoTime, isStale } };
}

describe('listDotEntries', () => {
  test('lists every layer’s dots newest first', () => {
    const entries = listDotEntries(
      [
        mockFeature('events', 'a', '2026-11-27T10:00:00.000Z'),
        mockFeature('places', 'b', '2026-11-28T09:00:00.000Z'),
        mockFeature('events', 'c', '2026-11-26T23:00:00.000Z'),
      ],
      describers,
    );
    expect(entries.map((entry) => entry.key)).toEqual(['b', 'a', 'c']);
  });

  test('drops dots their layer leaves out, repeats, and unknown layers', () => {
    const entries = listDotEntries(
      [
        mockFeature('events', 'a', '2026-11-27T10:00:00.000Z'),
        mockFeature('events', 'a', '2026-11-27T10:00:00.000Z'),
        mockFeature('events', 'stale', '2026-11-27T11:00:00.000Z', true),
        mockFeature('basemap', 'road', '2026-11-27T12:00:00.000Z'),
      ],
      describers,
    );
    expect(entries.map((entry) => entry.key)).toEqual(['a']);
  });
});

describe('renderDotEntries', () => {
  const { document } = new Window();

  test('renders labels as text and counts entries past the limit', () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      key: `k${index}`,
      color: '#000',
      label: `<b>Area ${index}</b>`,
      isoTime: '2026-11-27T10:00:00.000Z',
      timePrefix: index === 0 ? 'Last visit' : undefined,
    }));
    const container = renderDotEntries(document, entries);

    const items = container.querySelectorAll('li');
    expect(items.length).toBe(8);
    expect(container.querySelector('b')).toBeNull();
    expect(items[0]!.querySelector('.dot-label')!.textContent).toBe('<b>Area 0</b>');
    expect(items[0]!.querySelector('time')!.textContent).toStartWith('Last visit ');
    expect(items[0]!.querySelector('time')!.getAttribute('datetime')).toBe(
      '2026-11-27T10:00:00.000Z',
    );
    expect(container.querySelector('.popup-detail')!.textContent).toBe('+2 more');
  });
});

describe('attachDotTooltip', () => {
  const { document } = new Window();
  const DELAY_MS = 20;

  function setup({ isEnabled = (): boolean => true }: { isEnabled?: () => boolean } = {}) {
    const handlers: Record<string, (event?: unknown) => void> = {};
    let featuresUnderCursor: MockFeature[] = [];
    const shown: Array<{ isRemoved: boolean; content: HTMLElement }> = [];

    const mockMap = {
      on: (type: string, handler: (event?: unknown) => void) => {
        handlers[type] = handler;
      },
      getLayer: (id: string) => (id in describers ? {} : undefined),
      isMoving: () => false,
      queryRenderedFeatures: () => featuresUnderCursor,
    };
    class MockPopup {
      record = { isRemoved: false, content: null as unknown as HTMLElement };
      setLngLat() {
        return this;
      }
      setDOMContent(content: HTMLElement) {
        this.record.content = content;
        return this;
      }
      addTo() {
        shown.push(this.record);
        return this;
      }
      remove() {
        this.record.isRemoved = true;
      }
    }

    const tooltip = attachDotTooltip(mockMap, {
      Popup: MockPopup,
      describers,
      isEnabled,
      root: document,
      delayMs: DELAY_MS,
    });
    const hover = (features: MockFeature[]) => {
      featuresUnderCursor = features;
      handlers.mousemove!({ point: { x: 0, y: 0 }, lngLat: { lng: 0, lat: 0 } });
    };
    const visible = () => shown.filter((record) => !record.isRemoved);
    return { handlers, hover, shown, visible, tooltip };
  }

  const dot = mockFeature('events', 'a', '2026-11-27T10:00:00.000Z');
  const otherDot = mockFeature('places', 'b', '2026-11-28T09:00:00.000Z');

  test('shows after the cursor rests on dots, listing all of them', async () => {
    const { hover, visible } = setup();
    hover([dot, otherDot]);
    expect(visible()).toHaveLength(0);

    await Bun.sleep(DELAY_MS * 2);
    expect(visible()).toHaveLength(1);
    expect(visible()[0]!.content.querySelectorAll('li')).toHaveLength(2);
  });

  test('keeps waiting while the cursor moves within the same dots', async () => {
    const { hover, shown } = setup();
    hover([dot]);
    await Bun.sleep(DELAY_MS / 2);
    hover([dot]);
    await Bun.sleep(DELAY_MS);
    expect(shown).toHaveLength(1);
  });

  test('hides when the cursor leaves the dots, and never shows for none', async () => {
    const { hover, visible } = setup();
    hover([dot]);
    await Bun.sleep(DELAY_MS * 2);
    hover([]);
    expect(visible()).toHaveLength(0);
    await Bun.sleep(DELAY_MS * 2);
    expect(visible()).toHaveLength(0);
  });

  test('a press hides it until the cursor finds other dots', async () => {
    const { handlers, hover, visible } = setup();
    hover([dot]);
    await Bun.sleep(DELAY_MS * 2);
    handlers.mousedown!();
    expect(visible()).toHaveLength(0);

    hover([dot]);
    await Bun.sleep(DELAY_MS * 2);
    expect(visible()).toHaveLength(0);

    hover([dot, otherDot]);
    await Bun.sleep(DELAY_MS * 2);
    expect(visible()).toHaveLength(1);
  });

  test('stays off while disabled, and reset cancels a pending tooltip', async () => {
    let isEnabled = false;
    const { hover, shown, tooltip } = setup({ isEnabled: () => isEnabled });
    hover([dot]);
    await Bun.sleep(DELAY_MS * 2);
    expect(shown).toHaveLength(0);

    isEnabled = true;
    hover([dot]);
    tooltip.reset();
    await Bun.sleep(DELAY_MS * 2);
    expect(shown).toHaveLength(0);
  });
});
