import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Window, type HTMLDialogElement, type HTMLElement } from 'happy-dom';
import { createConfirmDialog } from '@/../public/confirm-dialog.js';
import { createAppServer } from '@/infrastructure/http/app-server.ts';
import {
  mockAreaEventRepository,
  mockAreaRepository,
  mockLogger,
  mockMetricsCollector,
} from '@/test/mocks.ts';
import type { Server } from 'node:http';

let server: Server;
/** The real page shell, so the dialog's markup and IDs can't drift from the tests. */
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
  const { port } = server.address() as { port: number };
  page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
});

afterAll(() => {
  server.close();
});

function setup() {
  const window = new Window({ url: 'http://localhost/' });
  const document = window.document;
  // Parse the actual page markup; remote scripts are not executed.
  document.body.innerHTML = page;
  const confirmDialog = createConfirmDialog(document);
  const dialog = document.getElementById('confirm-dialog') as unknown as HTMLDialogElement;
  const click = (id: string) => (document.getElementById(id) as unknown as HTMLElement).click();
  return { window, document, confirmDialog, dialog, click };
}

/** Raises `htmx:confirm` the way htmx does: from the triggering element, bubbling, cancelable. */
function raiseHtmxConfirm({ window, document }: ReturnType<typeof setup>, question: string | null) {
  const mockIssueRequest = mock((_skipConfirmation: boolean) => {});
  const event = new window.CustomEvent('htmx:confirm', {
    bubbles: true,
    cancelable: true,
    detail: { question, issueRequest: mockIssueRequest },
  });
  document.getElementById('recompute-form')!.dispatchEvent(event);
  return { event, mockIssueRequest };
}

describe('hx-confirm', () => {
  test('a request with a question opens the dialog showing it, and holds the request', () => {
    const context = setup();

    const { event, mockIssueRequest } = raiseHtmxConfirm(context, 'Replace history?');

    expect(event.defaultPrevented).toBe(true);
    expect(context.dialog.open).toBe(true);
    expect(context.document.getElementById('confirm-message')!.textContent).toBe(
      'Replace history?',
    );
    expect(mockIssueRequest).not.toHaveBeenCalled();
  });

  test('Confirm closes the dialog and issues the request, skipping a second prompt', () => {
    const context = setup();
    const { mockIssueRequest } = raiseHtmxConfirm(context, 'Replace history?');

    context.click('confirm-accept');

    expect(context.dialog.open).toBe(false);
    expect(mockIssueRequest).toHaveBeenCalledTimes(1);
    expect(mockIssueRequest).toHaveBeenCalledWith(true);
  });

  test('Cancel closes the dialog without issuing the request', () => {
    const context = setup();
    const { mockIssueRequest } = raiseHtmxConfirm(context, 'Replace history?');

    context.click('confirm-cancel');

    expect(context.dialog.open).toBe(false);
    expect(mockIssueRequest).not.toHaveBeenCalled();
  });

  test('Escape, which the browser turns into a plain close, does not issue the request', () => {
    const context = setup();
    const { mockIssueRequest } = raiseHtmxConfirm(context, 'Replace history?');

    context.dialog.close();

    expect(mockIssueRequest).not.toHaveBeenCalled();
  });

  test('a click on the backdrop dismisses without issuing the request', () => {
    const context = setup();
    const { mockIssueRequest } = raiseHtmxConfirm(context, 'Replace history?');

    // Pico's modal fills the viewport; a backdrop click targets the dialog itself.
    context.dialog.click();

    expect(context.dialog.open).toBe(false);
    expect(mockIssueRequest).not.toHaveBeenCalled();
  });

  test('a click inside the dialog box is not mistaken for the backdrop', () => {
    const context = setup();
    raiseHtmxConfirm(context, 'Replace history?');

    (context.document.getElementById('confirm-message') as unknown as HTMLElement).click();

    expect(context.dialog.open).toBe(true);
  });

  test('requests without hx-confirm pass straight through', () => {
    const context = setup();

    const { event, mockIssueRequest } = raiseHtmxConfirm(context, null);

    expect(event.defaultPrevented).toBe(false);
    expect(context.dialog.open).toBe(false);
    expect(mockIssueRequest).not.toHaveBeenCalled();
  });

  test('a dismissed question does not leak into the next one', () => {
    const context = setup();
    const first = raiseHtmxConfirm(context, 'First?');
    context.click('confirm-cancel');

    const second = raiseHtmxConfirm(context, 'Second?');
    context.click('confirm-accept');

    expect(first.mockIssueRequest).not.toHaveBeenCalled();
    expect(second.mockIssueRequest).toHaveBeenCalledTimes(1);
  });
});

describe('ask', () => {
  test('resolves true when confirmed', async () => {
    const { confirmDialog, click } = setup();

    const answer = confirmDialog.ask('Switch user?');
    click('confirm-accept');

    expect(await answer).toBe(true);
  });

  test('resolves false when dismissed', async () => {
    const { confirmDialog, click } = setup();

    const answer = confirmDialog.ask('Switch user?');
    click('confirm-cancel');

    expect(await answer).toBe(false);
  });

  test('renders the question as text, never markup', () => {
    const { confirmDialog, document } = setup();

    confirmDialog.ask('Delete "<img src=x onerror=alert(1)>"?');

    const message = document.getElementById('confirm-message')!;
    expect(message.querySelector('img')).toBeNull();
    expect(message.textContent).toBe('Delete "<img src=x onerror=alert(1)>"?');
  });
});
