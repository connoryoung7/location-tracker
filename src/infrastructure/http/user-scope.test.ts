import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Window, type HTMLButtonElement, type HTMLSelectElement } from 'happy-dom';
import {
  guardStaleResponses,
  rememberUserSelection,
  responseUserId,
  restoreUserSelection,
  syncUserActions,
  updateUserSelect,
  USER_STORAGE_KEY,
  watchUserScope,
} from '@/../public/user-scope.js';
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
/** The real page shell, without and with a user named in the URL. */
let page: string;
let pageForAB: string;

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
  const { port } = server.address() as { port: number };
  page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  pageForAB = await (await fetch(`http://127.0.0.1:${port}/?user=AB`)).text();
});

afterAll(() => {
  server.close();
});

/** A Storage stand-in, so tests never depend on happy-dom's own. */
function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  };
}

function setup({ markup = page, url = 'http://localhost/' } = {}) {
  const window = new Window({ url });
  const document = window.document;
  // Parse the actual page markup; remote scripts are not executed.
  document.body.innerHTML = markup;
  const select = document.getElementById('user-select') as unknown as HTMLSelectElement;
  return { window, document, select };
}

describe('updateUserSelect', () => {
  test('no users disables the select with an empty state', () => {
    const { document, select } = setup();

    updateUserSelect(document, []);

    expect(select.disabled).toBe(true);
    expect(select.value).toBe('');
    expect(select.options[0]!.textContent).toBe('No tracked users yet');
  });

  test('a sole user is selected automatically, and the page is told', () => {
    const { document, select } = setup();
    const changed = mock(() => {});
    select.addEventListener('change', changed);

    updateUserSelect(document, ['AB']);

    expect(select.value).toBe('AB');
    expect(select.disabled).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  test('several users need an explicit choice, which later polls keep', () => {
    const { document, select } = setup();
    const changed = mock(() => {});

    updateUserSelect(document, ['CD', 'AB']);
    expect(select.value).toBe('');
    expect([...select.options].map((option) => option.value)).toEqual(['', 'AB', 'CD']);

    select.value = 'CD';
    select.addEventListener('change', changed);
    updateUserSelect(document, ['AB', 'CD', 'EF']);

    expect(select.value).toBe('CD');
    expect(changed).not.toHaveBeenCalled();
  });

  test('a selected user who disappears falls back, and the page is told', () => {
    const { document, select } = setup();
    updateUserSelect(document, ['AB', 'CD']);
    select.value = 'CD';
    const changed = mock(() => {});
    select.addEventListener('change', changed);

    updateUserSelect(document, ['AB', 'EF']);

    expect(select.value).toBe('');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  test('a user who is not offered falls back to the given user before the placeholder', () => {
    // As for `/?user=ZZ` with CD remembered: ZZ is rendered, then the poll arrives.
    const { document, select } = setup({ markup: pageForAB.replaceAll('AB', 'ZZ') });
    const changed = mock(() => {});
    select.addEventListener('change', changed);

    updateUserSelect(document, ['AB', 'CD'], { fallback: 'CD' });
    expect(select.value).toBe('CD');
    expect(changed).toHaveBeenCalledTimes(1);

    // A fallback who doesn't exist either is ignored.
    select.value = 'AB';
    updateUserSelect(document, ['CD', 'EF'], { fallback: 'XX' });
    expect(select.value).toBe('');
  });

  test('user IDs are text, never markup', () => {
    const { document, select } = setup();

    updateUserSelect(document, ['<img src=x onerror=alert(1)>', 'AB']);

    expect(document.querySelector('img')).toBeNull();
    expect([...select.options].map((option) => option.value)).toContain(
      '<img src=x onerror=alert(1)>',
    );
  });
});

describe('restoreUserSelection', () => {
  test('a user named in the URL wins over the remembered one', () => {
    const { document, select } = setup({ markup: pageForAB });
    const storage = memoryStorage({ [USER_STORAGE_KEY]: 'CD' });

    // The remembered user is still reported, to fall back to if AB turns out not to exist.
    expect(restoreUserSelection(document, { storage })).toEqual({
      userId: 'AB',
      source: 'url',
      remembered: 'CD',
    });
    expect(select.value).toBe('AB');
    expect(select.disabled).toBe(false);
  });

  test('without one, the last user picked in this browser is restored, enabled', () => {
    const { document, select } = setup();
    const storage = memoryStorage({ [USER_STORAGE_KEY]: 'CD' });

    expect(restoreUserSelection(document, { storage })).toEqual({
      userId: 'CD',
      source: 'storage',
      remembered: 'CD',
    });
    expect(select.value).toBe('CD');
    // htmx leaves disabled fields out of requests.
    expect(select.disabled).toBe(false);
  });

  test('with neither, nothing is selected and the select waits for the poll', () => {
    const { document, select } = setup();

    expect(restoreUserSelection(document, { storage: memoryStorage() })).toEqual({
      userId: '',
      source: 'none',
      remembered: '',
    });
    expect(select.disabled).toBe(true);
  });

  test('storage that throws is treated as empty', () => {
    const { document } = setup();
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
    };

    expect(restoreUserSelection(document, { storage }).source).toBe('none');
  });
});

describe('rememberUserSelection', () => {
  test('puts the user in the URL without adding history, and remembers it here', () => {
    const { window, document } = setup({ url: 'http://localhost/?keep=1' });
    const storage = memoryStorage();
    const historyLength = window.history.length;

    rememberUserSelection(document, 'A B', { storage });

    expect(window.location.search).toBe('?keep=1&user=A+B');
    expect(window.history.length).toBe(historyLength);
    expect(storage.values.get(USER_STORAGE_KEY)).toBe('A B');
  });

  test('no user removes it from both', () => {
    const { window, document } = setup({ url: 'http://localhost/?user=AB' });
    const storage = memoryStorage({ [USER_STORAGE_KEY]: 'AB' });

    rememberUserSelection(document, '', { storage });

    expect(window.location.search).toBe('');
    expect(storage.values.has(USER_STORAGE_KEY)).toBe(false);
  });

  test('storage that throws still updates the URL', () => {
    const { window, document } = setup();
    const storage = {
      setItem: () => {
        throw new Error('quota');
      },
    };

    rememberUserSelection(document, 'AB', { storage });

    expect(window.location.search).toBe('?user=AB');
  });
});

test('syncUserActions disables every user action until a user is selected', () => {
  const { document } = setup();
  const actions = () =>
    [
      ...document.querySelectorAll('[data-user-submit], #draw-start'),
    ] as unknown as HTMLButtonElement[];
  // Review area, Recompute events, Find places, List areas, and Add area.
  expect(actions()).toHaveLength(5);

  syncUserActions(document, 'AB');
  for (const button of actions()) expect(button.disabled).toBe(false);

  syncUserActions(document, '');
  for (const button of actions()) expect(button.disabled).toBe(true);
});

describe('watchUserScope', () => {
  function watch({ isDraftOpen = false, confirms = true, isSaving = false } = {}) {
    const context = setup();
    const { document, select, window } = context;
    updateUserSelect(document, ['AB', 'CD']);
    select.value = 'AB';
    let draftOpen = isDraftOpen;
    let saving = isSaving;
    const discardDraft = mock(() => {
      draftOpen = false;
    });
    const confirmSwitch = mock(async (_next: string) => confirms);
    const onChange = mock((_userId: string) => {});
    const onSwitchBlocked = mock((_next: string) => {});
    watchUserScope(document, {
      isDraftOpen: () => draftOpen,
      discardDraft,
      confirmSwitch,
      onChange,
      isSwitchBlocked: () => saving,
      onSwitchBlocked,
    });
    const finishSaving = () => {
      saving = false;
      draftOpen = false;
    };
    // Stands in for htmx, which reloads the panels on `change from:#user-scope`.
    const panelsReloaded = mock(() => {});
    document.getElementById('user-scope')!.addEventListener('change', panelsReloaded);
    const pick = (userId: string) => {
      select.value = userId;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return {
      ...context,
      discardDraft,
      confirmSwitch,
      onChange,
      onSwitchBlocked,
      finishSaving,
      panelsReloaded,
      pick,
      settle,
    };
  }

  test('while an area is saving, a switch is refused outright', () => {
    const {
      pick,
      select,
      onChange,
      onSwitchBlocked,
      confirmSwitch,
      discardDraft,
      panelsReloaded,
      finishSaving,
    } = watch({ isDraftOpen: true, isSaving: true });

    pick('CD');

    // Not even asked: the save belongs to AB and must finish first.
    expect(select.value).toBe('AB');
    expect(onSwitchBlocked).toHaveBeenCalledWith('CD');
    expect(confirmSwitch).not.toHaveBeenCalled();
    expect(discardDraft).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(panelsReloaded).not.toHaveBeenCalled();

    // Once it has saved, the same switch goes through.
    finishSaving();
    pick('CD');
    expect(onChange).toHaveBeenCalledWith('CD');
  });

  test('without a draft, a switch goes straight through', () => {
    const { pick, onChange, confirmSwitch, panelsReloaded } = watch();

    pick('CD');

    expect(onChange).toHaveBeenCalledWith('CD');
    expect(panelsReloaded).toHaveBeenCalledTimes(1);
    expect(confirmSwitch).not.toHaveBeenCalled();
  });

  test('with a draft open, a declined switch keeps the user and reloads nothing', async () => {
    const { pick, select, onChange, confirmSwitch, discardDraft, panelsReloaded, settle } = watch({
      isDraftOpen: true,
      confirms: false,
    });

    pick('CD');
    // Reverted while the question is open, so the page never shows CD.
    expect(select.value).toBe('AB');
    await settle();

    expect(confirmSwitch).toHaveBeenCalledWith('CD');
    expect(select.value).toBe('AB');
    expect(discardDraft).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(panelsReloaded).not.toHaveBeenCalled();
  });

  test('with a draft open, a confirmed switch discards the draft first', async () => {
    const { pick, select, onChange, discardDraft, panelsReloaded, settle } = watch({
      isDraftOpen: true,
      confirms: true,
    });

    pick('CD');
    await settle();

    expect(discardDraft).toHaveBeenCalledTimes(1);
    expect(select.value).toBe('CD');
    expect(onChange).toHaveBeenCalledWith('CD');
    expect(panelsReloaded).toHaveBeenCalledTimes(1);
    expect(discardDraft.mock.invocationCallOrder[0]!).toBeLessThan(
      onChange.mock.invocationCallOrder[0]!,
    );
  });

  test('a draft for a user the poll no longer lists is discarded without asking', () => {
    const { document, onChange, confirmSwitch, discardDraft } = watch({ isDraftOpen: true });

    updateUserSelect(document, ['CD']);

    expect(confirmSwitch).not.toHaveBeenCalled();
    expect(discardDraft).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('CD');
  });
});

describe('guardStaleResponses', () => {
  /** Replays the two htmx events a request goes through, as htmx dispatches them. */
  function requestLifecycle() {
    const context = setup();
    const { document, select, window } = context;
    updateUserSelect(document, ['AB', 'CD']);
    select.value = 'AB';
    guardStaleResponses(document);
    const panel = document.getElementById('areas')!;
    const send = () => {
      const xhr: { responseText?: string } = {};
      panel.dispatchEvent(
        new window.CustomEvent('htmx:beforeRequest', { bubbles: true, detail: { xhr } }),
      );
      return xhr;
    };
    /** `responseText` is what the server answered; omitted, it has no data block. */
    const swapAllowed = (xhr: { responseText?: string }, responseText?: string) => {
      if (responseText !== undefined) xhr.responseText = responseText;
      const detail = { xhr, shouldSwap: true };
      panel.dispatchEvent(new window.CustomEvent('htmx:beforeSwap', { bubbles: true, detail }));
      return detail.shouldSwap;
    };
    return { ...context, send, swapAllowed };
  }

  const areasFragmentFor = (userId: string) =>
    `<ul class="area-names"></ul><script type="application/json" id="areas-data">${JSON.stringify({ userId })}</script>`;

  test('drops a response whose own data names another user, whatever sent it', () => {
    const { select, send, swapAllowed } = requestLifecycle();
    select.value = 'CD';

    // E.g. a Delete still showing for one of AB's areas, clicked after picking CD:
    // the request is sent with CD selected, but the answer is AB's areas.
    expect(swapAllowed(send(), areasFragmentFor('AB'))).toBe(false);
    expect(swapAllowed(send(), areasFragmentFor('CD'))).toBe(true);
  });

  test('swaps in a response for the user it was requested for', () => {
    const { send, swapAllowed } = requestLifecycle();

    expect(swapAllowed(send())).toBe(true);
  });

  test('drops a response that arrives after the user changed', () => {
    const { select, send, swapAllowed } = requestLifecycle();

    // E.g. a delete of one of AB's areas, still running when the viewer picks CD.
    const forAB = send();
    select.value = 'CD';
    const forCD = send();

    expect(swapAllowed(forAB)).toBe(false);
    expect(swapAllowed(forCD)).toBe(true);
  });

  test("leaves alone a response it didn't see the request for", () => {
    const { swapAllowed } = requestLifecycle();

    expect(swapAllowed({})).toBe(true);
  });
});

describe('responseUserId', () => {
  const block = (id: string, json: string) =>
    `<p>…</p><script type="application/json" id="${id}">${json}</script>`;

  test("reads the user from any panel's data block", () => {
    expect(responseUserId(block('areas-data', '{"userId":"AB","bounds":[1,2,3,4]}'))).toBe('AB');
    expect(responseUserId(block('events-data', '{"userId":"CD"}'))).toBe('CD');
    expect(responseUserId(block('places-data', '{"userId":"EF"}'))).toBe('EF');
  });

  test('a prompt shown before anyone is selected is for no user', () => {
    expect(responseUserId(block('events-data', 'null'))).toBe('');
    expect(responseUserId(block('areas-data', '{"userId":""}'))).toBe('');
  });

  test('reads a user whose ID was <-escaped for the script block', () => {
    expect(responseUserId(block('areas-data', '{"userId":"\\u003c/script>"}'))).toBe('</script>');
  });

  test('a fragment without a data block, or with a broken one, names nobody', () => {
    expect(responseUserId('<p class="notice">Could not reach the area store.</p>')).toBeUndefined();
    expect(responseUserId(block('areas-data', '{not json'))).toBeUndefined();
    expect(responseUserId(undefined)).toBeUndefined();
  });
});
