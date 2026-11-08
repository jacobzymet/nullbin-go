import { el, reveal, show } from './dom.ts';
import { previewInfo } from './image.ts';

/**
 * Shows an image attachment, only when the reader asks for it. The bytes are
 * the fully verified attachment; the browser is given them under the type
 * found in the bytes themselves (never the sender's), and only for formats
 * and sizes that previewInfo accepts.
 */

let url: string | null = null;

function release(): void {
  if (url) URL.revokeObjectURL(url);
  url = null;
}

/** Removes the preview and the decrypted image behind it. */
export function clearImage(): void {
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
