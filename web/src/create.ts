// The new-paste page: encrypt in the browser, upload the ciphertext in
// chunks, then show the link (split into the part the server sees and the
// key it never sees) and the delete link.

import { ApiError, MAX_BURN_READS, UPLOAD_CHUNK, createPaste, finalizePaste, putChunk, rechunk } from './api.ts';
import { preparePaste } from './crypto.ts';
import {
  Progress,
  announce,
  bindCopy,
  bindReveal,
  busy,
  chip,
  clearError,
  icon,
  copyText,
  el,
  formatBytes,
  nextFrame,
  show,
  showCopied,
  showError,
  showSection,
  timeUntil,
} from './dom.ts';
import { PasteError } from './format.ts';
import { encodeKeyFragment, encodeTokenFragment } from './link.ts';
import { MAX_FILES, archiveName, zipFiles } from './zip.ts';
import { loadSodium } from './sodium.ts';
import { initShareActions } from './share.ts';

/** Shortest password accepted. The link key does the heavy lifting; this keeps the second factor meaningful. */
export const MIN_PASSWORD_LENGTH = 8;

export function initCreate(draft?: { text: string; file: File | null }): void {
  const form = el<HTMLFormElement>('create-form');
  const composer = el('composer');
  const text = el<HTMLTextAreaElement>('text');
  const fileInput = el<HTMLInputElement>('file');
  const fileList = el<HTMLUListElement>('file-list');
  const charCount = el('char-count');
  const burn = el<HTMLInputElement>('burn');
  const burnReads = el<HTMLInputElement>('burn-reads');
  burnReads.max = String(MAX_BURN_READS);
  const pwSwitch = el<HTMLInputElement>('password-switch');
  const pwRow = el('password-row');
  const password = el<HTMLInputElement>('password');
  const discussion = el<HTMLInputElement>('discussion');
  const progress = new Progress('create');

  showSection('create');
  show(el('nav-new'));
  bindResultCopy();
  if (/Mac|iPhone|iPad/.test(navigator.userAgent)) el('kbd-mod').textContent = '⌘';
  text.focus();

  // --- File attachments: button or drag and drop. Several files are sent
  // as one zip archive (zip.ts). ---
  let files: File[] = [];
  const renderFiles = () => {
    fileList.replaceChildren(...files.map((f, i) => {
      const li = document.createElement('li');
      li.className = 'nb-file-chip';
      const name = document.createElement('span');
      name.className = 'nb-file-chip-name';
      name.textContent = f.name; // never innerHTML
      name.title = f.name;
      const size = document.createElement('span');
      size.className = 'nb-muted';
      size.textContent = formatBytes(f.size);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'nb-chip-x';
      remove.setAttribute('aria-label', `Remove ${f.name}`);
      remove.append(icon('x'));
      remove.addEventListener('click', () => {
        files = files.filter((_, j) => j !== i);
        renderFiles();
        announce(`Removed ${f.name}.`);
        (fileList.querySelector<HTMLButtonElement>('.nb-chip-x') ?? fileInput).focus();
      });
      li.append(icon('file'), name, size, remove);
      return li;
    }));
    show(fileList, files.length > 0);
    el('attach-label').textContent = files.length > 0 ? 'Add files' : 'Attach files';
  };
  const addFiles = (added: Iterable<File>) => {
    const list = [...added];
    if (list.length === 0) return;
    if (files.length + list.length > MAX_FILES) {
      showError(`A paste can hold up to ${MAX_FILES} files.`);
      return;
    }
    clearError();
    files = [...files, ...list];
    renderFiles();
    announce(list.length === 1 ? `Attached ${list[0]!.name}.` : `Attached ${list.length} files.`);
  };
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files ?? []);
    fileInput.value = ''; // the same file can be picked again later
  });

  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
  let dragDepth = 0;
  composer.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    composer.classList.add('nb-dragging');
  });
  composer.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  composer.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      composer.classList.remove('nb-dragging');
    }
  });
  composer.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    composer.classList.remove('nb-dragging');
    if (form.getAttribute('aria-busy') === 'true') return;
    addFiles(e.dataTransfer?.files ?? []);
  });
  // A file dropped anywhere else must not make the browser open it.
  window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener('drop', (e) => hasFiles(e) && e.preventDefault());

  const updateCount = () => {
    const n = text.value.length;
    charCount.textContent = `${n.toLocaleString()} ${n === 1 ? 'character' : 'characters'}`;
    text.setAttribute('aria-invalid', 'false');
  };
  text.addEventListener('input', updateCount);
  if (draft) {
    text.value = draft.text;
    if (draft.file) addFiles([draft.file]);
    updateCount();
  }

  // --- Options. A discussion needs a password and cannot burn. ---
  const setOptionHint = (input: HTMLInputElement, helpId: string, message: string) => {
    input.parentElement?.setAttribute('title', message);
    el(helpId).textContent = message;
  };
  const updateReadUnit = () => {
    el('burn-reads-unit').textContent = Number(burnReads.value) === 1 ? 'open' : 'opens';
  };
  burnReads.addEventListener('input', updateReadUnit);
  const sync = () => {
    if (discussion.checked) pwSwitch.checked = true;
    pwSwitch.disabled = discussion.checked;
    burn.disabled = discussion.checked;
    discussion.disabled = burn.checked;
    show(el('burn-reads-field'), burn.checked);
    burnReads.disabled = !burn.checked;
    burnReads.required = burn.checked;
    el('burn-label').textContent = burn.checked ? 'Burn after' : 'Burn after opening';
    updateReadUnit();
    burnReads.parentElement?.setAttribute('title', el('burn-reads-help').textContent ?? '');
    setOptionHint(burn, 'burn-help', discussion.checked
      ? 'Turn off Discussion to enable burn after reading.'
      : 'Deleted from the server after the configured number of authorized opens.');
    setOptionHint(discussion, 'discussion-help', burn.checked
      ? 'Disable burning to enable a discussion.'
      : 'Allow encrypted comments. Requires a password.');
    setOptionHint(pwSwitch, 'password-help', discussion.checked
      ? 'A password is required while Discussion is enabled.'
      : 'Readers need the password as well as the link. Send it separately.');
    show(pwRow, pwSwitch.checked);
    password.required = pwSwitch.checked;
    if (!pwSwitch.checked) {
      password.classList.remove('is-invalid');
      password.setAttribute('aria-invalid', 'false');
    }
  };
  for (const s of [burn, pwSwitch, discussion]) s.addEventListener('change', sync);
  const focusPasswordIfNew = () => {
    if (pwSwitch.checked && password.value === '') password.focus();
  };
  pwSwitch.addEventListener('change', focusPasswordIfNew);
  discussion.addEventListener('change', focusPasswordIfNew);
  password.addEventListener('input', () => {
    password.classList.remove('is-invalid');
    password.setAttribute('aria-invalid', 'false');
  });
  bindReveal(el<HTMLButtonElement>('password-reveal'), password);
  sync();

  // Ctrl+Enter (Cmd+Enter on a Mac) submits from anywhere in the form.
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (form.getAttribute('aria-busy') === 'true') return;
    clearError();
    if (text.value.trim() === '' && files.length === 0) {
      showError('Add some text or attach a file first.');
      text.setAttribute('aria-invalid', 'true');
      text.focus();
      return;
    }
    const pw = pwSwitch.checked ? password.value : '';
    if (pwSwitch.checked && pw.length < MIN_PASSWORD_LENGTH) {
      password.classList.add('is-invalid');
      password.setAttribute('aria-invalid', 'true');
      password.focus();
      return;
    }
    const expiry = el<HTMLSelectElement>('expiry');
    if (burn.checked && !burnReads.checkValidity()) {
      burnReads.reportValidity();
      return;
    }
    const controls = [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('input, select, button, textarea')];
    const wasDisabled = controls.map((c) => c.disabled);
    const done = busy(el<HTMLButtonElement>('create-submit'), 'Creating…');
    form.setAttribute('aria-busy', 'true');
    controls.forEach((c) => (c.disabled = true));
    show(el('create-progress'));
    try {
      const share = await createAndUpload(progress, {
        text: text.value,
        files,
        expiresIn: Number(expiry.value),
        password: pw,
        burn: burn.checked,
        maxReads: burn.checked ? Number(burnReads.value) : 1,
        discussion: discussion.checked,
      });
      // Do not leave plaintext or the password lying around in the form.
      text.value = '';
      password.value = '';
      files = [];
      renderFiles();
      updateCount();
      showSection('result');
      initShareActions('result', share);
      el('result-title').focus();
      const copied = await copyText(share);
      const status = el('result-copy-status');
      status.classList.toggle('nb-tone-ok', copied);
      status.textContent = copied
        ? 'Share link automatically copied to clipboard.'
        : 'Your share link is ready. Save it to return to this paste.';
      show(status);
      if (copied) showCopied(el<HTMLButtonElement>('copy-share'));
    } catch (e) {
      show(el('create-progress'), false);
      showError(describe(e));
    } finally {
      done();
      form.removeAttribute('aria-busy');
      controls.forEach((c, i) => (c.disabled = wasDisabled[i] ?? false));
      progress.set(0, '');
    }
  });
}

interface CreateOptions {
  text: string;
  files: readonly File[];
  expiresIn: number;
  password: string;
  burn: boolean;
  maxReads: number;
  discussion: boolean;
}

async function createAndUpload(progress: Progress, o: CreateOptions): Promise<string> {
  // One file is attached as it is; several travel as one zip archive.
  let file: Blob | null = o.files[0] ?? null;
  let filename = o.files[0]?.name ?? null;
  let mime = o.files[0]?.type || null;
  if (o.files.length > 1) {
    progress.set(0, 'Preparing files…');
    file = await zipFiles(o.files, (f) => progress.set(f, `Preparing ${o.files.length} files · ${Math.floor(f * 100)}%`));
    filename = archiveName(o.files.length);
    mime = 'application/zip';
  }
  progress.set(0, o.password ? 'Deriving a key from the password…' : 'Encrypting…');
  const sodium = await loadSodium();
  await nextFrame(); // let the status paint; Argon2id blocks the page briefly
  const prepared = preparePaste(sodium, {
    text: o.text,
    file,
    filename,
    mime,
    password: o.password,
    discussion: o.discussion,
  });

  const created = await createPaste(o.expiresIn, o.burn, prepared.totalSize, prepared.commentToken, o.burn ? prepared.burnToken : null, o.maxReads);
  let sent = 0;
  let n = 0;
  for await (const chunk of rechunk(prepared.chunks(), UPLOAD_CHUNK)) {
    const pct = Math.floor((sent / prepared.totalSize) * 100);
    progress.set(sent / prepared.totalSize, `Encrypting and uploading · ${pct}% of ${formatBytes(prepared.totalSize)}`);
    await putChunk(created.id, n++, created.uploadToken, chunk);
    sent += chunk.length;
  }
  progress.set(1, 'Finishing…');
  const expires = await finalizePaste(created.id, created.uploadToken);

  // --- Result ---
  const server = `${window.location.origin}/p/${created.id}`;
  const key = `#${encodeKeyFragment(sodium, prepared.fragmentKey, o.burn)}`;
  sodium.memzero(prepared.fragmentKey);
  el('share-server').textContent = server;
  el('share-key').textContent = key;
  const deleteLink = el<HTMLInputElement>('delete-link');
  deleteLink.value = `${window.location.origin}/d/${created.id}#${encodeTokenFragment(created.deleteToken)}`;

  const exp = el('result-expires');
  exp.textContent = expires
    ? `${expires.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${timeUntil(expires)}`
    : 'Unknown';

  const chips: HTMLLIElement[] = [];
  if (o.burn) chips.push(chip(`Burn after ${o.maxReads.toLocaleString()} ${o.maxReads === 1 ? 'open' : 'opens'}`, 'flame', 'warn'));
  if (o.password) chips.push(chip('Password', 'lock'));
  if (o.discussion) chips.push(chip('Discussion', 'chat', 'accent'));
  if (o.files.length === 1) chips.push(chip(o.files[0]!.name, 'file', 'file'));
  else if (o.files.length > 1) chips.push(chip(`${o.files.length} files (as ${archiveName(o.files.length)})`, 'file', 'file'));
  if (chips.length === 0) chips.push(chip('Link only'));
  el('result-chips').replaceChildren(...chips);
  show(el('result-password-note'), o.password !== '');

  return server + key;
}

let copyBound = false;

/** The copy buttons are bound once; they always read the current values. */
export function bindResultCopy(): void {
  if (copyBound) return;
  copyBound = true;
  bindCopy(el<HTMLButtonElement>('copy-share'), () => `${el('share-server').textContent}${el('share-key').textContent}`, 'Link copied', el('share-link'));
  const del = el<HTMLInputElement>('delete-link');
  bindCopy(el<HTMLButtonElement>('copy-delete'), () => del.value, 'Delete link copied', del);
}

function describe(e: unknown): string {
  if (e instanceof PasteError) return e.message;
  if (e instanceof ApiError) {
    if (e.status === 413) {
      const max = e.body['max_size'];
      return typeof max === 'number' ? `This paste is too large. The limit on this server is ${formatBytes(max)}.` : 'This paste is too large.';
    }
    if (e.status === 429) return 'Too many pastes in a short time. Wait a minute, then try again.';
    if (e.status === 507) return 'This server is out of storage space right now. Try again later, or try a smaller paste.';
    if (e.status === 503) return 'This server is busy with other uploads. Wait a minute, then try again.';
    // Unfinished uploads expire after 2 minutes without progress.
    if (e.status === 404) return 'The upload paused for too long and expired. Try again.';
    return `The server refused the upload: ${e.message}.`;
  }
  return 'The upload failed. Check your connection and try again.';
}
