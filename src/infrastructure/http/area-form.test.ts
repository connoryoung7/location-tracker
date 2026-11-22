import { beforeAll, afterAll, expect, test, mock } from 'bun:test';
import {
  Window,
  type HTMLFormElement,
  type HTMLInputElement,
  type HTMLSelectElement,
  type HTMLElement,
} from 'happy-dom';
import { createAreaForm, updateUserSelects } from '@/../public/area-form.js';
import { createAppServer } from '@/infrastructure/http/app-server.ts';
import {
  mockAreaEventRepository,
  mockAreaRepository,
  mockLogger,
  mockMetricsCollector,
} from '@/test/mocks.ts';
import type { Server } from 'node:http';

let server: Server;
let page: string;
beforeAll(async () => {
  const app = createAppServer({
    areaRepo: mockAreaRepository(),
    areaEvents: mockAreaEventRepository(),
    users: { listUserIds: async () => [] },
    logger: mockLogger(),
    metrics: mockMetricsCollector(),
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as { port: number };
  page = await (await fetch(`http://127.0.0.1:${address.port}`)).text();
});
afterAll(() => {
  server.close();
});
function setup(users: string[] = ['AB']) {
  const window = new Window();
  const document = window.document;
  // Parse the actual page markup; remote scripts are not executed.
  document.body.innerHTML = page;
  const preview = mock(() => {});
  const saved = mock(() => {});
  const editingChanged = mock((_editable: boolean) => {});
  const placementChanged = mock((_mode: string) => {});
  const request = mock(
    async (_url: string, _options: RequestInit) => new Response('{}', { status: 201 }),
  );
  const controller = createAreaForm(document, {
    preview,
    saved,
    editingChanged,
    placementChanged,
    started: () => {},
    cancelled: () => {},
    request,
  });
  updateUserSelects(document, users);
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const form = byId('draw-form') as unknown as HTMLFormElement;
  const set = (key: string, value: string) => {
    (form.elements.namedItem(key) as HTMLInputElement).value = value;
  };
  const submit = async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    byId,
    window,
    document,
    preview,
    saved,
    editingChanged,
    placementChanged,
    request,
    controller,
    form,
    set,
    submit,
  };
}

test('empty, sole, and multiple users update every user select, preserve valid selection and escape IDs', () => {
  const { document } = setup([]);
  const selects = [...document.querySelectorAll('[data-user-select]')];
  // Recompute, events filter, and draw form.
  expect(selects).toHaveLength(3);
  for (const select of selects)
    expect((select as unknown as HTMLSelectElement).disabled).toBe(true);
  updateUserSelects(document, ['AB']);
  for (const select of selects) expect((select as unknown as HTMLSelectElement).value).toBe('AB');
  updateUserSelects(document, ['AB', '<img src=x>']);
  for (const select of selects) expect((select as unknown as HTMLSelectElement).value).toBe('AB');
  expect(document.querySelector('img')).toBeNull();
  updateUserSelects(document, ['CD', 'EF']);
  for (const select of selects) expect((select as unknown as HTMLSelectElement).value).toBe('');
});

test('draft geometry, review, polling, back, and cancellation never persist an area', async () => {
  const { byId, document, form, set, submit, request, preview, controller } = setup();
  byId('draw-start')!.click();
  set('name', 'Home');
  controller.setGeometry([-71, 42], 250);
  set('lat', '43');
  form.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
  expect(preview).toHaveBeenLastCalledWith([-71, 43], 250);
  await submit();
  expect(byId('draw-confirmation')!.hidden).toBe(false);
  expect(byId('draw-summary')!.textContent).toContain('Latitude: 43');
  updateUserSelects(document, ['AB', 'CD']);
  expect(byId('draw-confirmation')!.hidden).toBe(false);
  byId('draw-back')!.click();
  expect((form.elements.namedItem('lat') as HTMLInputElement).value).toBe('43');
  await submit();
  byId('draw-cancel')!.click();
  expect(form.hidden).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

test('invalid geometry is rejected and only final confirmation persists the selected user once', async () => {
  const { byId, document, set, submit, request, form, controller } = setup(['AB', 'CD']);
  byId('draw-start')!.click();
  set('userId', 'CD');
  set('name', 'Work');
  controller.setGeometry([0, 0], 100);
  set('lat', '91');
  await submit();
  expect(request).not.toHaveBeenCalled();
  set('lat', '0');
  await submit();
  expect(request).not.toHaveBeenCalled();
  // Two submit events while the request is pending still send only one POST.
  form.dispatchEvent(new document.defaultView!.Event('submit', { cancelable: true }));
  await submit();
  expect(request).toHaveBeenCalledTimes(1);
  expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toMatchObject({
    userId: 'CD',
    lat: '0',
    lon: '0',
    radius: '100',
  });
  expect(form.hidden).toBe(true);
});

test('server rejection preserves draft geometry and allows correction', async () => {
  const { byId, set, submit, request, form, controller } = setup();
  request.mockResolvedValueOnce(new Response('{}', { status: 422 }));
  byId('draw-start')!.click();
  set('name', 'Home');
  controller.setGeometry([1, 2], 30);
  await submit();
  await submit();
  expect(form.hidden).toBe(false);
  expect((form.elements.namedItem('radius') as HTMLInputElement).value).toBe('30');
  expect(byId('form-error')!.textContent).toContain('Check');
});

test('map placement is the default and manual coordinates are an explicit alternative', () => {
  const { byId, document, form, set, placementChanged, preview, request } = setup();
  byId('draw-start').click();
  const placement = byId('draw-placement') as unknown as HTMLSelectElement;
  const coordinates = byId('draw-coordinates') as unknown as { open: boolean };
  expect(placement.value).toBe('map');
  expect(coordinates.open).toBe(false);
  placement.value = 'coordinates';
  placement.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
  expect(coordinates.open).toBe(true);
  expect(placementChanged).toHaveBeenLastCalledWith('coordinates');
  set('lat', '42');
  set('lon', '-71');
  set('radius', '100');
  form.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
  expect(preview).toHaveBeenLastCalledWith([-71, 42], 100);
  placement.value = 'map';
  placement.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
  expect(placementChanged).toHaveBeenLastCalledWith('map');
  expect((form.elements.namedItem('lat') as HTMLInputElement).value).toBe('42');
  byId('draw-cancel').click();
  byId('draw-start').click();
  expect(placement.value).toBe('map');
  expect(coordinates.open).toBe(false);
  expect(request).not.toHaveBeenCalled();
});

test('moving the draft synchronizes coordinates, locks review, and saves only the final position', async () => {
  const { byId, form, controller, set, submit, preview, request } = setup();
  byId('draw-start').click();
  set('name', 'Home');
  controller.setGeometry([-71, 42], 250);
  // The draggable marker delivers its new centre through setGeometry.
  controller.setGeometry([-70.5, 42.5], 250);
  expect((form.elements.namedItem('lat') as HTMLInputElement).value).toBe('42.5');
  expect((form.elements.namedItem('lon') as HTMLInputElement).value).toBe('-70.5');
  expect(preview).toHaveBeenLastCalledWith([-70.5, 42.5], 250);
  await submit();
  controller.setGeometry([0, 0], 1);
  expect((form.elements.namedItem('lat') as HTMLInputElement).value).toBe('42.5');
  expect(request).not.toHaveBeenCalled();
  byId('draw-back').click();
  controller.setGeometry([-70, 43], 250);
  await submit();
  await submit();
  expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toMatchObject({
    lat: '43',
    lon: '-70',
    radius: '250',
  });
});
