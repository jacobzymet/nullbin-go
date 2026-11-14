// Nullbin paste encryption. Everything here runs in the browser; the server
// only ever receives ciphertext and, for discussions, a derived token.
//
// Keys:
//   fragmentKey = 32 random bytes, carried in the URL fragment
//   no password: master = fragmentKey
//   password:    master = BLAKE2b-256(key = fragmentKey,
//                           message = Argon2id(password, salt,
//                                              OPSLIMIT_MODERATE, MEMLIMIT_MODERATE))
//   Independent subkeys (crypto_kdf_derive_from_key, id 1):
//     stream key        context "nbstream"  encrypts the paste
//     comment key       context "nbcmtenc"  encrypts comments (comments.ts)
//     comment token     context "nbcmtacc"  sent to the server; its hash gates
//                                           reading and posting comments
//     burn token        context "nbburnac"  sent to the server; its hash gates
//                                           opening a burn paste
//     recipient key     context "nbrcptac"  never sent; keys the recipient tokens
//   Separate links: each recipient link carries its own 16 random bytes, and
//   its token is BLAKE2b-256(key = recipient key, message = those bytes). A
//   token needs both the link and any password, and a recipient who knows the
//   key but not another link's bytes cannot compute that link's token.
// Encryption: crypto_secretstream_xchacha20poly1305 (see format.ts). New
// pastes are padded (format version 2) so their size reveals only a range.

import type { Sodium } from './sodium.ts';
import {
  ABYTES,
  ByteReader,
  CHUNK_SIZE,
  FRAME_LENGTH_BYTES,
  KEY_BYTES,
  MAX_FILENAME_LENGTH,
  MAX_META_BYTES,
  MAX_MIME_LENGTH,
  MAX_STREAM_LENGTH,
  META_LENGTH_BYTES,
  PasteError,
  PREFIX_BYTES,
  SALT_BYTES,
  STREAM_HEADER_BYTES,
  VERSION,
  blobSize,
  buildPrefix,
  decodeFrameLength,
  encodeFrameLength,
  paddedLength,
  parseMeta,
  parsePrefix,
  type PasteMeta,
} from './format.ts';

export interface PasteInput {
  text: string;
  file: Blob | null;
  filename: string | null;
  mime: string | null;
  /** Empty string means no password. */
  password: string;
  /** Let readers comment. With a password, only readers who know it can. */
  discussion: boolean;
  /** Number of separate recipient links (2 to MAX_RECIPIENTS), or 0 for one shared link. */
  recipients?: number;
}

export interface PreparedPaste {
  /** Goes into the URL fragment. Never sent to the server. */
  fragmentKey: Uint8Array;
  /** Exact size of the blob that chunks() produces. */
  totalSize: number;
  /** Sent to the server when the paste has a discussion, else null. */
  commentToken: string | null;
  /** Separate capability derived from the master key; only used for burn pastes. */
  burnToken: string;
  /** One secret per recipient link, for its URL fragment. Never sent to the server. */
  recipientSecrets: Uint8Array[];
  /** The access token of each recipient link, in the same order; sent to the server. */
  recipientTokens: string[];
  /** Produces the blob. Call once. */
  chunks: () => AsyncGenerator<Uint8Array, void, undefined>;
}

/** Keys a reader of a discussion paste needs. */
export interface DiscussionKeys {
  /** Authorizes reading and posting comments (the server stores its hash). */
  token: string;
  /** Encrypts and decrypts comments. Never leaves the browser. */
  key: Uint8Array;
}

function subkey(sodium: Sodium, master: Uint8Array, context: string): Uint8Array {
  return sodium.crypto_kdf_derive_from_key(KEY_BYTES, 1, context, master);
}

/** Authorizes consuming a burn paste without disclosing an encryption key. */
export function burnAccessToken(sodium: Sodium, master: Uint8Array): string {
  const bytes = subkey(sodium, master, 'nbburnac');
  const token = sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
  sodium.memzero(bytes);
  return token;
}

/** Fewest and most separate recipient links a paste can have. */
export const MIN_RECIPIENTS = 2;
export const MAX_RECIPIENTS = 20;
/** Length of the secret that each recipient link carries. */
export const RECIPIENT_SECRET_BYTES = 16;

/**
 * Authorizes opening a paste through one recipient link. It needs the master
 * key (the link key and any password) and that link's own secret.
 */
export function recipientAccessToken(sodium: Sodium, master: Uint8Array, secret: Uint8Array): string {
  if (secret.length !== RECIPIENT_SECRET_BYTES) throw new Error('bad recipient secret');
  const key = subkey(sodium, master, 'nbrcptac');
  const bytes = sodium.crypto_generichash(KEY_BYTES, secret, key);
  sodium.memzero(key);
  const token = sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
  sodium.memzero(bytes);
  return token;
}

/** Derives the discussion token and comment key from the master key. */
export function discussionKeys(sodium: Sodium, master: Uint8Array): DiscussionKeys {
  const tokenBytes = subkey(sodium, master, 'nbcmtacc');
  const token = sodium.to_base64(tokenBytes, sodium.base64_variants.URLSAFE_NO_PADDING);
  sodium.memzero(tokenBytes);
  return { token, key: subkey(sodium, master, 'nbcmtenc') };
}

/** How many file bytes are read from disk at a time. */
const READ_BLOCK = 16 * CHUNK_SIZE;

/** Derives the final key from the fragment key and a password. */
export function deriveKey(sodium: Sodium, fragmentKey: Uint8Array, password: string, salt: Uint8Array): Uint8Array {
  if (fragmentKey.length !== KEY_BYTES || salt.length !== SALT_BYTES) throw new Error('bad key or salt length');
  const pw = sodium.from_string(password.normalize('NFC'));
  const stretched = sodium.crypto_pwhash(
    KEY_BYTES,
    pw,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_MODERATE,
    sodium.crypto_pwhash_MEMLIMIT_MODERATE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  const key = sodium.crypto_generichash(KEY_BYTES, stretched, fragmentKey);
  sodium.memzero(stretched);
  sodium.memzero(pw);
  return key;
}

/**
 * Validates the input, derives the keys (running Argon2id if there is a
 * password, which blocks for about a second) and computes the exact blob
 * size.
 */
export function preparePaste(sodium: Sodium, input: PasteInput): PreparedPaste {
  const hasFile = input.file !== null;
  if (!hasFile && input.text.length === 0) throw new PasteError('format', 'Add some text or attach a file first.');
  const hasPassword = input.password.length > 0;
  const recipients = input.recipients ?? 0;
  if (recipients !== 0 && (!Number.isSafeInteger(recipients) || recipients < MIN_RECIPIENTS || recipients > MAX_RECIPIENTS || input.discussion)) {
    throw new PasteError('format', `Separate links need ${MIN_RECIPIENTS} to ${MAX_RECIPIENTS} people, and no discussion.`);
  }
  const filename = hasFile ? (input.filename || 'file').slice(0, MAX_FILENAME_LENGTH) : null;
  const mime = hasFile && input.mime ? input.mime.slice(0, MAX_MIME_LENGTH) : null;
  const meta: PasteMeta = {
    type: hasFile ? 'file' : 'text',
    text: input.text,
    filename,
    mime,
    size: input.file?.size ?? 0,
    discussion: input.discussion,
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  if (metaBytes.length > MAX_META_BYTES) {
    throw new PasteError('too-large', 'The text is too long. The limit is about 16 MiB.');
  }
  const streamLength = META_LENGTH_BYTES + metaBytes.length + meta.size;
  if (streamLength > MAX_STREAM_LENGTH) throw new PasteError('too-large', 'The file is too large.');
  const padded = paddedLength(streamLength);

  const fragmentKey = sodium.randombytes_buf(KEY_BYTES);
  const salt = hasPassword ? sodium.randombytes_buf(SALT_BYTES) : new Uint8Array(SALT_BYTES);
  const prefix = buildPrefix(hasPassword, salt);
  const master = hasPassword ? deriveKey(sodium, fragmentKey, input.password, salt) : fragmentKey.slice();
  const streamKey = subkey(sodium, master, 'nbstream');
  const burnToken = burnAccessToken(sodium, master);
  const recipientSecrets = Array.from({ length: recipients }, () => sodium.randombytes_buf(RECIPIENT_SECRET_BYTES));
  const recipientTokens = recipientSecrets.map((secret) => recipientAccessToken(sodium, master, secret));
  let commentToken: string | null = null;
  if (input.discussion) {
    const d = discussionKeys(sodium, master);
    commentToken = d.token;
    sodium.memzero(d.key);
  }
  sodium.memzero(master);
  const file = input.file;
  let used = false;

  async function* chunks(): AsyncGenerator<Uint8Array, void, undefined> {
    if (used) throw new Error('chunks() may only be called once');
    used = true;
    const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(streamKey);
    sodium.memzero(streamKey);
    const TAG_MESSAGE = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    const TAG_FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;

    const head = new Uint8Array(PREFIX_BYTES + STREAM_HEADER_BYTES);
    head.set(prefix, 0);
    head.set(header, PREFIX_BYTES);
    yield head;

    // The stream (metadata length, metadata, file, zero padding) is cut
    // into frames of exactly CHUNK_SIZE bytes; only the last may be shorter.
    const plain = new Uint8Array(CHUNK_SIZE);
    let fill = 0; // bytes waiting in `plain`
    let written = 0; // stream bytes already encrypted
    const flush = (): Uint8Array => {
      if (fill === 0 || written + fill > padded) throw new Error('padding length mismatch');
      const final = written + fill === padded;
      const ad = written === 0 ? prefix : null;
      const ct = sodium.crypto_secretstream_xchacha20poly1305_push(state, plain.subarray(0, fill), ad, final ? TAG_FINAL : TAG_MESSAGE);
      written += fill;
      fill = 0;
      const out = new Uint8Array(FRAME_LENGTH_BYTES + ct.length);
      out.set(encodeFrameLength(ct.length), 0);
      out.set(ct, FRAME_LENGTH_BYTES);
      return out;
    };
    function* put(bytes: Uint8Array): Generator<Uint8Array, void, undefined> {
      for (let off = 0; off < bytes.length; ) {
        const n = Math.min(CHUNK_SIZE - fill, bytes.length - off);
        plain.set(bytes.subarray(off, off + n), fill);
        fill += n;
        off += n;
        if (fill === CHUNK_SIZE) yield flush();
      }
    }

    try {
      yield* put(encodeFrameLength(metaBytes.length)); // same 4-byte big-endian encoding
      yield* put(metaBytes);
      if (file) {
        // Exactly meta.size bytes, the size the padding was computed from.
        const size = meta.size;
        for (let off = 0; off < size; off += READ_BLOCK) {
          const want = Math.min(READ_BLOCK, size - off);
          const block = new Uint8Array(await file.slice(off, off + want).arrayBuffer());
          if (block.length !== want || file.size !== size) throw new Error('The file changed while reading it.');
          yield* put(block);
        }
      }
      const zeros = new Uint8Array(CHUNK_SIZE);
      for (let left = padded - streamLength; left > 0; ) {
        const n = Math.min(left, CHUNK_SIZE);
        yield* put(zeros.subarray(0, n));
        left -= n;
      }
      if (fill > 0) yield flush();
      if (written !== padded) throw new Error('padding length mismatch');
    } finally {
      sodium.memzero(plain);
    }
  }

  return { fragmentKey, totalSize: blobSize(padded), commentToken, burnToken, recipientSecrets, recipientTokens, chunks };
}

export interface OpenedPaste {
  meta: PasteMeta;
  /** Set when the paste has a discussion. */
  discussion: DiscussionKeys | null;
  /**
   * Decrypted file content for file pastes, null for text-only pastes.
   * Chunks are yielded as they are verified, but the stream as a whole is
   * only authentic if the iterator finishes without throwing: it throws on
   * truncation, tampering or trailing data. Do not commit the data (close a
   * file, create a download) before it finishes.
   */
  file: AsyncGenerator<Uint8Array, void, undefined> | null;
  /**
   * The exact blob size implied by the authenticated metadata: what the
   * server stores, but not taken from anything the server says.
   */
  blobSize: number;
}

/**
 * Called when the paste needs a password. attempt starts at 0 and grows
 * after each wrong password. Return null to cancel.
 */
export type PasswordPrompt = (attempt: number) => Promise<string | null>;

type PullState = ReturnType<Sodium['crypto_secretstream_xchacha20poly1305_init_pull']>;
interface Pulled {
  message: Uint8Array;
  tag: number;
}

async function readFrame(src: ByteReader, maxPlain: number): Promise<Uint8Array> {
  const len = decodeFrameLength(await src.read(FRAME_LENGTH_BYTES));
  if (len < ABYTES || len > maxPlain + ABYTES) throw new PasteError('format', 'Malformed paste data.');
  return src.read(len);
}

/** Decrypts one frame; null if it is not authentic. */
function pull(sodium: Sodium, state: PullState, ct: Uint8Array, ad: Uint8Array | null): Pulled | null {
  try {
    return sodium.crypto_secretstream_xchacha20poly1305_pull(state, ct, ad) || null;
  } catch {
    return null;
  }
}

const malformed = () => new PasteError('format', 'Malformed paste data.');
const trailing = () => new PasteError('tampered', 'Unexpected data after the end of the paste.');

/**
 * Opens a paste: parses the header, asks for a password if needed,
 * decrypts and validates the metadata, and returns an iterator over the
 * file content (if any).
 */
export async function openPaste(
  sodium: Sodium,
  src: ByteReader,
  fragmentKey: Uint8Array,
  askPassword: PasswordPrompt,
): Promise<OpenedPaste> {
  if (fragmentKey.length !== KEY_BYTES) throw new PasteError('wrong-key', 'The link is not valid.');
  const prefixBytes = await src.read(PREFIX_BYTES);
  const prefix = parsePrefix(prefixBytes);
  const padded = prefix.version === VERSION;
  const header = await src.read(STREAM_HEADER_BYTES);
  const first = await readFrame(src, padded ? CHUNK_SIZE : MAX_META_BYTES);

  const tryKey = (master: Uint8Array) => {
    const streamKey = subkey(sodium, master, 'nbstream');
    const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, streamKey);
    sodium.memzero(streamKey);
    const res = pull(sodium, state, first, prefixBytes);
    return res ? { state, res } : null;
  };

  let master: Uint8Array;
  let opened: NonNullable<ReturnType<typeof tryKey>>;
  if (!prefix.password) {
    master = fragmentKey.slice();
    const r = tryKey(master);
    if (!r) {
      sodium.memzero(master);
      throw new PasteError('wrong-key', 'This paste can’t be decrypted. The link may be incomplete, or the paste was changed.');
    }
    opened = r;
  } else {
    // The first frame stays buffered, so a wrong password can be retried
    // without downloading the paste again.
    for (let attempt = 0; ; attempt++) {
      const password = await askPassword(attempt);
      if (password === null) throw new PasteError('cancelled', 'Cancelled.');
      const candidate = deriveKey(sodium, fragmentKey, password, prefix.salt);
      const r = tryKey(candidate);
      if (r) {
        master = candidate;
        opened = r;
        break;
      }
      sodium.memzero(candidate);
    }
  }

  try {
    return padded
      ? await openPadded(sodium, src, opened.state, opened.res, master)
      : await openUnpadded(sodium, src, opened.state, opened.res, master);
  } finally {
    sodium.memzero(master);
  }
}

/**
 * Format version 2. Reads the metadata from the stream, then checks that
 * the stream ends exactly at the padded length, with only zeros after the
 * content. The caller zeroes master.
 */
async function openPadded(sodium: Sodium, src: ByteReader, state: PullState, first: Pulled, master: Uint8Array): Promise<OpenedPaste> {
  const TAG_MESSAGE = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
  const TAG_FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
  // Every frame but the last is full, and no frame is empty.
  const validFrame = (r: Pulled) =>
    (r.tag === TAG_MESSAGE && r.message.length === CHUNK_SIZE) || (r.tag === TAG_FINAL && r.message.length > 0);
  if (!validFrame(first)) throw malformed();

  let buf = first.message; // decrypted bytes not yet consumed
  let final = first.tag === TAG_FINAL; // buf is the end of the stream
  let decrypted = first.message.length; // stream bytes decrypted so far
  let expected = MAX_STREAM_LENGTH; // the padded length, once the metadata is known

  const nextFrame = async () => {
    if (final) throw malformed(); // the stream ended before its content did
    const r = pull(sodium, state, await readFrame(src, CHUNK_SIZE), null);
    if (!r) throw new PasteError('tampered', 'The paste was modified or corrupted.');
    if (!validFrame(r)) throw malformed();
    decrypted += r.message.length;
    if (decrypted > expected) throw malformed();
    final = r.tag === TAG_FINAL;
    buf = r.message;
  };
  const readExact = async (n: number): Promise<Uint8Array> => {
    const out = new Uint8Array(n);
    for (let off = 0; off < n; ) {
      if (buf.length === 0) await nextFrame();
      const k = Math.min(n - off, buf.length);
      out.set(buf.subarray(0, k), off);
      buf = buf.subarray(k);
      off += k;
    }
    return out;
  };
  // Everything after the content must be zeros, up to exactly the padded
  // length, and nothing may follow the stream.
  const finish = async () => {
    for (;;) {
      for (const b of buf) if (b !== 0) throw malformed();
      buf = new Uint8Array(0);
      if (final) break;
      await nextFrame();
    }
    if (decrypted !== expected) throw malformed();
    if (!(await src.atEnd())) throw trailing();
  };

  const metaLength = decodeFrameLength(await readExact(META_LENGTH_BYTES)); // same 4-byte encoding
  if (metaLength > MAX_META_BYTES) throw malformed();
  const meta = parseMeta(await readExact(metaLength));
  const contentLength = META_LENGTH_BYTES + metaLength + meta.size;
  if (contentLength > MAX_STREAM_LENGTH) throw malformed();
  expected = paddedLength(contentLength);
  if (decrypted > expected || (final && decrypted !== expected)) throw malformed();
  const discussion = meta.discussion ? discussionKeys(sodium, master) : null;
  sodium.memzero(master);

  if (meta.type === 'text') {
    try {
      await finish();
    } catch (e) {
      if (discussion) sodium.memzero(discussion.key);
      throw e;
    }
    return { meta, discussion, file: null, blobSize: blobSize(expected) };
  }
  async function* file(): AsyncGenerator<Uint8Array, void, undefined> {
    for (let left = meta.size; left > 0; ) {
      if (buf.length === 0) await nextFrame();
      const k = Math.min(left, buf.length);
      const piece = buf.subarray(0, k);
      buf = buf.subarray(k);
      left -= k;
      yield piece;
    }
    await finish();
  }
  return { meta, discussion, file: file(), blobSize: blobSize(expected) };
}

/** Format version 1 (unpadded), read only. The caller zeroes master. */
async function openUnpadded(sodium: Sodium, src: ByteReader, state: PullState, first: Pulled, master: Uint8Array): Promise<OpenedPaste> {
  const TAG_MESSAGE = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
  const TAG_FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
  if (first.tag !== TAG_MESSAGE && first.tag !== TAG_FINAL) throw malformed();
  const final = first.tag === TAG_FINAL;
  const meta = parseMeta(first.message);
  // A text paste is the final frame; a file paste is followed by file frames.
  if ((meta.type === 'text') !== final) throw new PasteError('format', 'Malformed paste metadata.');
  const discussion = meta.discussion ? discussionKeys(sodium, master) : null;
  sodium.memzero(master);
  // Header, metadata frame, then file frames (one empty frame for an empty file).
  const frame = FRAME_LENGTH_BYTES + ABYTES;
  const fileFrames = final ? 0 : Math.max(1, Math.ceil(meta.size / CHUNK_SIZE));
  const size = PREFIX_BYTES + STREAM_HEADER_BYTES + frame + first.message.length + fileFrames * frame + meta.size;
  if (final) {
    if (!(await src.atEnd())) {
      if (discussion) sodium.memzero(discussion.key);
      throw trailing();
    }
    return { meta, discussion, file: null, blobSize: size };
  }

  async function* file(): AsyncGenerator<Uint8Array, void, undefined> {
    let total = 0;
    for (;;) {
      if (await src.atEnd()) throw new PasteError('truncated', 'The paste is incomplete (the data ended early).');
      const ct = await readFrame(src, CHUNK_SIZE);
      const r = pull(sodium, state, ct, null);
      if (!r) throw new PasteError('tampered', 'The paste was modified or corrupted.');
      const n = r.message.length;
      total += n;
      if (r.tag === TAG_MESSAGE) {
        if (n !== CHUNK_SIZE || total >= meta.size) throw malformed();
        yield r.message;
        continue;
      }
      if (r.tag !== TAG_FINAL) throw malformed();
      if (total !== meta.size || (n === 0 && meta.size !== 0)) {
        throw new PasteError('tampered', 'The file size does not match.');
      }
      if (!(await src.atEnd())) throw trailing();
      yield r.message;
      return;
    }
  }
  return { meta, discussion, file: file(), blobSize: size };
}
