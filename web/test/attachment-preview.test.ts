import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentPreview, decodePreviewText, MAX_TEXT_PREVIEW_BYTES } from '../src/attachment-preview.ts';
import { MAX_BUFFERED_DOWNLOAD } from '../src/attachments.ts';
import { MAX_PREVIEW_BYTES } from '../src/image.ts';
import { MAX_PREVIEW_CHARS, MAX_PREVIEW_LINES, textPreview } from '../src/text-preview.ts';

const utf8 = (text: string) => new TextEncoder().encode(text);

test('attachment preview offers only images and plain text within their limits', () => {
  for (const name of ['file.txt', 'file.MD', 'data.json', 'data.csv', 'source.go']) assert.equal(attachmentPreview(name, null, 10), 'text');
  assert.equal(attachmentPreview('file', 'text/plain; charset=utf-8', 10), 'text');
  assert.equal(attachmentPreview('file.png', 'image/png', 10), 'image');
  // Documents and active formats are never previewed, whatever they claim to be.
  for (const name of ['file.pdf', 'file.svg', 'file.html', 'file.htm', 'file.xml', 'file.zip', 'file.docx', 'file.mp4']) assert.equal(attachmentPreview(name, null, 10), null, name);
  for (const mime of ['application/pdf', 'text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml']) assert.equal(attachmentPreview('file', mime, 10), null, mime);
  for (const size of [-1, 0, NaN, Infinity, 1.5]) assert.equal(attachmentPreview('file.txt', 'text/plain', size), null);
  assert.equal(attachmentPreview('file.txt', 'text/plain', MAX_TEXT_PREVIEW_BYTES + 1), null);
});

test('text previews reject malformed encoding and binary controls, without interpreting content', () => {
  for (const text of ['hello', '\uFEFFhello', '你好\nhello\tworld\r\n', '<script>alert(1)</script>', '[link](javascript:alert(1))', '{"__proto__":{"polluted":true}}']) {
    assert.equal(decodePreviewText(utf8(text)), text.replace(/^\uFEFF/, ''));
  }
  for (const bytes of [new Uint8Array([0xc0, 0xaf]), new Uint8Array([0xff]), new Uint8Array([0xe2, 0x82]), utf8('a\0b'), utf8('a\u001bb'), new Uint8Array(MAX_TEXT_PREVIEW_BYTES + 1)]) assert.equal(decodePreviewText(bytes), null);
  assert.equal(decodePreviewText(utf8('a\u202Eb')), 'a\u202Eb', 'direction controls remain text for the existing warning');
  // Clean text over the limit is refused for its size alone.
  assert.equal(decodePreviewText(new Uint8Array(MAX_TEXT_PREVIEW_BYTES).fill(0x41)) !== null, true);
  assert.equal(decodePreviewText(new Uint8Array(MAX_TEXT_PREVIEW_BYTES + 1).fill(0x41)), null);
});

test('every previewable file fits in the verified in-memory copy', () => {
  // Previews read only that copy, never a saved file on disk.
  assert.ok(MAX_TEXT_PREVIEW_BYTES <= MAX_BUFFERED_DOWNLOAD);
  assert.ok(MAX_PREVIEW_BYTES <= MAX_BUFFERED_DOWNLOAD);
});

test('the shown text is a bounded prefix that never splits a character', () => {
  let state = 7;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0);
  const pieces = ['a', '\n', '\r', '\r\n', String.fromCharCode(0xd83d, 0xde00), '\u202E', 'é'];
  for (let n = 0; n < 300; n++) {
    let text = '';
    const parts = next() % 4 === 0 ? 120_000 : next() % 3000;
    for (let i = 0; i < parts; i++) text += pieces[next() % pieces.length];
    if (next() % 5 === 0) text = '\n'.repeat(6000) + text;
    const out = textPreview(text);
    assert.ok(text.startsWith(out.text), 'a prefix of the original');
    assert.ok(out.text.length <= MAX_PREVIEW_CHARS);
    assert.ok(out.text.split(/\r\n?|\n/).length <= MAX_PREVIEW_LINES + 1);
    assert.equal(out.truncated, out.text.length < text.length);
    const last = out.text.charCodeAt(out.text.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'no half character at the end');
  }
});

test('random preview inputs fail closed without throwing', () => {
  let state = 42;
  for (let i = 0; i < 1000; i++) {
    const bytes = new Uint8Array(i % 256);
    for (let j = 0; j < bytes.length; j++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; bytes[j] = state >>> 24; }
    assert.doesNotThrow(() => decodePreviewText(bytes));
  }
});
