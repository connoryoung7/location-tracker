import { describe, expect, test } from 'bun:test';
import { Window, type HTMLElement } from 'happy-dom';
import { setNotice, toneForStatus, toneFromResponses } from '@/../public/notices.js';

function setup() {
  const window = new Window({ url: 'http://localhost/' });
  const document = window.document;
  document.body.innerHTML = `
    <p id="recompute-result" class="notice" data-tone="info" role="status"></p>
    <p id="user-status" class="notice" data-tone="info" role="status"></p>`;
  const byId = (id: string) => document.getElementById(id) as unknown as HTMLElement;
  return { window, document, byId };
}

/** Raises `htmx:afterSwap` as htmx does after swapping a response into `target`. */
function raiseAfterSwap({ window }: ReturnType<typeof setup>, target: HTMLElement, status: number) {
  target.dispatchEvent(
    new window.CustomEvent('htmx:afterSwap', {
      bubbles: true,
      detail: { target, xhr: { status } },
    }),
  );
}

describe('setNotice', () => {
  test('sets the text and tone together', () => {
    const { byId } = setup();
    const status = byId('user-status');

    setNotice(status, 'error', 'Could not load users. Retrying…');

    expect(status.dataset.tone).toBe('error');
    expect(status.textContent).toBe('Could not load users. Retrying…');
  });

  test('switches back from error to info, and an empty message clears the text', () => {
    const { byId } = setup();
    const status = byId('user-status');
    setNotice(status, 'error', 'Could not load users. Retrying…');

    setNotice(status, 'info', '');

    expect(status.dataset.tone).toBe('info');
    expect(status.textContent).toBe('');
  });
});

describe('toneForStatus', () => {
  test.each([
    [200, 'success'],
    [204, 'success'],
    [302, 'success'],
    [400, 'error'],
    [422, 'error'],
    [503, 'error'],
  ])('%i is %s', (status, tone) => {
    expect(toneForStatus(status)).toBe(tone);
  });
});

describe('toneFromResponses', () => {
  test('a successful recompute turns the result green', () => {
    const context = setup();
    toneFromResponses(context.document, 'recompute-result');
    const result = context.byId('recompute-result');

    raiseAfterSwap(context, result, 200);

    expect(result.dataset.tone).toBe('success');
  });

  test.each([422, 503])('a %i answer turns the result red', (status) => {
    const context = setup();
    toneFromResponses(context.document, 'recompute-result');
    const result = context.byId('recompute-result');

    raiseAfterSwap(context, result, status);

    expect(result.dataset.tone).toBe('error');
  });

  test('swaps into other targets leave their tone alone', () => {
    const context = setup();
    toneFromResponses(context.document, 'recompute-result');
    const other = context.byId('user-status');

    raiseAfterSwap(context, other, 503);

    expect(other.dataset.tone).toBe('info');
  });
});
