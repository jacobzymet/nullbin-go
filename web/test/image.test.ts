import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { MAX_PREVIEW_BYTES, MAX_PREVIEW_PIXELS, mayPreview, previewInfo } from '../src/image.ts';

const bytes = (...parts: (number[] | string | Uint8Array)[]) => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const c of p) out.push(c.charCodeAt(0));
    else out.push(...p);
  }
  return new Uint8Array(out);
};
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

/** A complete, valid PNG: what a browser can really decode. */
function makePng(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const body = bytes(type, data);
    return bytes(u32be(data.length), body, u32be(crc32(body)));
  };
  const ihdr = bytes(u32be(width), u32be(height), [8, 6, 0, 0, 0]);
  const raw = new Uint8Array(height * (1 + width * 4)); // filter byte 0, transparent pixels
  return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array()));
}

const pngHeader = (w: number, h: number) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), 'IHDR', u32be(w), u32be(h), [8, 6, 0, 0, 0]);
const gifHeader = (w: number, h: number) => bytes('GIF89a', u16le(w), u16le(h), [0, 0, 0]);
const gifFrame = (w: number, h: number, x = 0, y = 0) =>
  bytes([0x2c], u16le(x), u16le(y), u16le(w), u16le(h), [0, 2, 2, 0x44, 0x01, 0]);
const gifImage = (w: number, h: number, ...blocks: Uint8Array[]) => bytes(gifHeader(w, h), ...blocks, [0x3b]);
const jpegHeader = (w: number, h: number, sof = 0xc0) =>
  // SOI, an APP0 segment, padding bytes, then the frame header.
  bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xff, sof, 0x00, 0x11, 0x08], [(h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255], new Uint8Array(12));
const webpLossy = (w: number, h: number) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8 ', [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], u16le(w), u16le(h), [0, 0]);
const webpLossless = (w: number, h: number) => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8L', [0, 0, 0, 0], [0x2f], [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255], new Uint8Array(8));
};
const webpExtended = (w: number, h: number) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0], [0, 0, 0, 0], u24le(w - 1), u24le(h - 1), new Uint8Array(4));

test('the format and size come from the file itself', () => {
  assert.deepEqual(previewInfo(makePng(3, 2)), { type: 'image/png', width: 3, height: 2 });
  assert.deepEqual(previewInfo(gifImage(640, 480, gifFrame(640, 480))), { type: 'image/gif', width: 640, height: 480 });
  assert.deepEqual(previewInfo(jpegHeader(1920, 1080)), { type: 'image/jpeg', width: 1920, height: 1080 });
  assert.deepEqual(previewInfo(jpegHeader(800, 600, 0xc2)), { type: 'image/jpeg', width: 800, height: 600 }); // progressive
  assert.deepEqual(previewInfo(webpLossy(300, 200)), { type: 'image/webp', width: 300, height: 200 });
  assert.deepEqual(previewInfo(webpLossless(300, 200)), { type: 'image/webp', width: 300, height: 200 });
  assert.deepEqual(previewInfo(webpExtended(300, 200)), { type: 'image/webp', width: 300, height: 200 });
});

test('anything else is never shown', () => {
  const rejected: [string, Uint8Array][] = [
    ['SVG', bytes('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ['HTML', bytes('<!doctype html><script>alert(1)</script>')],
    ['BMP', bytes('BM', new Uint8Array(60))],
    ['ICO', bytes([0, 0, 1, 0, 1, 0, 16, 16], new Uint8Array(40))],
    ['AVIF', bytes([0, 0, 0, 0x1c], 'ftypavif', new Uint8Array(40))],
    ['empty', new Uint8Array()],
    ['PNG signature only', makePng(1, 1).slice(0, 8)],
    ['PNG cut in the header', makePng(10, 10).slice(0, 20)],
    ['PNG whose first chunk is not IHDR', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), 'tEXt', u32be(1), u32be(1))],
    ['JPEG with no frame header', bytes([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])],
    ['JPEG with a broken segment length', bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x00, 0x00])],
    ['JPEG cut in the frame header', jpegHeader(10, 10).slice(0, 16)],
    ['JPEG with a height set later (DNL)', jpegHeader(100, 0)],
    ['WebP with an unknown chunk', bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'ANIM', new Uint8Array(20))],
    ['WebP lossy without its start code', bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8 ', new Uint8Array(20))],
    ['zero width', pngHeader(0, 10)],
    ['zero height', gifHeader(10, 0)],
    ['too wide', pngHeader(16_385, 1)],
    ['too many pixels', pngHeader(10_000, 10_000)],
    ['too large at the 32-bit limit', pngHeader(0xffffffff, 0xffffffff)],
    ['too many pixels (WebP)', webpExtended(16_384, 16_384)],
  ];
  for (const [name, b] of rejected) assert.equal(previewInfo(b), null, name);
  assert.ok(10_000 * 5_000 <= MAX_PREVIEW_PIXELS && previewInfo(pngHeader(10_000, 5_000)) !== null, 'the limit itself is allowed');
});

test('GIF frames cannot expand a small canvas or exceed the animation budget', () => {
  // The logical screen is 1x1 but the first frame expands to 51.84 million
  // pixels in tolerant decoders. The preflight must reject it before decode.
  assert.equal(previewInfo(gifImage(1, 1, gifFrame(7200, 7200))), null);
  assert.equal(previewInfo(gifImage(10, 10, gifFrame(10, 10, 1, 0))), null, 'frame offset expands the canvas');
  assert.equal(previewInfo(gifImage(10, 10, gifFrame(1, 1), gifFrame(11, 10))), null, 'later frames are checked');
  assert.equal(previewInfo(gifImage(10, 10, gifFrame(0, 1))), null, 'zero frame dimensions');
  const canvas = gifImage(10_000, 5_000, gifFrame(1, 1));
  assert.notEqual(previewInfo(canvas), null, 'one canvas at the pixel limit');
  assert.equal(previewInfo(gifImage(10_000, 5_000, gifFrame(1, 1), gifFrame(1, 1))), null, 'two full compositing canvases exceed the budget');
  assert.deepEqual(previewInfo(gifImage(10, 10, gifFrame(10, 10), gifFrame(5, 5, 5, 5))), { type: 'image/gif', width: 10, height: 10 });
});

test('GIF palettes, extensions and data blocks must be complete', () => {
  // A real one-pixel GIF, including a global palette and graphic control.
  const real = new Uint8Array(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));
  assert.deepEqual(previewInfo(real), { type: 'image/gif', width: 1, height: 1 });
  for (let i = 0; i < real.length; i++) assert.equal(previewInfo(real.subarray(0, i)), null, `truncated at byte ${i}`);
  const localPalette = gifFrame(1, 1);
  localPalette[9] = 0x80;
  const withLocal = gifImage(1, 1, bytes(localPalette.subarray(0, 10), [0, 0, 0, 255, 255, 255], localPalette.subarray(10)));
  assert.notEqual(previewInfo(withLocal), null, 'local palette');
  assert.equal(previewInfo(gifImage(1, 1, localPalette)), null, 'truncated local palette');
  assert.equal(previewInfo(gifImage(1, 1)), null, 'no frame');
  assert.equal(previewInfo(bytes(real, [0])), null, 'trailing data');
  assert.equal(previewInfo(gifImage(1, 1, bytes([0x21, 0xfe, 255], [0, 0]))), null, 'truncated extension');
  assert.equal(previewInfo(gifImage(1, 1, bytes([0x21, 0xfe, 1, 0x2c]))), null, 'unterminated extension');
  assert.equal(previewInfo(gifImage(1, 1, bytes([0x42]), gifFrame(1, 1))), null, 'unknown block');
  const codeSize = gifFrame(1, 1);
  codeSize[10] = 12;
  assert.equal(previewInfo(gifImage(1, 1, codeSize)), null, 'invalid LZW code size');
});

test('the preflight also enforces the encoded image byte limit', () => {
  const oversized = new Uint8Array(MAX_PREVIEW_BYTES + 1);
  oversized.set(pngHeader(1, 1));
  assert.equal(previewInfo(oversized), null);
});

test('random and mutated bytes never throw or loop', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const seeds = [makePng(4, 4), gifImage(4, 4, gifFrame(4, 4)), jpegHeader(4, 4), webpLossy(4, 4), webpLossless(4, 4), webpExtended(4, 4)];
  for (let n = 0; n < 20_000; n++) {
    const base = seeds[n % seeds.length]!;
    const b = n % 7 === 0 ? new Uint8Array(Math.floor(rand() * 64)) : base.slice(0, Math.floor(rand() * (base.length + 1)));
    for (let k = 0; k < 4; k++) if (b.length) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
    const info = previewInfo(b);
    if (info) assert.ok(info.width >= 1 && info.height >= 1 && info.width * info.height <= MAX_PREVIEW_PIXELS);
  }
  // A JPEG made only of fill bytes and empty segments ends quickly.
  const fill = new Uint8Array(1_000_000).fill(0xff);
  fill[1] = 0xd8;
  assert.equal(previewInfo(fill), null);
});

test('a preview is offered only for listed types up to the size limit', () => {
  assert.equal(mayPreview('image/png', 10), true);
  assert.equal(mayPreview('IMAGE/JPEG', 10), true);
  assert.equal(mayPreview('image/png', MAX_PREVIEW_BYTES), true);
  assert.equal(mayPreview('image/png', MAX_PREVIEW_BYTES + 1), false);
  assert.equal(mayPreview('image/png', 0), false);
  for (const mime of ['image/svg+xml', 'text/html', 'image/bmp', 'image/avif', 'application/zip', '', null]) assert.equal(mayPreview(mime, 10), false, String(mime));
});
