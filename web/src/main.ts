// Entry point. Reads the URL fragment once, removes it from the address bar
// right away, and shows the page that matches the path.

import { initCreate } from './create.ts';
import { el, show, showProblem } from './dom.ts';
import { initDelete } from './remove.ts';
import { initTheme } from './theme.ts';
import { initView } from './view.ts';
import { initWordmark } from './wordmark.ts';

const fragment = window.location.hash;
if (fragment) {
  // The key stays in memory only; the address bar and this history entry
  // no longer contain it.
  history.replaceState(null, '', window.location.pathname + window.location.search);
}
// A new link pasted into this tab that differs only in its fragment does
// not load a new page; reload so it is handled from scratch. The "Skip to
// content" link changes the fragment too, but must never reload: that would
// throw away a delete link shown only once, or an opened paste.
window.addEventListener('hashchange', () => {
  if (window.location.hash === '#main') {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    el('main').focus();
    return;
  }
  window.location.reload();
});

initWordmark();
initTheme();
show(el('loading'), false);

const path = window.location.pathname;
const view = /^\/p\/([0-9a-f]{32})$/.exec(path);
const del = /^\/d\/([0-9a-f]{32})$/.exec(path);

if (path === '/') {
  initCreate();
} else if (view?.[1]) {
  initView(view[1], fragment).catch(() => showProblem('This paste can’t be opened', 'Something went wrong while opening it. Try the link again.'));
} else if (del?.[1]) {
  initDelete(del[1], fragment);
} else {
  showProblem('Page not found', 'This address doesn’t match any page. Check the link, or create a new paste.');
}
