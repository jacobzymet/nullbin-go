// The view page: fetch the ciphertext as a stream, ask for a password if
// the paste has one, decrypt frame by frame, show text with textContent and
// offer downloads and explicitly requested, fully authenticated previews.

import { ApiError, fetchBurnPrefix, fetchPaste } from './api.ts';
import { CloneableAttachment, MAX_BUFFERED_DOWNLOAD } from './attachments.ts';
import { burnAccessToken, deriveKey, openPaste, recipientAccessToken, type OpenedPaste } from './crypto.ts';
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
  formatCountdown,
  reveal,
  show,
  showProblem,
  showSection,
  startCountdown,
} from './dom.ts';
import { ByteReader, PasteError, parsePrefix } from './format.ts';
import { downloadBlob as download } from './files.ts';
import { initReaderActions, type CloneAttachment } from './reader-actions.ts';
import { parseKeyFragment } from './link.ts';
import { loadSodium } from './sodium.ts';
import { cleanFileName } from './zip.ts';
import { MAX_PREVIEW_BYTES } from './image.ts';
import { attachmentPreview, MAX_TEXT_PREVIEW_BYTES, type AttachmentPreview } from './attachment-preview.ts';
import { clearPreview, previewGeneration, showImage, showTextPreview } from './preview.ts';
import { textPreview } from './text-preview.ts';

// The File System Access API is not in TypeScript's DOM types yet.
interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
}

export { hasHiddenChars };
export { textPreview, MAX_PREVIEW_LINES, MAX_PREVIEW_CHARS } from './text-preview.ts';

export async function initView(id: string, fragment: string): Promise<void> {
  showSection('view');
  const sodium = await loadSodium();
  const parsed = parseKeyFragment(sodium, fragment);
  if (!parsed) {
    showProblem(
      'This link is incomplete',
      fragment.length <= 1
        ? 'The key that unlocks this paste is the end of the link, after the #, and it’s missing. Nullbin removes the key from the address bar as soon as a paste opens, so reloading the page or copying the address loses it. Open the original link again, or ask the sender for it.'
        : 'The key that unlocks this paste is the end of the link, after the #, and it’s damaged. Ask the sender for the full link.',
    );
    return;
  }
  if (parsed.burn) {
    const gate = el('gate-burn');
    if (parsed.recipient !== null) {
      el('burn-title').textContent = 'This link has a limited number of opens';
      el('burn-text').textContent = 'Opening uses one of this link’s allowed opens. Interrupted downloads also count.';
    }
    reveal(gate);
    const button = el<HTMLButtonElement>('burn-open');
    el('burn-title').focus(); // announce the warning; the next Tab reaches the button
    await new Promise<void>((resolve) => button.addEventListener('click', () => resolve(), { once: true }));
    show(gate, false);
  }
  await open(id, parsed.key, parsed.burn, parsed.recipient, `${window.location.origin}/p/${id}${fragment}`);
}

/**
 * Opens a paste. burn: the link has an open limit. recipient: the secret of
 * one of the paste's separate links, or null. Both kinds of link are opened
 * with a token that proves the reader knows the key and any password.
 */
async function open(id: string, key: Uint8Array, burn: boolean, recipient: Uint8Array | null, shareURL: string): Promise<void> {
  const sodium = await loadSodium();
  const progress = new Progress('view');
  const stage = el('view-stage');
  reveal(el('view-progress'));
  stage.textContent = 'Downloading';
  progress.set(0, '');
  let opened: OpenedPaste | undefined;
  let asked = false;
  let reader: ByteReader | null = null;
  let password: string | null = null;
  let readsRemaining = 0;
  // When the paste expires (Date.now() time), from the seconds left the
  // server reported, so a wrong computer clock does not matter.
  let deadline: number | null = null;
  let file: CloneableAttachment | null = null;
  try {
    let download;
    if (burn || recipient !== null) {
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
        const token = recipient !== null ? recipientAccessToken(sodium, master, recipient) : burnAccessToken(sodium, master);
        sodium.memzero(master);
        try {
          download = await fetchPaste(id, token, burn, recipient !== null);
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
    // A separate link without a limit has no count, whatever its link says.
    if (recipient !== null) burn = download.readsRemaining !== null;
    readsRemaining = download.readsRemaining ?? 0;
    if (download.expiresIn !== null) deadline = Date.now() + download.expiresIn * 1000;
    reader = new ByteReader(body, (received) => {
      if (size > 0) progress.set(received / size, `${formatBytes(received)} of ${formatBytes(size)}`);
    });
    window.addEventListener('pagehide', () => { void reader?.cancel(); file?.wipe(); });
    opened = await openPaste(sodium, reader, key, (attempt) => {
      if (password !== null && attempt === 0) return Promise.resolve(password);
      asked = true;
      return askPassword(attempt);
    });
    if (opened.file) {
      const { meta } = opened;
      file = new CloneableAttachment(opened.file, safeFilename(meta.filename), meta.size, meta.mime ?? '');
      // When the paste fits in memory, download and verify all of it before
      // showing anything. Otherwise the download would pause after the text
      // until the reader saves the file, which would tell the server that a
      // file is attached and roughly how long the text is. The choice uses
      // the size implied by the authenticated metadata (what the server
      // stores anyway), never a header the server could change.
      if (opened.blobSize <= MAX_BUFFERED_DOWNLOAD) {
        stage.textContent = 'Downloading';
        reveal(el('view-progress'));
        await file.verify();
      }
    }
  } catch (e) {
    if (opened?.discussion) sodium.memzero(opened.discussion.key);
    file?.wipe();
    await reader?.cancel();
    showFailure(e, burn);
    return;
  } finally {
    password = null;
    sodium.memzero(key);
    if (recipient !== null) sodium.memzero(recipient);
  }
  show(el('gate-password'), false);
  show(el('view-progress'), false);

  const { meta } = opened;
  const chips: HTMLLIElement[] = [];
  if (recipient !== null) {
    const own = chip('Your own link', 'users', 'accent');
    own.title = 'The sender made a separate link for each person. They can see how often this one was opened, and revoke it.';
    chips.push(own);
  }
  if (burn) {
    const remaining = chip(readsRemaining === 0 ? (recipient !== null ? 'No opens left' : 'Burned') : `${readsRemaining.toLocaleString()} ${readsRemaining === 1 ? 'open' : 'opens'} left`, 'flame', 'warn');
    remaining.title = recipient !== null
      ? 'Opens left on this link when it was opened.'
      : 'Remaining opens when this paste was opened. Other readers may use them.';
    chips.push(remaining);
  }
  if (asked) chips.push(chip('Password', 'lock'));
  if (meta.discussion) chips.push(chip('Discussion', 'chat', 'accent'));
  if (opened.file) chips.push(chip('1 file', 'file'));
  el('view-chips').replaceChildren(...chips);
  const burned = burn && readsRemaining === 0;
  if (burned && recipient !== null) {
    // Only this link is used up; the sender's other links may still open it.
    el('burned-note').querySelector('span')!.textContent = 'This link has now used all its opens and can’t open the paste again. Copy or save what you need before you leave this page.';
  }
  show(el('burned-note'), burned);
  // The time left comes from the server, which decides when to delete it.
  if (deadline !== null && !burned) {
    startCountdown(el('view-expires-text'), deadline, (left) => (left > 0 ? `Deleted from the server in ${formatCountdown(left)}` : 'Expired: deleted from the server'));
    show(el('view-expires'));
  }

  if (meta.text.length > 0 || !opened.file) renderText(meta.text);
  const attachment = file ? renderFile(file, meta.filename, meta.size, meta.mime, () => reader!.cancel()) : null;
  initReaderActions(meta.text, shareURL, !burn || readsRemaining > 0, attachment);
  if (file) {
    // Leaving the page wipes the attachment. If the browser restores the page
    // from its back/forward cache, keep the text but say the file is gone
    // and turn off what needs it, instead of leaving buttons that fail.
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      show(el('save-file'), false);
      show(el('image-show'), false);
      el<HTMLButtonElement>('view-clone').disabled = true;
      const err = el('file-error');
      err.textContent = `The attachment was cleared from memory when you left this page. ${burn ? 'This paste burns after reading, so it may no longer be available.' : 'Open the link again to get it.'}`;
      reveal(err);
    });
  }
  reveal(el('view-content'));
  el('view-title').focus();
  announce(opened.file ? 'Paste decrypted. A file is attached.' : 'Paste decrypted.');

  if (opened.discussion) initDiscussion(id, opened.discussion);
}

function renderText(text: string): void {
  const box = el('view-text');
  const preview = textPreview(text);
  const lines = preview.text.split(/\r\n?|\n/);
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

function renderFile(attachment: CloneableAttachment, filename: string | null, size: number, mime: string | null, cancel: () => Promise<void>): CloneAttachment {
  // Show the name that will be saved, so bidi controls cannot disguise it.
  el('view-filename').textContent = safeFilename(filename);
  el('view-filesize').textContent = formatBytes(size);
  el('view-mime').textContent = mime ? stripHiddenChars(mime) || 'type not given' : 'type not given';
  const save = el<HTMLButtonElement>('save-file');
  show(el('file-save-note'), typeof (window as Window & SaveFilePickerWindow).showSaveFilePicker === 'function');
  const clone = el<HTMLButtonElement>('view-clone');
  let savedFile: File | null = null;
  const imageShow = el<HTMLButtonElement>('image-show');
  // Called directly from the click so the browser allows the save dialog.
  save.addEventListener('click', () => {
    if (save.disabled) return;
    const done = busy(save, 'Saving…');
    clone.disabled = true;
    imageShow.disabled = true; // one reader of the attachment at a time
    saveFile(attachment.stream(), safeFilename(filename), size, (localFile) => { savedFile = localFile; }).then(
      (saved) => {
        done();
        imageShow.disabled = false;
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
        show(imageShow, false); // the attachment could not be read
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
  // Previews always read the verified copy held in memory (every previewable
  // size is kept), never the saved file on disk, which could have changed.
  initAttachmentPreview(imageShow, attachmentPreview(safeFilename(filename), mime, size), safeFilename(filename), async () => {
    const disabled = clone.disabled;
    save.disabled = true;
    clone.disabled = true;
    try { return await attachment.clone(); }
    catch (e) { void cancel(); throw e; }
    finally { save.disabled = false; clone.disabled = disabled; }
  });
  reveal(el('view-file-card'));
  return {
    available: attachment.canClone,
    load: async () => {
      save.disabled = true;
      imageShow.disabled = true;
      // The verified copy in memory when there is one (up to 64 MiB), not
      // the saved file on disk, which could have changed since.
      try { return attachment.canClone || !savedFile ? await attachment.clone() : savedFile; }
      catch (e) { void cancel(); throw e; }
      finally { save.disabled = false; imageShow.disabled = false; }
    },
  };
}

/**
 * The preview button. Nothing is decoded until the reader presses it, and
 * then only the complete, verified attachment.
 */
function initAttachmentPreview(button: HTMLButtonElement, kind: AttachmentPreview | null, name: string, load: () => Promise<File>): void {
  const note = el('image-note');
  const label = button.querySelector('span')!;
  const use = button.querySelector('use')!;
  const expanded = (on: boolean) => {
    button.setAttribute('aria-expanded', String(on));
    label.textContent = kind === 'image' ? (on ? 'Hide image' : 'Show image') : (on ? 'Hide preview' : 'Show preview');
    use.setAttribute('href', on ? '#i-eye-off' : '#i-eye');
  };
  const explain = (message: string) => {
    note.textContent = message;
    reveal(note);
  };
  expanded(false);
  show(button, kind !== null);
  button.addEventListener('click', async () => {
    if (button.disabled || kind === null) return;
    if (button.getAttribute('aria-expanded') === 'true') {
      clearPreview();
      expanded(false);
      return;
    }
    show(note, false);
    clearPreview();
    // Anything that clears previews while this one loads (Clone, leaving
    // the page) cancels it: nothing decrypted may reappear afterwards.
    const ticket = previewGeneration();
    const cancelled = () => ticket !== previewGeneration() || el('view').hidden;
    const done = busy(button, 'Loading…');
    let shown = false;
    try {
      const file = await load();
      if (file.size > (kind === 'image' ? MAX_PREVIEW_BYTES : MAX_TEXT_PREVIEW_BYTES)) throw new Error('too large');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (cancelled()) return;
      shown = kind === 'image' ? await showImage(bytes, name) : showTextPreview(bytes);
      if (cancelled()) { clearPreview(); return; }
      if (!shown) explain(kind === 'image' ? 'This file can’t be shown as an image. You can still save it.' : 'This file can’t be shown as text. You can still save it.');
    } catch (e) {
      if (cancelled()) return;
      show(button, false);
      explain(e instanceof PasteError ? `${e.message} Nothing was shown.` : 'The preview could not be loaded. You can still try to save the file.');
    } finally {
      done();
    }
    if (cancelled()) return;
    expanded(shown);
    if (!shown) show(button, false);
  });
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
  show(el('file-save-note'), false);
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
 * A download name without path separators, control characters, bidi
 * controls (which can make "invoice\u202Efdp.exe" display as "invoiceexe.pdf")
 * or Windows device names. The same rule as names inside a zip.
 */
export function safeFilename(name: string | null): string {
  return cleanFileName(name ?? '', 'download');
}

function showFailure(e: unknown, burn: boolean): void {
  if (e instanceof ApiError && e.status === 410) {
    showProblem('This link no longer works', 'The sender revoked it, or it has used all its opens. Ask the sender if you still need the paste.');
    return;
  }
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
        showProblem('The download stopped', burn
          ? 'Check your connection. This paste burns after reading, so the failed download may have used up an open; if it was the last one, the paste is gone.'
          : 'Check your connection, then open the link again.');
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
