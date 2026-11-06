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
// Encryption: crypto_secretstream_xchacha20poly1305 (see format.ts).

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
  PasteError,
  PREFIX_BYTES,
  SALT_BYTES,
  STREAM_HEADER_BYTES,
  blobSize,
  buildPrefix,
  decodeFrameLength,
  encodeFrameLength,
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
  /** Let readers comment. Requires a password. */
  discussion: boolean;
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
  if (input.discussion && !hasPassword) throw new PasteError('format', 'A discussion needs a password.');
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

  const fragmentKey = sodium.randombytes_buf(KEY_BYTES);
  const salt = hasPassword ? sodium.randombytes_buf(SALT_BYTES) : new Uint8Array(SALT_BYTES);
  const prefix = buildPrefix(hasPassword, salt);
  const master = hasPassword ? deriveKey(sodium, fragmentKey, input.password, salt) : fragmentKey.slice();
  const streamKey = subkey(sodium, master, 'nbstream');
  const burnToken = burnAccessToken(sodium, master);
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
    const frame = (plain: Uint8Array, ad: Uint8Array | null, tag: number): Uint8Array => {
      const ct = sodium.crypto_secretstream_xchacha20poly1305_push(state, plain, ad, tag);
      const out = new Uint8Array(FRAME_LENGTH_BYTES + ct.length);
      out.set(encodeFrameLength(ct.length), 0);
      out.set(ct, FRAME_LENGTH_BYTES);
      return out;
    };

    const head = new Uint8Array(PREFIX_BYTES + STREAM_HEADER_BYTES);
    head.set(prefix, 0);
    head.set(header, PREFIX_BYTES);
    yield head;
    yield frame(metaBytes, prefix, file ? TAG_MESSAGE : TAG_FINAL);
    if (!file) return;

    if (file.size === 0) {
      yield frame(new Uint8Array(0), null, TAG_FINAL);
      return;
    }
    for (let off = 0; off < file.size; off += READ_BLOCK) {
      const block = new Uint8Array(await file.slice(off, Math.min(off + READ_BLOCK, file.size)).arrayBuffer());
      if (block.length !== Math.min(READ_BLOCK, file.size - off)) throw new Error('The file changed while reading it.');
      for (let i = 0; i < block.length; i += CHUNK_SIZE) {
        const piece = block.subarray(i, Math.min(i + CHUNK_SIZE, block.length));
        const last = off + i + piece.length === file.size;
        yield frame(piece, null, last ? TAG_FINAL : TAG_MESSAGE);
      }
    }
  }

  return { fragmentKey, totalSize: blobSize(metaBytes.length, file ? file.size : null), commentToken, burnToken, chunks };
}

export interface OpenedPaste {
  meta: PasteMeta;
  /** Set when the paste has a discussion (always password-protected). */
  discussion: DiscussionKeys | null;
  /**
   * Decrypted file content for file pastes, null for text-only pastes.
   * Chunks are yielded as they are verified, but the stream as a whole is
   * only authentic if the iterator finishes without throwing: it throws on
   * truncation, tampering or trailing data. Do not commit the data (close a
   * file, create a download) before it finishes.
   */
  file: AsyncGenerator<Uint8Array, void, undefined> | null;
}

/**
 * Called when the paste needs a password. attempt starts at 0 and grows
 * after each wrong password. Return null to cancel.
 */
export type PasswordPrompt = (attempt: number) => Promise<string | null>;

async function readFrame(src: ByteReader, maxPlain: number): Promise<Uint8Array> {
  const len = decodeFrameLength(await src.read(FRAME_LENGTH_BYTES));
  if (len < ABYTES || len > maxPlain + ABYTES) throw new PasteError('format', 'Malformed paste data.');
  return src.read(len);
}

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
  const header = await src.read(STREAM_HEADER_BYTES);
  const first = await readFrame(src, MAX_META_BYTES);

  const TAG_MESSAGE = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
  const TAG_FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
  const pull = (state: ReturnType<Sodium['crypto_secretstream_xchacha20poly1305_init_pull']>, ct: Uint8Array, ad: Uint8Array | null) => {
    try {
      return sodium.crypto_secretstream_xchacha20poly1305_pull(state, ct, ad) || null;
    } catch {
      return null;
    }
  };

  const tryKey = (master: Uint8Array) => {
    const streamKey = subkey(sodium, master, 'nbstream');
    const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, streamKey);
    sodium.memzero(streamKey);
    const res = pull(state, first, prefixBytes);
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

  const { state, res } = opened;
  if (res.tag !== TAG_MESSAGE && res.tag !== TAG_FINAL) throw new PasteError('format', 'Malformed paste data.');
  const final = res.tag === TAG_FINAL;
  let meta: PasteMeta;
  try {
    meta = parseMeta(res.message, final, prefix.password);
  } catch (e) {
    sodium.memzero(master);
    throw e;
  }
  const discussion = meta.discussion ? discussionKeys(sodium, master) : null;
  sodium.memzero(master);
  if (final) {
    if (!(await src.atEnd())) throw new PasteError('tampered', 'Unexpected data after the end of the paste.');
    return { meta, discussion, file: null };
  }

  const s = state;
  async function* file(): AsyncGenerator<Uint8Array, void, undefined> {
    let total = 0;
    for (;;) {
      if (await src.atEnd()) throw new PasteError('truncated', 'The paste is incomplete (the data ended early).');
      const ct = await readFrame(src, CHUNK_SIZE);
      const r = pull(s, ct, null);
      if (!r) throw new PasteError('tampered', 'The paste was modified or corrupted.');
      const n = r.message.length;
      total += n;
      if (r.tag === TAG_MESSAGE) {
        if (n !== CHUNK_SIZE || total >= meta.size) throw new PasteError('format', 'Malformed paste data.');
        yield r.message;
        continue;
      }
      if (r.tag !== TAG_FINAL) throw new PasteError('format', 'Malformed paste data.');
      if (total !== meta.size || (n === 0 && meta.size !== 0)) {
        throw new PasteError('tampered', 'The file size does not match.');
      }
      if (!(await src.atEnd())) throw new PasteError('tampered', 'Unexpected data after the end of the paste.');
      yield r.message;
      return;
    }
  }
  return { meta, discussion, file: file() };
}
