// Nullbin blob format (version 1).
//
//   offset  size  field
//   0       4     magic "NBN1"
//   4       1     version (1)
//   5       1     flags (bit 0 = password; other bits must be 0)
//   6       16    Argon2id salt (all zero when there is no password)
//   22      24    crypto_secretstream_xchacha20poly1305 header
//   46      ...   frames
//
// Each frame is a 4-byte big-endian ciphertext length followed by that many
// bytes of secretstream ciphertext (plaintext + 17 bytes).
//
// Frame 1 holds the metadata JSON {type, text, filename, mime, size} and is
// authenticated together with bytes 0..21 (magic, version, flags, salt) as
// additional data. If the paste has no file, frame 1 carries TAG_FINAL.
// Otherwise file frames follow: every frame but the last holds exactly
// CHUNK_SIZE bytes of file content, and the last one carries TAG_FINAL.
// Nothing may follow the TAG_FINAL frame.

export const MAGIC = new Uint8Array([0x4e, 0x42, 0x4e, 0x31]); // "NBN1"
export const VERSION = 1;
export const FLAG_PASSWORD = 0x01;
export const KNOWN_FLAGS = FLAG_PASSWORD;

export const KEY_BYTES = 32;
export const SALT_BYTES = 16;
export const PREFIX_BYTES = 4 + 1 + 1 + SALT_BYTES; // 22
export const STREAM_HEADER_BYTES = 24;
export const HEADER_BYTES = PREFIX_BYTES + STREAM_HEADER_BYTES; // 46
export const FRAME_LENGTH_BYTES = 4;
export const ABYTES = 17;

/** Plaintext bytes per file frame. */
export const CHUNK_SIZE = 64 * 1024;
/** Largest metadata frame (JSON including the text) the viewer accepts. */
export const MAX_META_BYTES = 16 * 1024 * 1024;
/** Longest filename kept in metadata. */
export const MAX_FILENAME_LENGTH = 255;
/** Longest MIME type kept in metadata. */
export const MAX_MIME_LENGTH = 255;

export type PasteErrorCode =
  | 'format' // not a Nullbin blob, or an unsupported version
  | 'truncated' // the stream ended early
  | 'tampered' // authentication failed after the first frame
  | 'wrong-key' // the first frame failed to decrypt (bad link or modified)
  | 'wrong-password' // the first frame failed with a password
  | 'too-large' // input exceeds a limit
  | 'cancelled' // the user cancelled the password prompt
  | 'network'; // the download failed

export class PasteError extends Error {
  readonly code: PasteErrorCode;
  constructor(code: PasteErrorCode, message: string) {
    super(message);
    this.name = 'PasteError';
    this.code = code;
  }
}

export interface PasteMeta {
  type: 'text' | 'file';
  text: string;
  filename: string | null;
  mime: string | null;
  /** File size in bytes; 0 for a text-only paste. */
  size: number;
  /**
   * Readers may comment. Only valid together with a password, and set
   * inside the encrypted metadata so the server cannot switch it on.
   */
  discussion: boolean;
}

export function buildPrefix(password: boolean, salt: Uint8Array): Uint8Array {
  if (salt.length !== SALT_BYTES) throw new Error('bad salt length');
  const p = new Uint8Array(PREFIX_BYTES);
  p.set(MAGIC, 0);
  p[4] = VERSION;
  p[5] = password ? FLAG_PASSWORD : 0;
  p.set(salt, 6);
  return p;
}

export interface Prefix {
  password: boolean;
  salt: Uint8Array;
}

/** Parses and strictly validates the 22-byte blob prefix. */
export function parsePrefix(p: Uint8Array): Prefix {
  if (p.length !== PREFIX_BYTES) throw new PasteError('format', 'Not a Nullbin paste.');
  for (let i = 0; i < MAGIC.length; i++) {
    if (p[i] !== MAGIC[i]) throw new PasteError('format', 'Not a Nullbin paste.');
  }
  if (p[4] !== VERSION) throw new PasteError('format', 'This paste uses an unsupported format version.');
  const flags = p[5] ?? 0;
  if ((flags & ~KNOWN_FLAGS) !== 0) throw new PasteError('format', 'This paste uses unknown options.');
  const password = (flags & FLAG_PASSWORD) !== 0;
  const salt = p.slice(6, 6 + SALT_BYTES);
  if (!password && salt.some((b) => b !== 0)) {
    throw new PasteError('format', 'Malformed paste header.');
  }
  return { password, salt };
}

export function encodeFrameLength(n: number): Uint8Array {
  const b = new Uint8Array(FRAME_LENGTH_BYTES);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

export function decodeFrameLength(b: Uint8Array): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, false);
}

/** Number of file frames used for a file of the given size. */
export function fileFrameCount(size: number): number {
  return size === 0 ? 1 : Math.ceil(size / CHUNK_SIZE);
}

/** Exact blob size for a metadata frame of metaBytes and an optional file. */
export function blobSize(metaBytes: number, fileSize: number | null): number {
  let n = HEADER_BYTES + FRAME_LENGTH_BYTES + ABYTES + metaBytes;
  if (fileSize !== null) n += fileFrameCount(fileSize) * (FRAME_LENGTH_BYTES + ABYTES) + fileSize;
  return n;
}

/** Validates decrypted metadata. Anything unexpected is rejected. */
export function parseMeta(bytes: Uint8Array, final: boolean, hasPassword: boolean): PasteMeta {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new PasteError('format', 'Malformed paste metadata.');
  }
  const bad = () => new PasteError('format', 'Malformed paste metadata.');
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw bad();
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'discussion,filename,mime,size,text,type') throw bad();
  const { type, text, filename, mime, size, discussion } = o;
  if (typeof text !== 'string') throw bad();
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw bad();
  if (typeof discussion !== 'boolean' || (discussion && !hasPassword)) throw bad();
  if (type === 'text') {
    if (!final || filename !== null || mime !== null || size !== 0) throw bad();
    return { type, text, filename: null, mime: null, size: 0, discussion };
  }
  if (type === 'file') {
    if (final) throw bad();
    if (typeof filename !== 'string' || filename.length === 0 || filename.length > MAX_FILENAME_LENGTH) throw bad();
    if (mime !== null && (typeof mime !== 'string' || mime.length > MAX_MIME_LENGTH)) throw bad();
    return { type, text, filename, mime, size, discussion };
  }
  throw bad();
}

/** How long a download may go without receiving anything. */
export const STALL_MS = 60_000;

/**
 * Reads on demand, keeping at most one unread network chunk. Password and
 * save dialogs apply backpressure instead of buffering the attachment.
 * Single consumer only. Cancel on failure or when the viewer goes away.
 */
export class ByteReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunk: Uint8Array = new Uint8Array(0);
  private finished = false;
  private busy = false;
  received = 0;
  private readonly onProgress: ((received: number) => void) | undefined;

  constructor(stream: ReadableStream<Uint8Array>, onProgress?: (received: number) => void) {
    this.onProgress = onProgress;
    this.reader = stream.getReader();
  }

  private async fill(): Promise<void> {
    while (this.chunk.length === 0 && !this.finished) {
      // A server that stops sending must not leave the page waiting forever.
      // Only time spent waiting for the network counts: while a password or
      // save dialog is open, nothing is being read.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void this.reader.cancel().catch(() => {});
          reject(new Error('stalled'));
        }, STALL_MS);
      });
      try {
        const { done, value } = await Promise.race([this.reader.read(), stalled]);
        this.finished = done;
        if (!done) {
          this.chunk = value;
          this.received += value.length;
          this.onProgress?.(this.received);
        }
      } catch {
        throw new PasteError('network', 'The download failed.');
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async cancel(): Promise<void> {
    this.finished = true;
    this.chunk = new Uint8Array(0);
    await this.reader.cancel().catch(() => {});
  }

  /** Returns exactly n bytes, bounded by the largest valid frame. */
  async read(n: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_META_BYTES + ABYTES) throw new PasteError('too-large', 'Malformed paste data.');
    if (this.busy) throw new Error('ByteReader supports one reader at a time');
    this.busy = true;
    try {
      const out = new Uint8Array(n);
      let off = 0;
      while (off < n) {
        await this.fill();
        if (this.chunk.length === 0) throw new PasteError('truncated', 'The paste is incomplete (the data ended early).');
        const take = Math.min(n - off, this.chunk.length);
        out.set(this.chunk.subarray(0, take), off);
        this.chunk = this.chunk.subarray(take);
        off += take;
      }
      return out;
    } finally {
      this.busy = false;
    }
  }

  async atEnd(): Promise<boolean> {
    if (this.busy) throw new Error('ByteReader supports one reader at a time');
    this.busy = true;
    try {
      await this.fill();
      return this.chunk.length === 0;
    } finally {
      this.busy = false;
    }
  }
}
