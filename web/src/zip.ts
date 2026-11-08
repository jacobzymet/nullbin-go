// Several attachments travel as one zip archive, built here in the browser
// and then encrypted like any single file. The paste format, the server and
// the viewer's verify-before-saving rules are unchanged.
//
// The archive is deliberately minimal: stored (no compression), so its size
// is known before encryption starts; a fixed 1980-01-01 timestamp, so file
// dates are not shared; ordinary rw-r--r-- files, never executable;
// cleaned, unique names without folders; and no extra fields. Files are
// referenced, not copied: memory use does not grow with their size.

import { PasteError } from './format.ts';

/** Most files one paste can hold. */
export const MAX_FILES = 100;
const READ_BLOCK = 4 * 1024 * 1024;
const UINT32_MAX = 0xffffffff;
const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;
const UTF8_NAMES = 0x0800;
const REGULAR_FILE_RW_R_R = (0o100644 << 16) >>> 0;
const MADE_BY_UNIX = (3 << 8) | 20;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Continues a CRC-32 (start with 0) over more bytes. */
export function crc32(crc: number, bytes: Uint8Array): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Names Windows reserves for devices, alone or followed by an extension or
// spaces.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)([\s.].*)?$/i;

/**
 * A file name with no folders, drive letters, control or direction
 * characters, leading dots, trailing dots or spaces (which Windows drops)
 * or Windows device names, so saving or extracting it can never write
 * outside the chosen folder, hide what it is, or land on another file.
 * Used for single downloads and for names inside archives.
 */
export function cleanFileName(name: string, fallback: string): string {
  let cleaned = name.normalize('NFC').replace(/[\p{Cf}\p{Cc}/\\:*?"<>|]/gu, '_').replace(/^[.\s]+/, '');
  cleaned = [...cleaned].slice(0, 200).join('').replace(/[.\s]+$/, '');
  if (WINDOWS_DEVICE.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned || fallback;
}

/** A name for inside the archive (see cleanFileName). */
export function zipEntryName(name: string): string {
  return cleanFileName(name, 'file');
}

/**
 * Makes names unique as extracted files: ignoring case, as Windows and macOS
 * do. (Names are already in NFC, which macOS also treats as equal to NFD.)
 */
export function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const key = (n: string) => n.normalize('NFC').toLowerCase();
  return names.map((name) => {
    let candidate = name;
    for (let i = 2; seen.has(key(candidate)); i++) {
      const dot = name.lastIndexOf('.');
      candidate = dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
    }
    seen.add(key(candidate));
    return candidate;
  });
}

/** The archive's name, as the reader sees it. */
export function archiveName(count: number): string {
  return `${count} files.zip`;
}

/**
 * Builds the archive. Each file is read once to compute its CRC-32; the
 * returned Blob references the files rather than copying them.
 */
export async function zipFiles(files: readonly File[], onProgress?: (fraction: number) => void): Promise<Blob> {
  if (files.length < 2 || files.length > MAX_FILES) throw new PasteError('too-large', `Attach from 2 to ${MAX_FILES} files.`);
  const names = uniqueNames(files.map((f) => zipEntryName(f.name)));
  const total = files.reduce((n, f) => n + f.size, 0);
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  let done = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const name = encoder.encode(names[i]!);
    let crc = 0;
    let read = 0;
    for (let off = 0; off < file.size; off += READ_BLOCK) {
      const block = new Uint8Array(await file.slice(off, Math.min(off + READ_BLOCK, file.size)).arrayBuffer());
      crc = crc32(crc, block);
      read += block.length;
      done += block.length;
      onProgress?.(total > 0 ? done / total : 1);
    }
    if (read !== file.size) throw new PasteError('format', `${names[i]} changed while it was being read.`);
    if (file.size > UINT32_MAX || offset > UINT32_MAX) throw new PasteError('too-large', 'The files are too large together.');

    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 10, true); // version needed: stored entries
    l.setUint16(6, UTF8_NAMES, true);
    l.setUint16(8, 0, true); // stored
    l.setUint16(10, 0, true); // 00:00:00
    l.setUint16(12, DOS_DATE_1980_01_01, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, file.size, true);
    l.setUint32(22, file.size, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true); // no extra fields
    local.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, MADE_BY_UNIX, true);
    c.setUint16(6, 10, true);
    c.setUint16(8, UTF8_NAMES, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, 0, true);
    c.setUint16(14, DOS_DATE_1980_01_01, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, file.size, true);
    c.setUint32(24, file.size, true);
    c.setUint16(28, name.length, true);
    c.setUint16(30, 0, true); // extra
    c.setUint16(32, 0, true); // comment
    c.setUint16(34, 0, true); // disk
    c.setUint16(36, 0, true); // internal attributes
    c.setUint32(38, REGULAR_FILE_RW_R_R, true);
    c.setUint32(42, offset, true);
    entry.set(name, 46);

    parts.push(local, file);
    central.push(entry);
    offset += local.length + file.size;
  }
  const centralSize = central.reduce((n, e) => n + e.length, 0);
  if (offset > UINT32_MAX || offset + centralSize > UINT32_MAX) throw new PasteError('too-large', 'The files are too large together.');
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(4, 0, true);
  e.setUint16(6, 0, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  e.setUint16(20, 0, true); // no comment
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
