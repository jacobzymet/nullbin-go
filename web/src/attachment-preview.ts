import { mayPreview } from './image.ts';

/**
 * Which preview, if any, to offer for an attachment. The name and declared
 * type only decide whether a button appears; the verified bytes decide what
 * is shown. Text is shown literally, never rendered: JSON, Markdown and
 * source code stay source text.
 */

export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
export type AttachmentPreview = 'image' | 'text';

const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown', 'application/json', 'text/json', 'text/csv', 'text/tab-separated-values']);
const TEXT_EXTENSION = /\.(?:txt|md|markdown|json|csv|tsv|log|yaml|yml|toml|ini|conf|go|rs|py|js|ts|jsx|tsx|css|sql|sh)$/i;

export function attachmentPreview(name: string, mime: string | null, size: number): AttachmentPreview | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  if (mayPreview(mime, size)) return 'image';
  const type = mime?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (size <= MAX_TEXT_PREVIEW_BYTES && (TEXT_TYPES.has(type) || TEXT_EXTENSION.test(name))) return 'text';
  return null;
}

/** Invalid UTF-8 and binary control bytes are rejected, never replaced or interpreted. */
export function decodePreviewText(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_TEXT_PREVIEW_BYTES) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(text) ? null : text;
  } catch { return null; }
}
