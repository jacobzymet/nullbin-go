// The new-paste page: encrypt in the browser, upload the ciphertext in
// chunks, then show the link (split into the part the server sees and the
// key it never sees) and the delete link.

import { ApiError, MAX_BURN_READS, UPLOAD_CHUNK, createPaste, finalizePaste, putChunk, rechunk } from './api.ts';
import { MAX_RECIPIENTS, MIN_RECIPIENTS, preparePaste } from './crypto.ts';
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
  formatCountdown,
  nextFrame,
  show,
  showCopied,
  showError,
  showSection,
  startCountdown,
} from './dom.ts';
import { PasteError } from './format.ts';
import { encodeKeyFragment, encodeTokenFragment } from './link.ts';
import { MAX_FILES, archiveName, zipFiles } from './zip.ts';
import { loadSodium } from './sodium.ts';
import { initShareActions } from './share.ts';

/** Shortest password accepted. The link key does the heavy lifting; this keeps the second factor meaningful. */
export const MIN_PASSWORD_LENGTH = 8;

/** Characters of generated passwords: letters and digits, without ones that look alike (I l 1, O o 0). */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
export const GENERATED_PASSWORD_LENGTH = 20;

/**
 * A random password: 20 characters from 56, about 116 bits, from the
 * browser's cryptographic random generator. Rejection sampling keeps every
 * character equally likely.
 */
export function generatePassword(random: (bytes: Uint8Array<ArrayBuffer>) => unknown = (b) => crypto.getRandomValues(b)): string {
  const n = PASSWORD_ALPHABET.length;
  const limit = 256 - (256 % n); // the largest multiple of n that fits in a byte
  let out = '';
  const buf = new Uint8Array(32);
  while (out.length < GENERATED_PASSWORD_LENGTH) {
    random(buf);
    for (const b of buf) {
      if (b < limit && out.length < GENERATED_PASSWORD_LENGTH) out += PASSWORD_ALPHABET[b % n];
    }
  }
  buf.fill(0);
  return out;
}

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
  const recipients = el<HTMLInputElement>('recipients');
  const recipientsCount = el<HTMLInputElement>('recipients-count');
  recipientsCount.min = String(MIN_RECIPIENTS);
  recipientsCount.max = String(MAX_RECIPIENTS);
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

  // Pasting an image (a screenshot, or "Copy image" in a browser) or copied
  // files attaches them. Text on the clipboard always pastes as text, and
  // other fields (such as the password) are left alone.
  document.addEventListener('paste', (e) => {
    if (el('create').hidden || form.getAttribute('aria-busy') === 'true') return;
    const target = e.target;
    if (target !== text && target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]')) return;
    const data = e.clipboardData;
    if (!data || data.files.length === 0 || data.getData('text/plain') !== '') return;
    e.preventDefault();
    const extension: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
    addFiles([...data.files].map((f) => (f.name ? f : new File([f], `pasted-image${extension[f.type] ?? ''}`, { type: f.type }))));
  });

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

  // --- Options. A discussion cannot burn or have separate links: its
  // comment key would outlast a revoked link. ---
  const setOptionHint = (input: HTMLInputElement, helpId: string, message: string) => {
    input.parentElement?.setAttribute('title', message);
    el(helpId).textContent = message;
  };
  const updateReadUnit = () => {
    el('burn-reads-unit').textContent = Number(burnReads.value) === 1 ? 'open' : 'opens';
  };
  burnReads.addEventListener('input', updateReadUnit);
  const sync = () => {
    burn.disabled = discussion.checked;
    recipients.disabled = discussion.checked;
    discussion.disabled = burn.checked || recipients.checked;
    show(el('recipients-field'), recipients.checked);
    recipientsCount.disabled = !recipients.checked;
    recipientsCount.required = recipients.checked;
    show(el('burn-reads-field'), burn.checked);
    burnReads.disabled = !burn.checked;
    burnReads.required = burn.checked;
    el('burn-label').textContent = burn.checked ? 'Burn after' : 'Burn after opening';
    updateReadUnit();
    burnReads.parentElement?.setAttribute('title', el('burn-reads-help').textContent ?? '');
    setOptionHint(burn, 'burn-help', discussion.checked
      ? 'Turn off Discussion to enable burn after reading.'
      : recipients.checked
        ? 'Each separate link stops working after the configured number of authorized opens.'
        : 'Deleted from the server after the configured number of authorized opens.');
    setOptionHint(recipients, 'recipients-help', discussion.checked
      ? 'Turn off Discussion to make separate links.'
      : 'Give each person their own link, with its own open count. The delete link can revoke each one.');
    setOptionHint(discussion, 'discussion-help', burn.checked || recipients.checked
      ? `Disable ${burn.checked ? 'burning' : 'separate links'} to enable a discussion.`
      : 'Allow encrypted comments from everyone who can open the paste.');
    setOptionHint(pwSwitch, 'password-help', 'Readers need the password as well as the link. Send it separately.');
    show(pwRow, pwSwitch.checked);
    password.required = pwSwitch.checked;
    if (!pwSwitch.checked) {
      password.classList.remove('is-invalid');
      password.setAttribute('aria-invalid', 'false');
    }
  };
  for (const s of [burn, recipients, pwSwitch, discussion]) s.addEventListener('change', sync);
  const focusPasswordIfNew = () => {
    if (pwSwitch.checked && password.value === '') password.focus();
  };
  pwSwitch.addEventListener('change', focusPasswordIfNew);
  password.addEventListener('input', () => {
    password.classList.remove('is-invalid');
    password.setAttribute('aria-invalid', 'false');
  });
  const revealButton = el<HTMLButtonElement>('password-reveal');
  bindReveal(revealButton, password);
  // A generated password is shown, so it can be checked and copied: it has
  // to be sent separately, and the form clears it once the paste is created.
  el<HTMLButtonElement>('password-generate').addEventListener('click', () => {
    password.value = generatePassword();
    password.dispatchEvent(new Event('input'));
    if (password.type !== 'text') revealButton.click();
    announce('Generated a 20-character password. Copy it and send it separately from the link.');
  });
  const copyPassword = el<HTMLButtonElement>('password-copy');
  bindCopy(copyPassword, () => password.value, 'Password copied', password, 'The password is selected');
  const syncCopy = () => { copyPassword.disabled = password.value === ''; };
  password.addEventListener('input', syncCopy);
  syncCopy();
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
    if (recipients.checked && !recipientsCount.checkValidity()) {
      recipientsCount.reportValidity();
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
        recipients: recipients.checked ? Number(recipientsCount.value) : 0,
      });
      // Do not leave plaintext or the password lying around in the form.
      text.value = '';
      password.value = '';
      password.dispatchEvent(new Event('input'));
      if (password.type === 'text') revealButton.click(); // hidden again for whatever is typed next
      files = [];
      renderFiles();
      updateCount();
      showSection('result');
      el('result-title').focus();
      const status = el('result-copy-status');
      if (share === null) {
        // Separate links: no single link to copy. Each has its own button.
        status.classList.remove('nb-tone-ok');
        status.textContent = 'Your separate links are ready. Copy each one and send it to one person.';
      } else {
        initShareActions('result', share);
        const copied = await copyText(share);
        status.classList.toggle('nb-tone-ok', copied);
        status.textContent = copied
          ? 'Share link automatically copied to clipboard.'
          : 'Your share link is ready. Save it to return to this paste.';
        if (copied) showCopied(el<HTMLButtonElement>('copy-share'));
      }
      show(status);
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
  /** Number of separate links, or 0 for one shared link. */
  recipients: number;
}

/** Creates the paste. Returns its share link, or null when it has separate links (shown on the page). */
async function createAndUpload(progress: Progress, o: CreateOptions): Promise<string | null> {
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
    recipients: o.recipients,
  });

  const separate = o.recipients > 0;
  let created: Awaited<ReturnType<typeof createPaste>>;
  let server = '';
  let share: string | null = null;
  let deadline = 0;
  let expires = new Date();
  // The link key and every link's secret are wiped however this ends.
  try {
    created = separate
      ? await createPaste(o.expiresIn, true, prepared.totalSize, null, null, 1, prepared.recipientTokens.map((token) => ({ token, maxReads: o.burn ? o.maxReads : null })))
      : await createPaste(o.expiresIn, o.burn, prepared.totalSize, prepared.commentToken, o.burn ? prepared.burnToken : null, o.maxReads);
    let sent = 0;
    let n = 0;
    for await (const chunk of rechunk(prepared.chunks(), UPLOAD_CHUNK)) {
      const pct = Math.floor((sent / prepared.totalSize) * 100);
      progress.set(sent / prepared.totalSize, `Encrypting and uploading · ${pct}% of ${formatBytes(prepared.totalSize)}`);
      await putChunk(created.id, n++, created.uploadToken, chunk);
      sent += chunk.length;
    }
    progress.set(1, 'Finishing…');
    await finalizePaste(created.id, created.uploadToken);
    // The countdown runs on this browser's monotonic clock from the expiry
    // just chosen, so a wrong computer clock does not skew it.
    deadline = performance.now() + o.expiresIn * 1000;
    expires = new Date(Date.now() + o.expiresIn * 1000);

    // --- Result ---
    server = `${window.location.origin}/p/${created.id}`;
    if (separate) {
      const list = el('recipient-list');
      list.replaceChildren(...prepared.recipientSecrets.map((secret, i) => {
        const key = `#${encodeKeyFragment(sodium, prepared.fragmentKey, o.burn, secret)}`;
        sodium.memzero(secret);
        return recipientRow(i, server, key);
      }));
      show(el('share-single'), false);
      show(el('recipient-links'));
    } else {
      const key = `#${encodeKeyFragment(sodium, prepared.fragmentKey, o.burn)}`;
      el('share-server').textContent = server;
      el('share-key').textContent = key;
      share = server + key;
    }
  } finally {
    for (const secret of prepared.recipientSecrets) sodium.memzero(secret);
    sodium.memzero(prepared.fragmentKey);
  }
  const deleteLink = el<HTMLInputElement>('delete-link');
  deleteLink.value = `${window.location.origin}/d/${created.id}#${encodeTokenFragment(created.deleteToken, separate)}`;

  const when = expires.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  startCountdown(el('result-expires'), deadline, (left) => (left > 0 ? `${when} · deleted in ${formatCountdown(left)}` : `${when} · expired`));

  const chips: HTMLLIElement[] = [];
  if (separate) chips.push(chip(`${o.recipients} separate links`, 'users', 'accent'));
  if (o.burn) chips.push(chip(`Burn after ${o.maxReads.toLocaleString()} ${o.maxReads === 1 ? 'open' : 'opens'}${separate ? ' each' : ''}`, 'flame', 'warn'));
  if (o.password) chips.push(chip('Password', 'lock'));
  if (o.discussion) chips.push(chip('Discussion', 'chat', 'accent'));
  if (o.files.length === 1) chips.push(chip(o.files[0]!.name, 'file', 'file'));
  else if (o.files.length > 1) chips.push(chip(`${o.files.length} files (as ${archiveName(o.files.length)})`, 'file', 'file'));
  if (chips.length === 0) chips.push(chip('Link only'));
  el('result-chips').replaceChildren(...chips);
  show(el('result-password-note'), o.password !== '');

  return share;
}

/** One numbered separate link on the result page, with its own copy button. */
function recipientRow(i: number, server: string, key: string): HTMLLIElement {
  const li = document.createElement('li');
  const num = document.createElement('span');
  num.className = 'nb-recipient-num';
  num.textContent = `Link ${i + 1}`;
  const link = document.createElement('p');
  link.className = 'nb-link';
  link.tabIndex = 0;
  link.id = `recipient-link-${i + 1}`;
  link.setAttribute('aria-label', `Link ${i + 1}`);
  const serverPart = document.createElement('span');
  serverPart.className = 'nb-link-server';
  serverPart.textContent = server;
  const keyPart = document.createElement('span');
  keyPart.className = 'nb-link-key';
  keyPart.textContent = key;
  link.append(serverPart, keyPart);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn nb-btn-secondary nb-copy-btn';
  const label = document.createElement('span');
  label.textContent = 'Copy';
  copy.append(icon('copy'), label);
  copy.setAttribute('aria-label', `Copy link ${i + 1}`);
  bindCopy(copy, () => server + key, `Link ${i + 1} copied`, link);
  li.append(num, link, copy);
  return li;
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
      // The limit applies to the padded size, a few percent above the content.
      return typeof max === 'number'
        ? `This paste is too large. The limit on this server is ${formatBytes(max)}, including a few percent of padding that hides the exact size.`
        : 'This paste is too large.';
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
