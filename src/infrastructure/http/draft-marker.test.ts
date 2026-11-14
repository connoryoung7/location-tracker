import { expect, test, mock } from 'bun:test';
import { Window } from 'happy-dom';
import { createDraftMarker } from '@/../public/draft-marker.js';

function setup() {
  const document = new Window().document;
  const markers: MockMarker[] = [];
  class MockMarker {
    element = document.createElement('div');
    position = [0, 0];
    handlers: Record<string, () => void> = {};
    setDraggable = mock((_editable: boolean) => this);
    remove = mock(() => this);
    constructor(_options: unknown) {
      markers.push(this);
    }
    getElement() {
      return this.element;
    }
    getLngLat() {
      return { lng: this.position[0]!, lat: this.position[1]! };
    }
    setLngLat(point: number[]) {
      this.position = point;
      return this;
    }
    addTo(_map: unknown) {
      return this;
    }
    on(event: string, callback: () => void) {
      this.handlers[event] = callback;
      return this;
    }
  }
  const moved = mock((_centre: number[], _radius: number) => {});
  const draft = createDraftMarker({}, MockMarker, moved);
  return { draft, markers, moved };
}

test('dragging moves only the centre, preserves radius, and numeric updates move the marker', () => {
  const { draft, markers, moved } = setup();
  draft.update([-71, 42], 250);
  const marker = markers[0]!;
  marker.position = [-70, 43];
  marker.handlers.drag!();
  expect(moved).toHaveBeenLastCalledWith([-70, 43], 250);
  draft.update([-69, 44], 300);
  expect(markers).toHaveLength(1);
  expect(marker.position).toEqual([-69, 44]);
  marker.handlers.drag!();
  expect(moved).toHaveBeenLastCalledWith([-69, 44], 300);
});

test('review disables dragging, editing restores it, and cancellation removes the marker', () => {
  const { draft, markers, moved } = setup();
  draft.update([-71, 42], 100);
  const marker = markers[0]!;
  draft.setEditable(false);
  expect(marker.setDraggable).toHaveBeenLastCalledWith(false);
  marker.handlers.drag!();
  expect(moved).not.toHaveBeenCalled();
  draft.setEditable(true);
  marker.handlers.drag!();
  expect(moved).toHaveBeenCalledTimes(1);
  draft.update(null, 0);
  expect(marker.remove).toHaveBeenCalledTimes(1);
});

test('a centre moved before sizing gets a radius and wraps longitude into valid bounds', () => {
  const { draft, markers, moved } = setup();
  draft.update([180, 0], 0);
  markers[0]!.position = [181, 1];
  markers[0]!.handlers.drag!();
  expect(moved).toHaveBeenLastCalledWith([-179, 1], 100);
});
