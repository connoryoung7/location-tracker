import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Window, type HTMLButtonElement, type HTMLSelectElement } from 'happy-dom';
import {
  rememberUserSelection,
  restoreUserSelection,
  syncUserActions,
  updateUserSelect,
  USER_STORAGE_KEY,
  watchUserScope,
} from '@/../public/user-scope.js';
import { createAppServer } from '@/infrastructure/http/app-server.ts';
import {
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
  function watch({ isDraftOpen = false, confirms = true } = {}) {
    const context = setup();
    const { document, select, window } = context;
    updateUserSelect(document, ['AB', 'CD']);
    select.value = 'AB';
    let draftOpen = isDraftOpen;
    const discardDraft = mock(() => {
      draftOpen = false;
    });
    const confirmSwitch = mock(async (_next: string) => confirms);
    const onChange = mock((_userId: string) => {});
    watchUserScope(document, {
      isDraftOpen: () => draftOpen,
      discardDraft,
      confirmSwitch,
      onChange,
    });
    // Stands in for htmx, which reloads the panels on `change from:#user-scope`.
    const panelsReloaded = mock(() => {});
    document.getElementById('user-scope')!.addEventListener('change', panelsReloaded);
    const pick = (userId: string) => {
      select.value = userId;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { ...context, discardDraft, confirmSwitch, onChange, panelsReloaded, pick, settle };
  }

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
