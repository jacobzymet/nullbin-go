// The delete page: /d/<id>#<delete token>.

import { ApiError, deletePaste } from './api.ts';
import { announce, busy, el, reveal, show, showProblem, showSection } from './dom.ts';
import { parseTokenFragment } from './link.ts';

export function initDelete(id: string, fragment: string): void {
  const token = parseTokenFragment(fragment);
  if (!token) {
    // Before v0.2.6 a delete link held only the token, which looks exactly
    // like a share link's key; those are refused so a key is never sent.
    if (/^#[A-Za-z0-9_-]{43}$/.test(fragment)) {
      showProblem('This delete link is from an older version', 'Delete links made before this server was updated can no longer be used here, so that a share link can never be mistaken for one. The paste still expires on its own.');
      return;
    }
    showProblem('This delete link is incomplete', fragment.length <= 1
      ? 'The code that allows deleting is the end of the link, after the #, and it’s missing. Nullbin removes it from the address bar as soon as the page opens, so reloading the page or copying the address loses it. Use the full delete link you got when the paste was created.'
      : 'The code that allows deleting is the end of the link, after the #, and it’s damaged. Use the full delete link you got when the paste was created.');
    return;
  }
  showSection('delete');
  const button = el<HTMLButtonElement>('delete-confirm');
  el('delete-title').focus();
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    const done = busy(button, 'Deleting…');
    const error = el('delete-error');
    show(error, false);
    try {
      await deletePaste(id, token);
      show(el('delete-ask'), false);
      reveal(el('delete-done'));
      el('delete-done').querySelector<HTMLElement>('h2')?.focus();
      announce('Paste deleted.');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        showProblem('Nothing to delete', 'The paste is already gone (expired, deleted or opened), or this delete link is wrong.');
      } else {
        error.textContent = e instanceof ApiError && e.status === 409
          ? 'The paste is busy. Try again in a moment.'
          : 'The paste could not be deleted. Check your connection and try again.';
        show(error);
      }
    } finally {
      done();
    }
  });
}
