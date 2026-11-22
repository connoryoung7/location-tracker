/**
 * Status lines in the sidebar (`.notice`). Each carries a `data-tone` of
 * `info`, `success` or `error`, which the stylesheet turns into its colour; an
 * empty notice is hidden by CSS, so clearing the text is how one is dismissed.
 */

/** Sets a notice's text and tone. An empty message hides it. */
export function setNotice(element, tone, message) {
  element.dataset.tone = tone;
  element.textContent = message;
}

/** The tone for a response by HTTP status: anything below 400 succeeded. */
export function toneForStatus(status) {
  return status < 400 ? 'success' : 'error';
}

/**
 * Tones a notice from the status of each htmx response swapped into it. Needed
 * where an endpoint answers 4xx/5xx with plain text into the same target as a
 * success, such as recompute's 422/503.
 */
export function toneFromResponses(root, targetId) {
  root.body.addEventListener('htmx:afterSwap', (event) => {
    const { target, xhr } = event.detail;
    if (target?.id === targetId) {
      target.dataset.tone = toneForStatus(xhr.status);
    }
  });
}
