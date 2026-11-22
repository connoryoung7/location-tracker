/**
 * The page-wide user selector. The whole page shows one user at a time, and this
 * module owns which one: it fills the header's select from the user poll, picks
 * the user the page opens on, remembers the choice, and guards switching away
 * from a half-drawn area. Fragments and forms read the user by including the
 * `#user-scope` form, so they never keep a selection of their own.
 */

/** `localStorage` key for the last user picked in this browser. */
export const USER_STORAGE_KEY = 'location-tracker:user';

/** Query parameter that names the selected user, e.g. `/?user=AB`. */
export const USER_QUERY_PARAM = 'user';

function selectOf(root) {
  return root.getElementById('user-select');
}

function hasOption(select, value) {
  return [...select.options].some((option) => option.value === value);
}

/** Storage can be missing or throw (private windows, blocked site data); treat that as empty. */
function readStoredUser(storage) {
  try {
    return storage?.getItem(USER_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeStoredUser(storage, userId) {
  try {
    if (userId) storage?.setItem(USER_STORAGE_KEY, userId);
    else storage?.removeItem(USER_STORAGE_KEY);
  } catch {
    // Remembering the user is a convenience; the URL still carries it.
  }
}

function defaultStorage(root) {
  try {
    return root.defaultView.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Refreshes the select's options from the user poll without discarding the
 * current choice. A choice that is no longer offered falls back to `fallback`
 * if that user exists, then to the sole user, then to the "Select a user"
 * placeholder; either way a `change` event tells the rest of the page.
 */
export function updateUserSelect(root, users, { fallback = '' } = {}) {
  const select = selectOf(root);
  const previous = select.value;
  const options = [...new Set(users)].sort();

  select.replaceChildren();
  const placeholder = root.createElement('option');
  placeholder.value = '';
  placeholder.textContent = options.length ? 'Select a user' : 'No tracked users yet';
  select.append(placeholder);
  for (const user of options) {
    const option = root.createElement('option');
    // textContent, not markup: user IDs are untrusted.
    option.value = user;
    option.textContent = user;
    select.append(option);
  }

  select.value = options.includes(previous)
    ? previous
    : options.includes(fallback)
      ? fallback
      : options.length === 1
        ? options[0]
        : '';
  select.disabled = options.length === 0;
  if (select.value !== previous) {
    select.dispatchEvent(new root.defaultView.Event('change', { bubbles: true }));
  }
}

/**
 * Picks the user the page opens on, before the first fragments load. The server
 * has already selected `?user=` in the markup; without one, this restores the
 * last user picked in this browser.
 *
 * Returns where the choice came from, so the caller can say so if the poll
 * later shows that user doesn't exist, and the remembered user even when the
 * URL won, to fall back to in that case. It has to be read now: the fallback
 * itself changes the selection, which overwrites what is remembered.
 */
export function restoreUserSelection(root, { storage = defaultStorage(root) } = {}) {
  const select = selectOf(root);
  const stored = readStoredUser(storage);
  if (select.value) {
    return { userId: select.value, source: 'url', remembered: stored };
  }

  if (!stored) {
    return { userId: '', source: 'none', remembered: '' };
  }

  const option = root.createElement('option');
  option.value = stored;
  option.textContent = stored;
  select.append(option);
  select.value = stored;
  // htmx leaves disabled fields out of requests, so the select must be enabled
  // for the first fragment loads to carry the user.
  select.disabled = false;
  return { userId: stored, source: 'storage', remembered: stored };
}

/**
 * Remembers the selection in the URL and in this browser. `replaceState`
 * rather than `pushState`, so switching users doesn't fill the back button.
 */
export function rememberUserSelection(root, userId, { storage = defaultStorage(root) } = {}) {
  const window = root.defaultView;
  const url = new URL(window.location.href);
  if (userId) url.searchParams.set(USER_QUERY_PARAM, userId);
  else url.searchParams.delete(USER_QUERY_PARAM);
  if (url.href !== window.location.href) {
    window.history.replaceState(window.history.state, '', url.href);
  }
  writeStoredUser(storage, userId);
}

/**
 * Every action that works on "the user" is disabled while none is selected:
 * the `data-user-submit` buttons and starting a new area.
 */
export function syncUserActions(root, userId) {
  for (const button of root.querySelectorAll('[data-user-submit]')) {
    button.disabled = !userId;
  }
  root.getElementById('draw-start').disabled = !userId;
}

/**
 * Calls `onChange` whenever the selected user changes, after first asking
 * before a switch would discard an open area draft.
 *
 * Listens in the capture phase so a declined switch can be stopped before htmx,
 * which listens on the `#user-scope` form, reloads anything. A change made by
 * the poll because the old user no longer exists is never asked about: there
 * is nobody left to save the draft for, so the draft is simply discarded.
 */
export function watchUserScope(root, { isDraftOpen, discardDraft, confirmSwitch, onChange }) {
  const select = selectOf(root);
  let current = select.value;

  root.addEventListener(
    'change',
    (event) => {
      if (event.target !== select) return;
      const next = select.value;
      if (next === current) return;

      if (isDraftOpen() && hasOption(select, current)) {
        event.stopPropagation();
        const previous = current;
        select.value = previous;
        confirmSwitch(next).then((isConfirmed) => {
          // Only act if nothing else changed the selection while the dialog was open.
          if (!isConfirmed || select.value !== previous) return;
          discardDraft();
          select.value = next;
          select.dispatchEvent(new root.defaultView.Event('change', { bubbles: true }));
        });
        return;
      }

      if (isDraftOpen()) discardDraft();
      current = next;
      onChange(next);
    },
    true,
  );
}
