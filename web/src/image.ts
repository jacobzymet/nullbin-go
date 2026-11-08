/**
 * Checks an attachment before the browser is allowed to show it as an image.
 *
 * Only PNG, JPEG, GIF and WebP are shown, recognized from the file's own
 * bytes: the type the sender declared is never trusted. Other formats (SVG,
 * which can hold scripts, and less common decoders) are never shown. The
 * size in pixels is read from the header first, so an image that would
 * take too much memory to decode is never handed to the browser.
 */

export type PreviewType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Larger files can still be saved, just not previewed. */
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
/** Roughly 200 MB of memory once decoded (4 bytes a pixel). */
export const MAX_PREVIEW_PIXELS = 50_000_000;
/** Browsers cannot draw images with a side much longer than this. */
export const MAX_PREVIEW_SIDE = 16_384;

/** Declared types worth offering a preview for. The bytes decide later. */
const PREVIEWABLE = new Set<string>(['image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/gif', 'image/webp']);

export function mayPreview(mime: string | null, size: number): boolean {
  return mime !== null && PREVIEWABLE.has(mime.toLowerCase()) && size > 0 && size <= MAX_PREVIEW_BYTES;
}

export interface ImageInfo {
  type: PreviewType;
  width: number;
  height: number;
}

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const ascii = (b: Uint8Array, i: number, s: string) =>
  b.length >= i + s.length && [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

function png(b: Uint8Array): ImageInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !signature.every((v, i) => b[i] === v)) return null;
  // The first chunk must be IHDR, 13 bytes long.
  if (be32(b, 8) !== 13 || !ascii(b, 12, 'IHDR')) return null;
  return { type: 'image/png', width: be32(b, 16), height: be32(b, 20) };
}

function gif(b: Uint8Array): ImageInfo | null {
  if (b.length < 10 || !(ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) return null;
  return { type: 'image/gif', width: le16(b, 6), height: le16(b, 8) };
}

function jpeg(b: Uint8Array): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1]!;
    // Any number of 0xFF fill bytes may come before a marker.
    while (marker === 0xff && i + 2 < b.length) { i++; marker = b[i + 1]!; }
    i += 2;
    // Markers without a length: TEM and RST0-7.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // End of image or start of scan before any frame header: not usable.
    if (marker === 0xd9 || marker === 0xda || i + 2 > b.length) return null;
    const length = be16(b, i);
    if (length < 2) return null;
    // Start of frame (every kind except DHT C4, JPG C8 and DAC CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 7 || i + 7 > b.length) return null;
      return { type: 'image/jpeg', width: be16(b, i + 5), height: be16(b, i + 3) };
    }
    i += length;
  }
  return null;
}

function webp(b: Uint8Array): ImageInfo | null {
  if (b.length < 30 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null;
  if (ascii(b, 12, 'VP8 ')) {
    // A key frame starts with the bytes 9D 01 2A, then 14-bit sizes.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { type: 'image/webp', width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8X')) {
    return { type: 'image/webp', width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  }
  return null;
}

/**
 * The format and size in pixels, or null when the file is not an image
 * that may be previewed: an unknown or unlisted format, a malformed header,
 * or too many pixels.
 */
export function previewInfo(bytes: Uint8Array): ImageInfo | null {
  const info = png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes);
  if (!info) return null;
  const { width, height } = info;
  if (width < 1 || height < 1 || width > MAX_PREVIEW_SIDE || height > MAX_PREVIEW_SIDE) return null;
  if (width * height > MAX_PREVIEW_PIXELS) return null;
  return info;
}
