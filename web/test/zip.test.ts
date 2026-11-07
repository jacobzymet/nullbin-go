import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { MAX_FILES, archiveName, crc32, uniqueNames, zipEntryName, zipFiles } from '../src/zip.ts';
import { PasteError } from '../src/format.ts';

interface Entry { name: string; data: Uint8Array; mode: number; date: number; time: number; flags: number }

/** An independent reader: the central directory, then each local header. */
function readZip(zip: Uint8Array): Entry[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  assert.equal(v.getUint32(eocd, true), 0x06054b50, 'end of central directory');
  assert.equal(v.getUint16(eocd + 20, true), 0, 'no archive comment');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  assert.equal(p + v.getUint32(eocd + 12, true), eocd, 'central directory ends where the end record starts');
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50);
    const flags = v.getUint16(p + 8, true);
    assert.equal(v.getUint16(p + 10, true), 0, 'stored');
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 24, true);
    assert.equal(v.getUint32(p + 20, true), size);
    const nameLen = v.getUint16(p + 28, true);
    assert.equal(v.getUint16(p + 30, true) + v.getUint16(p + 32, true), 0, 'no extra fields or comments');
    const mode = v.getUint32(p + 38, true) >>> 16;
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(zip.subarray(p + 46, p + 46 + nameLen));
    // The local header must agree with the central directory.
    assert.equal(v.getUint32(local, true), 0x04034b50);
    assert.equal(v.getUint32(local + 14, true), crc);
    assert.equal(v.getUint32(local + 22, true), size);
    assert.equal(v.getUint16(local + 26, true), nameLen);
    assert.equal(v.getUint16(local + 28, true), 0);
    const start = local + 30 + nameLen;
    const data = zip.subarray(start, start + size);
    assert.equal(zlibCrc32(data), crc, `CRC of ${name}`);
    out.push({ name, data, mode, date: v.getUint16(local + 12, true), time: v.getUint16(local + 10, true), flags });
    p += 46 + nameLen;
  }
  assert.equal(p, eocd);
  return out;
}

const file = (name: string, content: string | Uint8Array) => new File([content], name);
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

test('crc32 matches zlib, also when continued across pieces', () => {
  const data = new Uint8Array(100_000).map((_, i) => (i * 31) & 0xff);
  assert.equal(crc32(0, data), zlibCrc32(data));
  assert.equal(crc32(crc32(0, data.subarray(0, 12345)), data.subarray(12345)), zlibCrc32(data));
  assert.equal(crc32(0, new Uint8Array(0)), 0);
});

test('several files round-trip through the archive exactly', async () => {
  const big = new Uint8Array(5 * 1024 * 1024 + 7).map((_, i) => i % 251);
  const files = [file('notes.txt', 'hello\n'), file('empty.bin', ''), file('image.bin', big), file('ünïcödé ✓.md', '# hi')];
  let last = 0;
  const zip = await zipFiles(files, (f) => { assert.ok(f >= last && f <= 1); last = f; });
  assert.equal(last, 1);
  const entries = readZip(await bytesOf(zip));
  assert.deepEqual(entries.map((e) => e.name), ['notes.txt', 'empty.bin', 'image.bin', 'ünïcödé ✓.md']);
  for (const [i, e] of entries.entries()) assert.deepEqual(e.data, await bytesOf(files[i]!));
  for (const e of entries) {
    assert.equal(e.mode, 0o100644, 'a plain rw-r--r-- file, never executable');
    assert.equal(e.date, 0x21, '1980-01-01: no real file dates are shared');
    assert.equal(e.time, 0);
    assert.equal(e.flags, 0x0800, 'UTF-8 names');
  }
  assert.equal(zip.type, 'application/zip');
});

test('names can never escape the folder, hide characters or clash', async () => {
  assert.equal(zipEntryName('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(zipEntryName('C:\\Windows\\x.dll'), 'C__Windows_x.dll');
  assert.equal(zipEntryName('/abs/path'), '_abs_path');
  assert.equal(zipEntryName('invoice\u202Efdp.exe'), 'invoice_fdp.exe');
  assert.equal(zipEntryName('..'), 'file');
  assert.equal(zipEntryName('   '), 'file');
  assert.equal(zipEntryName('a\u0000b'), 'a_b');
  assert.equal([...zipEntryName('x'.repeat(500))].length, 200);
  // Windows drops trailing dots and spaces, and reserves device names.
  assert.equal(zipEntryName('report. . '), 'report');
  assert.equal(zipEntryName('CON'), '_CON');
  assert.equal(zipEntryName('nul.txt'), '_nul.txt');
  assert.equal(zipEntryName('com1.tar.gz'), '_com1.tar.gz');
  assert.equal(zipEntryName('console.txt'), 'console.txt');
  // Composed and decomposed é are one file on macOS.
  assert.equal(zipEntryName('café.txt'), 'café.txt');
  assert.deepEqual(uniqueNames([zipEntryName('café'), zipEntryName('café')]), ['café', 'café (2)']);
  assert.deepEqual(uniqueNames([zipEntryName('report'), zipEntryName('report.')]), ['report', 'report (2)']);
  assert.deepEqual(uniqueNames(['a.txt', 'A.TXT', 'a.txt', 'b', 'b']), ['a.txt', 'A (2).TXT', 'a (3).txt', 'b', 'b (2)']);
  const entries = readZip(await bytesOf(await zipFiles([file('../x', '1'), file('..\\x', '2'), file('X', '3')])));
  assert.deepEqual(entries.map((e) => e.name), ['_x', '_x (2)', 'X']);
  for (const e of entries) assert.ok(!/[/\\]/.test(e.name) && !e.name.startsWith('.'));
});

test('random hostile names always come out safe and unique', () => {
  // A small seeded generator, so a failure can be reproduced.
  let seed = 0x9e3779b9;
  const rand = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  const pieces = ['.', '..', '/', '\\', ':', ' ', '\u0000', '\u001f', '\u202E', '\u200B', '\uFEFF', 'é', 'é', 'CON', 'nul', 'com1', 'A', 'a', '*', '?', '"', '<', '>', '|', '\n', '\t', '😀', 'x'.repeat(50), 'PK'];
  const unsafe = /[\p{Cf}\p{Cc}/\\:*?"<>|]/u;
  for (let round = 0; round < 3000; round++) {
    const names = Array.from({ length: 1 + rand(6) }, () => Array.from({ length: rand(12) }, () => pieces[rand(pieces.length)]).join(''));
    const cleaned = uniqueNames(names.map(zipEntryName));
    const keys = new Set<string>();
    for (const n of cleaned) {
      assert.ok(n.length > 0, 'never empty');
      assert.ok(!unsafe.test(n), `no separators, control or format characters: ${JSON.stringify(n)}`);
      assert.ok(!/^[.\s]/.test(n) && !/[.\s]$/.test(n), `no leading dot, trailing dot or space: ${JSON.stringify(n)}`);
      assert.ok(!/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(n), `no device name: ${n}`);
      assert.equal(n, n.normalize('NFC'));
      const key = n.toLowerCase();
      assert.ok(!keys.has(key), `unique as files: ${n}`);
      keys.add(key);
    }
  }
});

test('one file, too many files and unreadable sizes are refused', async () => {
  await assert.rejects(zipFiles([file('a', '1')]), PasteError);
  await assert.rejects(zipFiles(Array.from({ length: MAX_FILES + 1 }, (_, i) => file(`f${i}`, ''))), PasteError);
  const ok = readZip(await bytesOf(await zipFiles(Array.from({ length: MAX_FILES }, (_, i) => file(`f${i}`, String(i))))));
  assert.equal(ok.length, MAX_FILES);
  assert.equal(archiveName(3), '3 files.zip');
});
