import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import {
  Window,
  type HTMLFormElement,
  type HTMLInputElement,
  type HTMLSelectElement,
  type HTMLElement,
} from 'happy-dom';
import { createAreaForm, NEW_CATEGORY, updateCategorySelect } from '@/../public/area-form.js';
import { syncUserActions, updateUserSelect } from '@/../public/user-scope.js';
import { createAppServer } from '@/infrastructure/http/app-server.ts';
import {
  mockAreaCategoryRepository,
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
    areaCategories: mockAreaCategoryRepository(),
    areaEvents: mockAreaEventRepository(),
    users: { listUserIds: async () => [] },
    logger: mockLogger(),
    metrics: mockMetricsCollector(),
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  page = await (
    await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
  ).text();
});
afterAll(() => {
  server.close();
});

const CATEGORIES = [
  { id: 'gym', name: 'Gym', color: 'blue' },
  { id: 'work', name: 'Work', color: 'orange' },
];

/** The real page, with AB selected and their categories loaded, as app.js leaves it. */
function setup() {
  const window = new Window();
  const document = window.document;
  document.body.innerHTML = page;
  const request = mock(
    async (_url: string, _options: RequestInit) => new Response('{}', { status: 201 }),
  );
  const controller = createAreaForm(document, {
    preview: () => {},
    saved: () => {},
    started: () => {},
    cancelled: () => {},
    request,
  });
  updateUserSelect(document, ['AB']);
  syncUserActions(document, 'AB');
  updateCategorySelect(document, CATEGORIES);

  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const form = byId('draw-form') as unknown as HTMLFormElement;
  const category = byId('draw-category') as unknown as HTMLSelectElement;
  const set = (key: string, value: string) => {
    (form.elements.namedItem(key) as HTMLInputElement).value = value;
  };
  const choose = (value: string) => {
    category.value = value;
    category.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const submit = async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /** Opens a draft with a valid circle, ready to review. */
  const draft = (name = 'Pool') => {
    byId('draw-start').click();
    set('name', name);
    controller.setGeometry([-71, 42], 250);
  };
  const sent = () => JSON.parse(request.mock.calls[0]![1]!.body as string);
  return { document, byId, form, category, choose, submit, draft, sent, request, controller };
}

describe('updateCategorySelect', () => {
  test('offers None, each category by name, and New category…', () => {
    const { category } = setup();

    expect([...category.options].map((option) => [option.value, option.textContent])).toEqual([
      ['', 'None'],
      ['gym', 'Gym'],
      ['work', 'Work'],
      [NEW_CATEGORY, 'New category…'],
    ]);
  });

  test('keeps the choice across refreshes, and falls back to None when it is deleted', () => {
    const { document, category } = setup();
    category.value = 'work';

    updateCategorySelect(document, CATEGORIES);
    expect(category.value).toBe('work');

    updateCategorySelect(document, [CATEGORIES[0]!]);
    expect(category.value).toBe('');
  });

  test('category names are text, never markup', () => {
    const { document, category } = setup();

    updateCategorySelect(document, [
      { id: 'x', name: '<img src=x onerror=alert(1)>', color: 'blue' },
    ]);

    expect(document.querySelector('img')).toBeNull();
    expect(category.options[1]!.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('choosing a category for a draft', () => {
  test('an existing category is sent by ID and named in the review', async () => {
    const { byId, choose, submit, draft, sent } = setup();
    draft();
    choose('gym');

    await submit();
    expect(byId('draw-summary').textContent).toContain('Category: Gym');
    await submit();

    expect(sent()).toMatchObject({ name: 'Pool', categoryId: 'gym' });
    expect(sent()).not.toHaveProperty('categoryName');
  });

  test('None sends no category', async () => {
    const { byId, submit, draft, sent } = setup();
    draft();

    await submit();
    expect(byId('draw-summary').textContent).toContain('Category: None');
    await submit();

    expect(sent()).not.toHaveProperty('categoryId');
    expect(sent()).not.toHaveProperty('categoryName');
  });

  test('New category… asks for a name, which is required and sent trimmed', async () => {
    const { byId, choose, submit, draft, sent, request } = setup();
    draft();
    const label = byId('draw-category-name-label');
    const nameInput = byId('draw-category-name') as unknown as HTMLInputElement;
    expect(label.hidden).toBe(true);

    choose(NEW_CATEGORY);
    expect(label.hidden).toBe(false);
    expect(nameInput.required).toBe(true);

    // Without a name it can't go to review.
    await submit();
    expect(byId('draw-confirmation').hidden).toBe(true);

    nameInput.value = '  Swimming  ';
    await submit();
    expect(byId('draw-summary').textContent).toContain('Category: Swimming (new)');
    await submit();

    expect(request).toHaveBeenCalledTimes(1);
    expect(sent()).toMatchObject({ categoryName: 'Swimming' });
    expect(sent()).not.toHaveProperty('categoryId');
  });

  test('cancelling resets the category to None and hides the name field', () => {
    const { byId, category, choose, draft } = setup();
    draft();
    choose(NEW_CATEGORY);

    byId('draw-cancel').click();
    byId('draw-start').click();

    expect(category.value).toBe('');
    expect(byId('draw-category-name-label').hidden).toBe(true);
  });

  test('a category deleted while reviewing sends the draft back for review, not saved', async () => {
    const { document, byId, choose, submit, draft, request } = setup();
    draft();
    choose('work');
    await submit();

    // An areas refresh after Work was deleted elsewhere.
    updateCategorySelect(document, [CATEGORIES[0]!]);
    await submit();

    expect(request).not.toHaveBeenCalled();
    expect(byId('draw-summary').textContent).toContain('Category: None');
  });

  test('a visited place proposed as an area starts with no category', async () => {
    const { category, choose, draft, controller } = setup();
    draft();
    choose('gym');
    controller.discard();

    void controller.propose({ userId: 'AB', name: 'Market', lat: '42', lon: '-71', radius: '80' });

    expect(category.value).toBe('');
  });

  test("editing an area hides the category and sends none, so the area's own is kept", async () => {
    const { byId, submit, sent, request, controller, choose, draft } = setup();
    // A category chosen in an abandoned draft must not leak into the edit.
    draft();
    choose('gym');

    controller.editArea({
      userId: 'AB',
      areaId: 'a1',
      name: 'Home',
      lat: '42',
      lon: '-71',
      radius: '100',
    });
    expect(byId('draw-category-label').hidden).toBe(true);
    expect(byId('draw-category-name-label').hidden).toBe(true);

    await submit();
    expect(byId('draw-summary').textContent).not.toContain('Category');
    await submit();
    expect(request.mock.calls[0]![0]).toBe('/areas/AB/a1');
    expect(sent()).toEqual({ name: 'Home', lat: '42', lon: '-71', radius: '100' });

    // Back to drafting, the Category select is offered again.
    byId('draw-start').click();
    expect(byId('draw-category-label').hidden).toBe(false);
  });
});
