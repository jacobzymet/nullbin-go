// Nullbin blob format. New pastes use version 2; version 1 is still read so
// links shared before version 2 keep working until they expire.
//
//   offset  size  field
//   0       4     magic "NBN1"
//   4       1     version (1 or 2)
//   5       1     flags (bit 0 = password; other bits must be 0)
//   6       16    Argon2id salt (all zero when there is no password)
//   22      24    crypto_secretstream_xchacha20poly1305 header
//   46      ...   frames
//
// Each frame is a 4-byte big-endian ciphertext length followed by that many
// bytes of secretstream ciphertext (plaintext + 17 bytes). The first frame
// is authenticated together with bytes 0..21 (magic, version, flags, salt)
// as additional data. Nothing may follow the TAG_FINAL frame.
//
// Version 2 (padded): the frames carry one plaintext stream
//
//   4-byte big-endian metadata length || metadata JSON || file || zeros
//
// whose total length is paddedLength(4 + metadata length + file size).
// Every frame but the last holds exactly CHUNK_SIZE bytes of that stream;
// the last holds the rest (1 to CHUNK_SIZE bytes) and carries TAG_FINAL.
// The frame layout, and so the blob size, depends only on the padded
// length: text and file pastes of the same padded length look the same.
// The zeros are encrypted and authenticated like everything else, and the
// reader rejects any other padding length or any non-zero padding byte.
//
// Version 1 (unpadded, read only): frame 1 holds the metadata JSON. If the
// paste has no file, frame 1 carries TAG_FINAL. Otherwise file frames
// follow: every frame but the last holds exactly CHUNK_SIZE bytes of file
// content, and the last one carries TAG_FINAL.

export const MAGIC = new Uint8Array([0x4e, 0x42, 0x4e, 0x31]); // "NBN1"
/** The version written for new pastes. */
export const VERSION = 2;
/** The unpadded version, still accepted when reading. */
export const VERSION_UNPADDED = 1;
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

/** Size of the metadata length field at the start of a version 2 stream. */
export const META_LENGTH_BYTES = 4;
/**
 * Every version 2 stream is at least this long, so all short pastes
 * (passwords, keys, messages) have the same size. Small enough that a
 * padded paste still fits the smallest allowed server limit (64 KiB).
 */
export const MIN_PADDED_LENGTH = 16 * 1024;
/**
 * Upper bound on a version 2 stream, far above any server limit. Keeps all
 * size arithmetic exact (below 2^53).
 */
export const MAX_STREAM_LENGTH = 2 ** 48;

/** Number of bits needed to write n (n >= 1). */
function bitLength(n: number): number {
  let bits = 0;
  for (let v = n; v >= 1; v = Math.floor(v / 2)) bits++;
  return bits;
}

/**
 * The padded length of a version 2 stream holding n bytes: at least
 * `minimum` (MIN_PADDED_LENGTH for pastes, COMMENT_PADDED_LENGTH for
 * comments, both powers of two), and above that the Padmé function (Nikitin et al.,
 * "Reducing Metadata Leakage from Encrypted Files and Communication with
 * PURBs", 2019). Padmé rounds n up so that only its top
 * floor(log2(floor(log2 n))) + 2 bits can be non-zero. That leaves
 * O(log log n) bits of size information (371 possible lengths up to
 * 100 MiB), and adds less than 6.25% for streams up to 64 KiB, 3.125% up to
 * 4 GiB and 1.5625% beyond (before the 21 bytes of framing per 64 KiB).
 */
export function paddedLength(n: number, minimum: number = MIN_PADDED_LENGTH): number {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_STREAM_LENGTH) throw new RangeError('bad stream length');
  if (n <= minimum) return minimum;
  const e = bitLength(n) - 1; // floor(log2 n)
  const s = bitLength(e); // floor(log2 e) + 1
  const step = 2 ** (e - s);
  return Math.ceil(n / step) * step;
}

/** Number of frames that carry a version 2 stream of the given length. */
export function frameCount(streamLength: number): number {
  return Math.ceil(streamLength / CHUNK_SIZE);
}

/** Exact blob size of a version 2 paste with the given padded stream length. */
export function blobSize(streamLength: number): number {
  return HEADER_BYTES + frameCount(streamLength) * (FRAME_LENGTH_BYTES + ABYTES) + streamLength;
}

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
   * Readers may comment. Set inside the encrypted metadata so the server
   * cannot switch it on.
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
  /** VERSION or VERSION_UNPADDED. */
  version: number;
  password: boolean;
  salt: Uint8Array;
}

/** Parses and strictly validates the 22-byte blob prefix. */
export function parsePrefix(p: Uint8Array): Prefix {
  if (p.length !== PREFIX_BYTES) throw new PasteError('format', 'Not a Nullbin paste.');
  for (let i = 0; i < MAGIC.length; i++) {
    if (p[i] !== MAGIC[i]) throw new PasteError('format', 'Not a Nullbin paste.');
  }
  const version = p[4] ?? 0;
  if (version !== VERSION && version !== VERSION_UNPADDED) {
    throw new PasteError('format', 'This paste uses an unsupported format version.');
  }
  const flags = p[5] ?? 0;
  if ((flags & ~KNOWN_FLAGS) !== 0) throw new PasteError('format', 'This paste uses unknown options.');
  const password = (flags & FLAG_PASSWORD) !== 0;
  const salt = p.slice(6, 6 + SALT_BYTES);
  if (!password && salt.some((b) => b !== 0)) {
    throw new PasteError('format', 'Malformed paste header.');
  }
  return { version, password, salt };
}

export function encodeFrameLength(n: number): Uint8Array {
  const b = new Uint8Array(FRAME_LENGTH_BYTES);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

export function decodeFrameLength(b: Uint8Array): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, false);
}

/**
 * Validates decrypted metadata. Anything unexpected is rejected. Callers
 * check that the rest of the stream matches the type and size.
 */
export function parseMeta(bytes: Uint8Array): PasteMeta {
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
  if (typeof discussion !== 'boolean') throw bad();
  if (type === 'text') {
    if (filename !== null || mime !== null || size !== 0) throw bad();
    return { type, text, filename: null, mime: null, size: 0, discussion };
  }
  if (type === 'file') {
    if (typeof filename !== 'string' || filename.length === 0 || filename.length > MAX_FILENAME_LENGTH) throw bad();
    if (mime !== null && (typeof mime !== 'string' || mime.length > MAX_MIME_LENGTH)) throw bad();
    return { type, text, filename, mime, size, discussion };
  }
  throw bad();
}

/**
 * How long a download may go without receiving any data. Longer than the
 * server's own 2-minute grace period, so the server always gives up first:
 * the page must never abandon a burn paste the server would still deliver.
 */
export const STALL_MS = 150_000;

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
    if (this.chunk.length > 0 || this.finished) return;
    // A server that stops sending must not leave the page waiting forever.
    // Only time spent waiting for the network counts: while a password or
    // save dialog is open, nothing is being read. One deadline covers the
    // whole wait, so empty pieces of data cannot keep extending it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        stalled = true;
        void this.reader.cancel().catch(() => {});
        reject(new Error('stalled'));
      }, STALL_MS);
    });
    try {
      while (this.chunk.length === 0 && !this.finished) {
        const { done, value } = await Promise.race([this.reader.read(), deadline]);
        if (stalled) break;
        this.finished = done;
        if (!done) {
          this.chunk = value;
          this.received += value.length;
          this.onProgress?.(this.received);
        }
      }
    } catch {
      if (!stalled) throw new PasteError('network', 'The download failed.');
    } finally {
      clearTimeout(timer);
    }
    // Cancelling can end the stream as if it were complete; report the stall.
    if (stalled) throw new PasteError('network', 'The download stopped: no data arrived for over two minutes.');
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
