import { beforeAll, afterAll, expect, test, mock } from 'bun:test';
import {
  Window,
  type HTMLFormElement,
  type HTMLInputElement,
  type HTMLSelectElement,
  type HTMLElement,
} from 'happy-dom';
import { createAreaForm } from '@/../public/area-form.js';
import { syncUserActions, updateUserSelect } from '@/../public/user-scope.js';
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
  updateUserSelect(document, users);
  // As app.js does: Add area and the submit button wait for a selected user.
  syncUserActions(document, (document.getElementById('user-select') as HTMLSelectElement).value);
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const form = byId('draw-form') as unknown as HTMLFormElement;
  const set = (key: string, value: string) => {
    (form.elements.namedItem(key) as HTMLInputElement).value = value;
  };
  /** Picks the page-wide user in the header, as the viewer would. */
  const pickUser = (userId: string) => {
    (byId('user-select') as unknown as HTMLSelectElement).value = userId;
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
    pickUser,
    submit,
  };
}

test('the draft form has no user select of its own', () => {
  const { form } = setup();

  expect(form.elements.namedItem('userId')).toBeNull();
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
  updateUserSelect(document, ['AB', 'CD']);
  expect(byId('draw-confirmation')!.hidden).toBe(false);
  byId('draw-back')!.click();
  expect((form.elements.namedItem('lat') as HTMLInputElement).value).toBe('43');
  await submit();
  byId('draw-cancel')!.click();
  expect(form.hidden).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

test('invalid geometry is rejected and only final confirmation persists the page-wide user once', async () => {
  const { byId, document, set, pickUser, submit, request, form, controller } = setup(['AB', 'CD']);
  pickUser('CD');
  byId('draw-start')!.click();
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

const PROPOSAL = { userId: 'AB', name: 'Fresh Market', lat: '42.37', lon: '-71.04', radius: '100' };

test('a proposed place opens at review with its circle and saves only once confirmed', async () => {
  const { byId, document, form, submit, request, preview, placementChanged, saved, controller } =
    setup();

  const proposal = controller.propose(PROPOSAL);

  expect(form.hidden).toBe(false);
  expect(byId('draw-start').hidden).toBe(true);
  expect(placementChanged).toHaveBeenLastCalledWith('coordinates');
  expect(preview).toHaveBeenLastCalledWith([-71.04, 42.37], 100);
  expect(byId('draw-confirmation').hidden).toBe(false);
  expect(byId('draw-summary').textContent).toContain('Fresh Market — User: AB');
  expect(document.activeElement).toBe(byId('draw-submit'));
  expect(request).not.toHaveBeenCalled();

  await submit();

  expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual(PROPOSAL);
  expect(saved).toHaveBeenCalledTimes(1);
  expect(await proposal).toBe(true);
});

test('an unnamed place waits for a name, and cancelling saves nothing', async () => {
  const { byId, document, form, request, controller } = setup();

  const proposal = controller.propose({ ...PROPOSAL, name: '' });

  expect(byId('draw-fields').hidden).toBe(false);
  expect(byId('draw-confirmation').hidden).toBe(true);
  expect(document.activeElement).toBe(form.elements.namedItem('name') as unknown as HTMLElement);
  expect((form.elements.namedItem('radius') as HTMLInputElement).value).toBe('100');

  byId('draw-cancel').click();

  expect(await proposal).toBe(false);
  expect(form.hidden).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

test('a new proposal replaces the previous one', async () => {
  const { form, controller } = setup();

  const first = controller.propose(PROPOSAL);
  controller.propose({ ...PROPOSAL, name: 'Gym', lat: '40' });

  expect(await first).toBe(false);
  expect((form.elements.namedItem('name') as HTMLInputElement).value).toBe('Gym');
  expect((form.elements.namedItem('lat') as HTMLInputElement).value).toBe('40');
});

test('the review shows the page-wide user, and a changed user is reviewed again, not saved', async () => {
  const { byId, set, pickUser, submit, request, controller } = setup(['AB', 'CD']);
  pickUser('AB');
  byId('draw-start').click();
  set('name', 'Home');
  controller.setGeometry([-71, 42], 250);

  await submit();
  expect(byId('draw-summary').textContent).toContain('User: AB');

  // Nothing the viewer reviewed was for CD, so confirming must not save it.
  pickUser('CD');
  await submit();
  expect(request).not.toHaveBeenCalled();
  expect(byId('draw-summary').textContent).toContain('User: CD');

  await submit();
  expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toMatchObject({ userId: 'CD' });
});

test("discard can't interrupt a save, so the save can't later close another draft", async () => {
  const { byId, form, set, submit, request, controller, saved } = setup();
  let respond!: (response: Response) => void;
  request.mockImplementationOnce(() => new Promise<Response>((resolve) => (respond = resolve)));
  byId('draw-start').click();
  set('name', 'Home');
  controller.setGeometry([-71, 42], 250);
  await submit();
  await submit();

  // The POST is on its way.
  expect(controller.isSaving()).toBe(true);
  controller.discard();
  expect(form.hidden).toBe(false);

  respond(new Response('{}', { status: 201 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(controller.isSaving()).toBe(false);
  expect(form.hidden).toBe(true);
  expect(saved).toHaveBeenCalledTimes(1);
});

test('isOpen and discard let a user switch throw the draft away', () => {
  const { byId, form, set, controller, preview, request } = setup();
  expect(controller.isOpen()).toBe(false);

  byId('draw-start').click();
  set('name', 'Home');
  controller.setGeometry([-71, 42], 250);
  expect(controller.isOpen()).toBe(true);

  controller.discard();

  expect(controller.isOpen()).toBe(false);
  expect(form.hidden).toBe(true);
  expect((form.elements.namedItem('name') as HTMLInputElement).value).toBe('');
  expect(preview).toHaveBeenLastCalledWith(null, 0);
  expect(request).not.toHaveBeenCalled();
});

test('a place found for anyone but the page-wide user is not proposed', async () => {
  const { form, pickUser, controller } = setup(['AB', 'CD']);
  pickUser('CD');

  expect(await controller.propose(PROPOSAL)).toBe(false);
  expect(form.hidden).toBe(true);
});

test('a user switch discarding a proposed draft reports it as abandoned', async () => {
  const { form, controller, request } = setup();

  const proposal = controller.propose(PROPOSAL);
  controller.discard();

  expect(await proposal).toBe(false);
  expect(form.hidden).toBe(true);
  expect(request).not.toHaveBeenCalled();
});
