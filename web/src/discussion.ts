// The discussion under a password-protected paste. Comments are encrypted
// in the browser (comments.ts); the server stores opaque blobs and checks
// only the comment token derived from the link key and password.

import { ApiError, fetchComments, postComment } from './api.ts';
import { buildThread, decryptComment, encryptComment, type Comment, type ThreadNode } from './comments.ts';
import type { DiscussionKeys } from './crypto.ts';
import { announce, busy, el, icon, relativeTime, reveal, show, toast } from './dom.ts';
import { PasteError } from './format.ts';
import { loadSodium } from './sodium.ts';


export function initDiscussion(pasteId: string, keys: DiscussionKeys): void {
  const list = el<HTMLOListElement>('comment-list');
  const form = el<HTMLFormElement>('comment-form');
  const name = el<HTMLInputElement>('comment-name');
  const text = el<HTMLTextAreaElement>('comment-text');
  const submit = el<HTMLButtonElement>('comment-submit');
  const refresh = el<HTMLButtonElement>('comments-refresh');
  const replyBar = el('reply-bar');
  const error = el('comment-error');
  const loadError = el('comments-error');
  let posting = false;
  let loading: Promise<void> | null = null;
  let comments: Comment[] = [];
  let replyTo: Comment | null = null;

  const setReply = (c: Comment | null) => {
    if (posting) return;
    replyTo = c;
    el('reply-name').textContent = c ? displayName(c) : '';
    show(replyBar, c !== null);
    if (c) {
      text.focus();
      form.scrollIntoView({ block: 'nearest' });
    }
  };
  el('reply-cancel').addEventListener('click', () => {
    setReply(null);
    text.focus();
  });

  const render = () => {
    const roots = buildThread(comments);
    list.replaceChildren(...roots.map((n) => renderNode(n, setReply)));
    const n = comments.length;
    el('comment-count').textContent = n ? String(n) : '';
    el('comments-empty').textContent = 'No comments yet.';
    show(el('comments-empty'), n === 0);
  };

  const loadComments = async (quiet: boolean) => {
    const done = busy(refresh, 'Refreshing…');
    show(loadError, false);
    try {
      const sodium = await loadSodium();
      const blobs = await fetchComments(pasteId, keys.token);
      const ok: Comment[] = [];
      for (const b of blobs) {
        const c = decryptComment(sodium, keys.key, pasteId, b);
        if (c) ok.push(c);
      }
      comments = ok;
      const hidden = blobs.length - ok.length;
      const note = el('comments-hidden');
      note.textContent =
        hidden === 0 ? '' : `${hidden} ${hidden === 1 ? 'comment' : 'comments'} could not be verified with this paste’s key and ${hidden === 1 ? 'is' : 'are'} hidden.`;
      show(note, hidden > 0);
      render();
      if (!quiet) announce(`${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}.`);
    } catch (e) {
      loadError.textContent =
        e instanceof ApiError && e.status === 404 ? 'This discussion is no longer available.' : 'Comments could not be loaded. Try Refresh.';
      show(loadError);
    } finally {
      done();
    }
  };

  const load = async (quiet = false) => {
    // A post must fetch a fresh list even if an earlier refresh is in flight.
    if (loading) await loading;
    loading = loadComments(quiet);
    try {
      await loading;
    } finally {
      loading = null;
    }
  };

  refresh.addEventListener('click', () => void load());

  text.addEventListener('input', () => {
    text.classList.remove('is-invalid');
    text.setAttribute('aria-invalid', 'false');
    show(error, false);
  });

  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (posting) return;
    show(error, false);
    text.classList.remove('is-invalid');
    if (text.value.trim() === '') {
      text.classList.add('is-invalid');
      text.setAttribute('aria-invalid', 'true');
      error.textContent = 'Write a comment before posting.';
      show(error);
      text.focus();
      return;
    }
    const controls = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input, textarea, button')];
    const disabled = controls.map((control) => control.disabled);
    const done = busy(submit, 'Posting…');
    controls.forEach((control) => (control.disabled = true));
    form.setAttribute('aria-busy', 'true');
    posting = true;
    try {
      const sodium = await loadSodium();
      const { bytes, comment } = encryptComment(sodium, keys.key, pasteId, {
        parent: replyTo?.id ?? null,
        name: name.value,
        text: text.value,
      });
      await postComment(pasteId, keys.token, bytes as Uint8Array<ArrayBuffer>);
      text.value = '';
      replyTo = null;
      el('reply-name').textContent = '';
      show(replyBar, false);
      await load(true);
      toast('Comment posted');
      document.getElementById(`c-${comment.id}`)?.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      error.textContent = describe(e);
      show(error);
    } finally {
      posting = false;
      form.removeAttribute('aria-busy');
      done();
      controls.forEach((control, i) => (control.disabled = disabled[i] ?? false));
      text.focus();
    }
  });

  reveal(el('comments'));
  void load(true);
}

function displayName(c: Comment): string {
  return c.name || 'Anonymous';
}

function renderNode(node: ThreadNode, onReply: (c: Comment) => void): HTMLLIElement {
  const c = node.comment;
  const li = document.createElement('li');
  li.className = 'nb-comment';
  li.id = `c-${c.id}`;

  const head = document.createElement('div');
  head.className = 'nb-comment-head';
  const avatar = document.createElement('span');
  avatar.className = `nb-avatar ${c.name ? `nb-av-${hash(c.name) % 6}` : ''}`;
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = c.name ? [...c.name][0]!.toUpperCase() : '?';
  const who = document.createElement('span');
  who.className = 'nb-comment-name';
  who.textContent = displayName(c); // never innerHTML
  const when = document.createElement('time');
  when.className = 'nb-meta';
  when.dateTime = new Date(c.time).toISOString();
  when.title = new Date(c.time).toLocaleString();
  when.textContent = relativeTime(c.time);
  head.append(avatar, who, when);

  const body = document.createElement('p');
  body.className = 'nb-comment-text';
  body.textContent = c.text; // never innerHTML

  const reply = document.createElement('button');
  reply.type = 'button';
  reply.className = 'btn btn-link btn-sm nb-link-btn';
  reply.append(icon('reply'), document.createTextNode('Reply'));
  reply.setAttribute('aria-label', `Reply to ${displayName(c)}`);
  reply.addEventListener('click', () => onReply(c));

  li.append(head, body, reply);
  if (node.replies.length > 0) {
    // Always nested in the markup; CSS stops indenting after a few levels.
    const ol = document.createElement('ol');
    ol.className = 'nb-thread nb-replies';
    ol.append(...node.replies.map((r) => renderNode(r, onReply)));
    li.append(ol);
  }
  return li;
}

/** A small stable number from a name, to pick an avatar colour. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function describe(e: unknown): string {
  if (e instanceof PasteError) return e.message;
  if (e instanceof ApiError) {
    if (e.status === 404) return 'This discussion is no longer available.';
    if (e.status === 429) return 'You’re commenting too quickly. Wait a moment.';
    if (e.status === 409) return 'This discussion is full.';
    if (e.status === 413) return 'This comment is too long.';
  }
  return 'The comment could not be posted. Try again.';
}
