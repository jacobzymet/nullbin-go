import { el, reveal, show } from './dom.ts';
import { previewInfo } from './image.ts';
import { decodePreviewText } from './attachment-preview.ts';
import { hasHiddenChars } from './hidden.ts';
import { textPreview } from './text-preview.ts';

/**
 * Attachment previews, shown only when the reader asks. Callers pass only
 * the fully verified, size-checked attachment.
 *
 * Images reach the browser under the type found in their own bytes (never
 * the sender's), and only for formats and sizes that previewInfo accepts.
 * Text is decoded as strict UTF-8 and shown with textContent: nothing is
 * parsed, formatted, linked or run.
 */

let url: string | null = null;
let generation = 0;

/**
 * Changes whenever previews are cleared. A preview that was still loading
 * when this changed must not be shown.
 */
export function previewGeneration(): number {
  return generation;
}

/** Removes any preview and the decrypted content behind it. */
export function clearPreview(): void {
  generation++;
  clearImage();
  el('document-preview').replaceChildren();
  show(el('document-preview'), false);
}

// Leaving the page removes the plaintext too.
if (typeof window !== 'undefined') window.addEventListener('pagehide', clearPreview);

/** Shows a text attachment literally. False if it is not clean UTF-8 text. */
export function showTextPreview(bytes: Uint8Array): boolean {
  const text = decodePreviewText(bytes);
  if (text === null) return false;
  const preview = textPreview(text);
  const box = el('document-preview');
  const caption = document.createElement('p');
  caption.className = 'nb-meta mb-2';
  caption.textContent = preview.truncated
    ? 'Plain-text preview limited to 5,000 lines or 100,000 characters. Save the file for the complete content.'
    : 'Shown as plain text. Links and code stay inactive.';
  const pre = document.createElement('pre');
  pre.className = 'nb-preview-text';
  pre.tabIndex = 0;
  pre.textContent = preview.text; // never innerHTML
  box.replaceChildren(caption);
  if (hasHiddenChars(text)) {
    const warning = document.createElement('p');
    warning.className = 'nb-note nb-tone-warn';
    warning.textContent = 'This file contains invisible or direction-changing characters. Check it carefully before copying or running it.';
    box.append(warning);
  }
  box.append(pre);
  reveal(box);
  return true;
}

function release(): void {
  if (url) URL.revokeObjectURL(url);
  url = null;
}

function clearImage(): void {
  release();
  el('image-preview').replaceChildren();
  show(el('image-preview'), false);
}

/** Resolves true once the image is on screen, false if it cannot be shown. */
export function showImage(bytes: Uint8Array<ArrayBuffer>, name: string): Promise<boolean> {
  clearImage();
  const info = previewInfo(bytes);
  if (!info) return Promise.resolve(false);
  url = URL.createObjectURL(new Blob([bytes], { type: info.type }));
  const img = document.createElement('img');
  img.alt = `Preview of ${name}`;
  img.decoding = 'async';
  img.width = info.width;
  img.height = info.height;
  img.draggable = false;
  const box = el('image-preview');
  return new Promise((resolve) => {
    // Once decoded, the address is no longer needed: nothing else can load it.
    img.addEventListener('load', () => { release(); resolve(true); }, { once: true });
    img.addEventListener('error', () => { clearImage(); resolve(false); }, { once: true });
    img.src = url!;
    box.replaceChildren(img);
    reveal(box);
  });
}
