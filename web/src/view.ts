// The view page: fetch the ciphertext as a stream, ask for a password if
// the paste has one, decrypt frame by frame, show text with textContent and
// offer the file as a download (never as a preview).

import { ApiError, fetchBurnPrefix, fetchPaste } from './api.ts';
import { CloneableAttachment, MAX_BUFFERED_DOWNLOAD } from './attachments.ts';
import { burnAccessToken, deriveKey, openPaste, type OpenedPaste } from './crypto.ts';
import { initDiscussion } from './discussion.ts';
import { hasHiddenChars, stripHiddenChars } from './hidden.ts';
import {
  Progress,
  announce,
  bindCopy,
  bindReveal,
  busy,
  chip,
  el,
  formatBytes,
  reveal,
  show,
  showProblem,
  showSection,
} from './dom.ts';
import { ByteReader, PasteError, parsePrefix } from './format.ts';
import { downloadBlob as download } from './files.ts';
import { initReaderActions, type CloneAttachment } from './reader-actions.ts';
import { parseKeyFragment } from './link.ts';
import { loadSodium } from './sodium.ts';

// The File System Access API is not in TypeScript's DOM types yet.
interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
}

/** Bound both line layout and character shaping for attacker-written text. */
export const MAX_PREVIEW_LINES = 5000;
export const MAX_PREVIEW_CHARS = 100_000;

export { hasHiddenChars };

/** Count without splitting millions of lines into a large temporary array. */
export function textPreview(text: string): { text: string; lines: number; truncated: boolean } {
  let lines = 1;
  let end = Math.min(text.length, MAX_PREVIEW_CHARS);
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10 || i === text.length - 1) continue;
    lines++;
    if (lines === MAX_PREVIEW_LINES + 1) end = Math.min(end, i > 0 && text.charCodeAt(i - 1) === 13 ? i - 1 : i);
  }
  // Avoid splitting a UTF-16 surrogate pair at the character limit.
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return { text: text.slice(0, end), lines, truncated: end < text.length };
}

export async function initView(id: string, fragment: string): Promise<void> {
  showSection('view');
  const sodium = await loadSodium();
  const parsed = parseKeyFragment(sodium, fragment);
  if (!parsed) {
    showProblem(
      'This link is incomplete',
      'The part after # is missing or damaged. It holds the key, so the paste can’t be opened without it. Ask the sender for the full link.',
    );
    return;
  }
  if (parsed.burn) {
    const gate = el('gate-burn');
    reveal(gate);
    const button = el<HTMLButtonElement>('burn-open');
    el('burn-title').focus(); // announce the warning; the next Tab reaches the button
    await new Promise<void>((resolve) => button.addEventListener('click', () => resolve(), { once: true }));
    show(gate, false);
  }
  await open(id, parsed.key, parsed.burn, `${window.location.origin}/p/${id}${fragment}`);
}

async function open(id: string, key: Uint8Array, burn: boolean, shareURL: string): Promise<void> {
  const sodium = await loadSodium();
  const progress = new Progress('view');
  const stage = el('view-stage');
  reveal(el('view-progress'));
  stage.textContent = 'Downloading';
  progress.set(0, '');
  let opened: OpenedPaste;
  let asked = false;
  let reader: ByteReader | null = null;
  let password: string | null = null;
  let readsRemaining = 0;
  try {
    let download;
    if (burn) {
      // Fetch only the public salt/flags; no ciphertext is consumed until
      // the reader proves knowledge of the link key and any password.
      const prefix = parsePrefix(await fetchBurnPrefix(id));
      for (let attempt = 0; ; attempt++) {
        if (prefix.password) {
          asked = true;
          password = await askPassword(attempt);
          // Nothing has been requested yet, so cancelling uses up no open.
          if (password === null) throw new PasteError('cancelled', 'Cancelled.');
        }
        const master = prefix.password ? deriveKey(sodium, key, password!, prefix.salt) : key.slice();
        const token = burnAccessToken(sodium, master);
        sodium.memzero(master);
        try {
          download = await fetchPaste(id, token);
          break;
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 404 || !prefix.password) throw e;
          // A missing/consumed paste stops here; an incorrect password may
          // be retried while the unconsumed paste still exists.
          await fetchBurnPrefix(id);
        }
      }
    } else {
      download = await fetchPaste(id);
    }
    const { body, size } = download;
    readsRemaining = download.readsRemaining ?? 0;
    reader = new ByteReader(body, (received) => {
      if (size > 0) progress.set(received / size, `${formatBytes(received)} of ${formatBytes(size)}`);
    });
    window.addEventListener('pagehide', () => { void reader?.cancel(); }, { once: true });
    opened = await openPaste(sodium, reader, key, (attempt) => {
      if (password !== null && attempt === 0) return Promise.resolve(password);
      asked = true;
      return askPassword(attempt);
    });
  } catch (e) {
    await reader?.cancel();
    showFailure(e);
    return;
  } finally {
    password = null;
    sodium.memzero(key);
  }
  show(el('gate-password'), false);
  show(el('view-progress'), false);

  const { meta } = opened;
  const chips: HTMLLIElement[] = [];
  if (burn) {
    const remaining = chip(readsRemaining === 0 ? 'Burned' : `${readsRemaining.toLocaleString()} ${readsRemaining === 1 ? 'open' : 'opens'} left`, 'flame', 'warn');
    remaining.title = 'Remaining opens when this paste was opened. Other readers may use them.';
    chips.push(remaining);
  }
  if (asked) chips.push(chip('Password', 'lock'));
  if (meta.discussion) chips.push(chip('Discussion', 'chat', 'accent'));
  if (opened.file) chips.push(chip('1 file', 'file'));
  el('view-chips').replaceChildren(...chips);
  show(el('burned-note'), burn && readsRemaining === 0);

  if (meta.text.length > 0 || !opened.file) renderText(meta.text);
  const attachment = opened.file ? renderFile(opened.file, meta.filename, meta.size, meta.mime, () => reader!.cancel()) : null;
  initReaderActions(meta.text, shareURL, !burn || readsRemaining > 0, attachment);
  reveal(el('view-content'));
  el('view-title').focus();
  announce(opened.file ? 'Paste decrypted. A file is attached.' : 'Paste decrypted.');

  if (opened.discussion) initDiscussion(id, opened.discussion);
}

function renderText(text: string): void {
  const box = el('view-text');
  const preview = textPreview(text);
  const lines = preview.text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // a trailing newline is not a line
  const rows = document.createDocumentFragment();
  lines.forEach((line, i) => {
    const row = document.createElement('div');
    row.className = 'nb-row';
    const ln = document.createElement('span');
    ln.className = 'nb-ln';
    ln.setAttribute('aria-hidden', 'true');
    ln.textContent = String(i + 1);
    const lc = document.createElement('span');
    lc.className = 'nb-lc';
    lc.textContent = line; // never innerHTML
    row.append(ln, lc);
    rows.append(row);
  });
  box.replaceChildren(rows);
  box.classList.add('nb-text-reveal');
  const bytes = new TextEncoder().encode(text).length;
  el('view-text-meta').textContent = `${preview.lines.toLocaleString()} ${preview.lines === 1 ? 'line' : 'lines'} · ${formatBytes(bytes)}`;
  show(el('view-text-truncated'), preview.truncated);
  show(el('view-text-hidden'), hasHiddenChars(text));

  const wrap = el<HTMLButtonElement>('wrap-toggle');
  wrap.addEventListener('click', () => {
    const on = box.classList.toggle('nb-wrap');
    wrap.setAttribute('aria-pressed', String(on));
  });
  bindCopy(el<HTMLButtonElement>('text-copy'), () => text, 'Text copied');
  reveal(el('view-text-card'));
}

function renderFile(file: AsyncGenerator<Uint8Array>, filename: string | null, size: number, mime: string | null, cancel: () => Promise<void>): CloneAttachment {
  // Show the name that will be saved, so bidi controls cannot disguise it.
  el('view-filename').textContent = safeFilename(filename);
  el('view-filesize').textContent = formatBytes(size);
  el('view-mime').textContent = mime ? stripHiddenChars(mime) || 'type not given' : 'type not given';
  const save = el<HTMLButtonElement>('save-file');
  const clone = el<HTMLButtonElement>('view-clone');
  const attachment = new CloneableAttachment(file, safeFilename(filename), size, mime ?? '');
  let savedFile: File | null = null;
  // Called directly from the click so the browser allows the save dialog.
  save.addEventListener('click', () => {
    if (save.disabled) return;
    const done = busy(save, 'Saving…');
    clone.disabled = true;
    saveFile(attachment.stream(), safeFilename(filename), size, (localFile) => { savedFile = localFile; }).then(
      (saved) => {
        done();
        clone.disabled = !attachment.canClone && savedFile === null;
        if (!clone.disabled) clone.title = 'Copy the text and verified attachment to a new draft.';
        if (!saved) {
          return;
        }
        show(save, false);
        reveal(el('file-saved'));
        el('file-saved').focus();
        announce('The file was decrypted, verified and saved.');
      },
      (e: unknown) => {
        done();
        clone.disabled = !attachment.canClone && savedFile === null;
        void cancel();
        // Keep the page (and any text) visible; only the file failed.
        show(save, false);
        const err = el('file-error');
        err.textContent =
          e instanceof PasteError
            ? `${e.message} The file was not saved.`
            : 'The file could not be saved. If the save dialog was closed, open the link again.';
        reveal(err);
        err.focus();
      },
    );
  });
  reveal(el('view-file-card'));
  return {
    available: attachment.canClone,
    load: async () => {
      save.disabled = true;
      try { return savedFile ?? await attachment.clone(); }
      catch (e) { void cancel(); throw e; }
      finally { save.disabled = false; }
    },
  };
}

/** Shows the password gate and resolves with what the reader enters, or null if they cancel. */
function askPassword(attempt: number): Promise<string | null> {
  const form = el<HTMLFormElement>('gate-password');
  const input = el<HTMLInputElement>('view-password');
  show(el('view-progress'), false);
  if (attempt === 0) {
    reveal(form);
    bindReveal(el<HTMLButtonElement>('view-password-reveal'), input);
    input.addEventListener('input', () => {
      input.classList.remove('is-invalid');
      input.setAttribute('aria-invalid', 'false');
    });
  } else {
    show(form);
  }
  input.classList.toggle('is-invalid', attempt > 0);
  input.setAttribute('aria-invalid', String(attempt > 0));
  input.value = '';
  input.focus();
  return new Promise((resolve) => {
    const listeners = new AbortController();
    const onSubmit = (ev: SubmitEvent) => {
      ev.preventDefault();
      const value = input.value;
      if (value === '') {
        input.focus();
        return;
      }
      listeners.abort();
      input.value = '';
      show(form, false);
      el('view-stage').textContent = 'Unlocking';
      reveal(el('view-progress'));
      // Let the status paint before Argon2id blocks the page.
      setTimeout(() => resolve(value), 60);
    };
    const onCancel = () => {
      listeners.abort();
      input.value = '';
      show(form, false);
      resolve(null);
    };
    form.addEventListener('submit', onSubmit, { signal: listeners.signal });
    el('view-password-cancel').addEventListener('click', onCancel, { signal: listeners.signal });
  });
}

/**
 * Writes the decrypted file to disk. With the File System Access API the
 * data goes to a temporary swap file that is only committed (close()) after
 * the whole stream has been verified; on any error it is aborted. Otherwise
 * the file is assembled in memory and offered as a download only after
 * verification. Returns false if the user cancelled the save dialog.
 */
async function saveFile(file: AsyncGenerator<Uint8Array>, name: string, size: number, verifiedFile: (file: File) => void): Promise<boolean> {
  const w = window as Window & SaveFilePickerWindow;
  if (typeof w.showSaveFilePicker === 'function') {
    let handle: FileSystemFileHandle;
    try {
      handle = await w.showSaveFilePicker({ suggestedName: name });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return false;
      return saveWithBlob(file, name, size);
    }
    const writable = await handle.createWritable();
    try {
      for await (const chunk of file) await writable.write(chunk as Uint8Array<ArrayBuffer>);
      await writable.close();
    } catch (e) {
      await writable.abort().catch(() => {});
      throw e;
    }
    // A user-saved File can be cloned in bounded slices even above the RAM cap.
    try { verifiedFile(await handle.getFile()); } catch { /* saving already succeeded */ }
    return true;
  }
  return saveWithBlob(file, name, size);
}

/** Browsers without streaming-to-disk support have a strict RAM bound. */
export { MAX_BUFFERED_DOWNLOAD } from './attachments.ts';

async function saveWithBlob(file: AsyncGenerator<Uint8Array>, name: string, size: number): Promise<boolean> {
  if (size > MAX_BUFFERED_DOWNLOAD) throw new PasteError('too-large', 'Saving files above 64 MiB requires a browser with streaming file saves, such as desktop Chrome or Edge.');
  let received = 0;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for await (const chunk of file) {
    received += chunk.length;
    if (received > MAX_BUFFERED_DOWNLOAD) throw new PasteError('too-large', 'The file is too large to buffer in this browser.');
    parts.push(chunk as Uint8Array<ArrayBuffer>);
  }
  // Fully verified at this point. Offer it as an opaque download.
  download(new Blob(parts, { type: 'application/octet-stream' }), name);
  return true;
}

/**
 * A download name without path separators, control characters or bidi
 * controls (which can make "invoice\u202Efdp.exe" display as "invoiceexe.pdf").
 */
export function safeFilename(name: string | null): string {
  const cleaned = (name ?? '')
    .replace(/[\p{Cf}\p{Cc}/\\:*?"<>|]/gu, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  return cleaned.slice(0, 200) || 'download';
}

function showFailure(e: unknown): void {
  if (e instanceof ApiError && e.status === 404) {
    showProblem('This paste doesn’t exist', 'It may have expired or been deleted. If it burns after reading, someone has already opened it.');
    return;
  }
  if (e instanceof PasteError) {
    switch (e.code) {
      case 'cancelled':
        showProblem('Not opened', 'You cancelled before the paste was unlocked. Open the link again to enter the password.');
        return;
      case 'wrong-key':
        showProblem('This paste can’t be decrypted', 'The key in the link doesn’t match. Check that you copied the whole link, including everything after #.');
        return;
      case 'network':
        showProblem('The download stopped', 'Check your connection, then open the link again.');
        return;
      case 'truncated':
      case 'tampered':
      case 'format':
        showProblem('This paste is damaged', `${e.message} Nothing from the damaged part was shown or saved.`);
        return;
      default:
        showProblem('This paste can’t be opened', e.message);
        return;
    }
  }
  showProblem('This paste can’t be opened', 'Something went wrong while opening it. Try the link again.');
}
