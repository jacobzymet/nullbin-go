// The delete page: /d/<id>#<delete token>. For a paste with separate links,
// it also lists each link's opens and can revoke links one by one.

import { ApiError, deletePaste, fetchRecipients, revokeRecipient, type RecipientState } from './api.ts';
import { announce, busy, el, reveal, show, showProblem, showSection } from './dom.ts';
import { parseDeleteFragment } from './link.ts';

export function initDelete(id: string, fragment: string): void {
  const parsed = parseDeleteFragment(fragment);
  if (!parsed) {
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
  const { token } = parsed;
  showSection('delete');
  const button = el<HTMLButtonElement>('delete-confirm');
  el('delete-title').focus();
  // A paste with separate links (its delete link says so) lists them. If
  // that fails, the list stays hidden: the delete prompt covers the rest.
  if (parsed.recipients) {
    fetchRecipients(id, token).then((list) => { if (!deleted) renderRecipients(id, token, list); }, (e: unknown) => {
      // A paste that is gone is covered by the delete prompt.
      if (deleted || (e instanceof ApiError && e.status === 404)) return;
      const error = el('recipients-error');
      error.textContent = 'The list of links could not be loaded. Open the delete link again to try again.';
      show(error);
      reveal(el('recipients-manage'));
    });
  }
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    const done = busy(button, 'Deleting…');
    const error = el('delete-error');
    show(error, false);
    try {
      await deletePaste(id, token);
      showDeleted();
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

let deleted = false;

function showDeleted(): void {
  deleted = true;
  show(el('delete-ask'), false);
  show(el('recipients-manage'), false);
  reveal(el('delete-done'));
  el('delete-done').querySelector<HTMLElement>('h2')?.focus();
}

function renderRecipients(id: string, token: string, list: RecipientState[]): void {
  const error = el('recipients-error');
  el('recipient-status').replaceChildren(...list.map((r, i) => {
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'nb-recipient-num';
    num.textContent = `Link ${i + 1}`;
    const state = document.createElement('span');
    state.className = 'nb-recipient-state';
    state.textContent = describe(r);
    li.append(num, state);
    const usedUp = r.maxOpens !== null && r.opens >= r.maxOpens;
    if (r.revoked || usedUp) return li;
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'btn nb-btn-secondary';
    revoke.textContent = 'Revoke';
    revoke.setAttribute('aria-label', `Revoke link ${i + 1}`);
    revoke.addEventListener('click', async () => {
      if (revoke.disabled) return;
      const done = busy(revoke, 'Revoking…');
      show(error, false);
      try {
        await revokeRecipient(id, token, i);
        announce(`Link ${i + 1} revoked.`);
      } catch (e) {
        done();
        error.textContent = e instanceof ApiError && e.status === 409
          ? 'The paste is busy. Try again in a moment.'
          : e instanceof ApiError && e.status === 404
            ? 'The paste is already gone (expired or deleted).'
            : 'The link could not be revoked. Check your connection and try again.';
        show(error);
        return;
      }
      try {
        const list = await fetchRecipients(id, token);
        if (!deleted) renderRecipients(id, token, list);
      } catch (e) {
        // Revoking the last open link deletes the paste.
        if (e instanceof ApiError && e.status === 404) {
          showDeleted();
          return;
        }
        // It is revoked even if the list could not be fetched again.
        state.textContent = describe({ ...r, revoked: true });
        revoke.remove();
      }
    });
    li.append(revoke);
    return li;
  }));
  reveal(el('recipients-manage'));
}

function describe(r: RecipientState): string {
  const times = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'time' : 'times'}`;
  if (r.revoked) return `Revoked · opened ${times(r.opens)}`;
  // Opens of a link without a limit are counted up to 1,000.
  if (r.maxOpens === null) return `Opened ${r.opens >= 1000 ? '1,000 or more times' : times(r.opens)} · no limit`;
  return r.opens >= r.maxOpens ? `Used up · opened ${times(r.opens)}` : `Opened ${r.opens.toLocaleString()} of ${times(r.maxOpens)}`;
}
