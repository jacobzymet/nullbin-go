// The delete page: /d/<id>#<delete token>.

import { ApiError, deletePaste } from './api.ts';
import { announce, busy, el, reveal, show, showProblem, showSection } from './dom.ts';
import { parseTokenFragment } from './link.ts';

export function initDelete(id: string, fragment: string): void {
  const token = parseTokenFragment(fragment);
  if (!token) {
    showProblem('This delete link is incomplete', 'The part after # is missing or damaged. Use the full delete link you got when the paste was created.');
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
