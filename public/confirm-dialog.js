/**
 * A styled replacement for the browser's native `confirm()`, used for every
 * `hx-confirm` and for questions the page asks itself.
 *
 * Every way of dismissing it (Cancel, Escape, or a click on the backdrop) ends
 * in the dialog's `close` event, which runs the question's `onDismiss`. For an
 * `hx-confirm`, htmx waits until `issueRequest` is called, so a dismissed
 * question simply never sends its request.
 */
export function createConfirmDialog(root) {
  const dialog = root.getElementById('confirm-dialog');
  const message = root.getElementById('confirm-message');
  const accept = root.getElementById('confirm-accept');
  let pending = null;

  function open(question, onAccept, onDismiss = () => {}) {
    pending = { onAccept, onDismiss };
    // textContent: questions can quote area names, which are untrusted.
    message.textContent = question;
    dialog.showModal();
    accept.focus();
  }

  /** Resolves true if the question is confirmed, false if it is dismissed. */
  function ask(question) {
    return new Promise((resolve) => {
      open(
        question,
        () => resolve(true),
        () => resolve(false),
      );
    });
  }

  root.body.addEventListener('htmx:confirm', (event) => {
    // htmx raises this for every request; only those with `hx-confirm` ask anything.
    if (!event.detail.question) return;
    event.preventDefault();
    const { detail } = event;
    open(detail.question, () => detail.issueRequest(true));
  });

  accept.addEventListener('click', () => {
    const question = pending;
    // Cleared first, so the close handler below doesn't treat this as a dismissal.
    pending = null;
    dialog.close();
    question?.onAccept();
  });

  root.getElementById('confirm-cancel').addEventListener('click', () => dialog.close());

  // Pico's modal fills the viewport, so a click that lands on the dialog itself is the backdrop.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  dialog.addEventListener('close', () => {
    const question = pending;
    pending = null;
    question?.onDismiss();
  });

  return { open, ask };
}
