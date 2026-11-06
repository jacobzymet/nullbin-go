import { initCreate } from './create.ts';
import { busy, el, toast } from './dom.ts';
import { downloadBlob, openRawText } from './files.ts';
import { initShareActions } from './share.ts';

export interface CloneAttachment {
  available: boolean;
  load: () => Promise<File>;
}

export function initReaderActions(text: string, url: string, shareable: boolean, attachment: CloneAttachment | null): void {
  el('nav-new').hidden = true;
  initShareActions('view', url, shareable);
  const clone = el<HTMLButtonElement>('view-clone');
  clone.disabled = attachment !== null && !attachment.available;
  clone.title = clone.disabled
    ? 'Save this attachment first to clone files above 64 MiB. Streaming saves require desktop Chrome or Edge.'
    : 'Copy the text and attachment to a new draft. Choose its expiry and password before creating it.';
  clone.addEventListener('click', async () => {
    if (clone.disabled) return;
    const done = busy(clone, 'Cloning…');
    try {
      const file = attachment ? await attachment.load() : null;
      history.replaceState(null, '', '/');
      initCreate({ text, file });
      toast('Copied to a new draft');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The attachment could not be cloned.', 'warn');
    } finally {
      done();
    }
  });
  const raw = el<HTMLButtonElement>('view-raw');
  const save = el<HTMLButtonElement>('text-download');
  for (const button of [raw, save]) {
    button.disabled = text.length === 0;
    button.title = text.length === 0 ? 'This paste contains only a file. Use Save file to download it.' : '';
  }
  raw.addEventListener('click', () => openRawText(text));
  save.addEventListener('click', () => {
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'paste.txt');
    toast('Document saved');
  });
}
