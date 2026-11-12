// Tests for the browser crypto module, run with `node --test` (Node strips
// the TypeScript types). They use the same libsodium build as the bundle.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadSodium } from '../src/sodium.ts';
import { openPaste, preparePaste, type PasteInput } from '../src/crypto.ts';
import {
  ABYTES,
  ByteReader,
  CHUNK_SIZE,
  FRAME_LENGTH_BYTES,
  HEADER_BYTES,
  MAX_META_BYTES,
  MAX_STREAM_LENGTH,
  META_LENGTH_BYTES,
  MIN_PADDED_LENGTH,
  PasteError,
  blobSize,
  buildPrefix,
  decodeFrameLength,
  encodeFrameLength,
  paddedLength,
  parseMeta,
  type PasteMeta,
} from '../src/format.ts';
import { encodeKeyFragment, encodeTokenFragment, parseKeyFragment, parseTokenFragment } from '../src/link.ts';

const sodium = await loadSodium();

function input(over: Partial<PasteInput> = {}): PasteInput {
  return { text: 'hello', file: null, filename: null, mime: null, password: '', discussion: false, ...over };
}

function bytes(n: number, seed = 1): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function encrypt(inp: PasteInput): Promise<{ blob: Uint8Array; key: Uint8Array; totalSize: number }> {
  const prepared = preparePaste(sodium, inp);
  const parts: Uint8Array[] = [];
  for await (const c of prepared.chunks()) parts.push(c);
  return { blob: concat(parts), key: prepared.fragmentKey, totalSize: prepared.totalSize };
}

/** A stream that delivers blob in pieces of `piece` bytes. */
function streamOf(blob: Uint8Array, piece = 7919): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (off >= blob.length) {
        ctrl.close();
        return;
      }
      ctrl.enqueue(blob.slice(off, off + piece));
      off += piece;
    },
  });
}

interface Decrypted {
  meta: PasteMeta;
  file: Uint8Array | null;
}

async function decrypt(blob: Uint8Array, key: Uint8Array, passwords: (string | null)[] = []): Promise<Decrypted> {
  let i = 0;
  const opened = await openPaste(sodium, new ByteReader(streamOf(blob)), key, async () => passwords[i++] ?? null);
  if (!opened.file) return { meta: opened.meta, file: null };
  const parts: Uint8Array[] = [];
  for await (const c of opened.file) parts.push(c);
  return { meta: opened.meta, file: concat(parts) };
}

async function rejectsWith(p: Promise<unknown>, codes: string[], label = '') {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof PasteError, `${label}: expected PasteError, got ${String(e)}`);
    assert.ok(codes.includes(e.code), `${label}: code ${e.code}, expected one of ${codes.join(', ')}`);
    return true;
  });
}

/** Offsets of each frame start in a blob. */
function frameOffsets(blob: Uint8Array): number[] {
  const out: number[] = [];
  let off = HEADER_BYTES;
  while (off < blob.length) {
    out.push(off);
    off += FRAME_LENGTH_BYTES + decodeFrameLength(blob.subarray(off, off + FRAME_LENGTH_BYTES));
  }
  assert.equal(off, blob.length);
  return out;
}

test('text round trip, including non-ASCII text', async () => {
  const text = 'Grüße, 世界! 🔐\n<script>alert(1)</script>\u0000end';
  const { blob, key, totalSize } = await encrypt(input({ text }));
  assert.equal(blob.length, totalSize);
  assert.deepEqual([...blob.subarray(0, 4)], [0x4e, 0x42, 0x4e, 0x31]);
  const out = await decrypt(blob, key);
  assert.deepEqual(out.meta, { type: 'text', text, filename: null, mime: null, size: 0, discussion: false });
  assert.equal(out.file, null);
});

test('the blob never contains the plaintext, key, filename or MIME type', async () => {
  const marker = 'PLAINTEXT-MARKER-1234567890';
  const file = new Blob([new TextEncoder().encode(marker.repeat(100))]);
  const { blob, key } = await encrypt(input({ text: marker, file, filename: 'secret-name.pdf', mime: 'application/x-secret' }));
  const asText = Buffer.from(blob).toString('latin1');
  for (const needle of [marker, 'secret-name', 'application/x-secret', Buffer.from(key).toString('latin1')]) {
    assert.ok(!asText.includes(needle), `blob contains ${JSON.stringify(needle.slice(0, 20))}`);
  }
});

test('text and file round trip for sizes around frame boundaries', async () => {
  const sizes = [0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 3 * CHUNK_SIZE, 16 * CHUNK_SIZE + 5];
  for (const size of sizes) {
    const content = bytes(size, size + 3);
    const { blob, key, totalSize } = await encrypt(
      input({ text: `file of ${size}`, file: new Blob([content]), filename: 'a.bin', mime: 'application/pdf' }),
    );
    assert.equal(blob.length, totalSize, `size ${size}: totalSize`);
    const out = await decrypt(blob, key);
    assert.deepEqual(out.meta, { type: 'file', text: `file of ${size}`, filename: 'a.bin', mime: 'application/pdf', size, discussion: false });
    assert.ok(out.file && Buffer.from(out.file).equals(Buffer.from(content)), `size ${size}: content`);
  }
});

test('file without text, unknown MIME type', async () => {
  const content = bytes(1000);
  const { blob, key } = await encrypt(input({ text: '', file: new Blob([content]), filename: 'x', mime: '' }));
  const out = await decrypt(blob, key);
  assert.equal(out.meta.mime, null);
  assert.equal(out.meta.text, '');
  assert.deepEqual(out.file, content);
});

test('every paste gets a fresh random key and stream header', async () => {
  const a = await encrypt(input());
  const b = await encrypt(input());
  assert.notDeepEqual(a.key, b.key);
  assert.notDeepEqual(a.blob.subarray(22, 46), b.blob.subarray(22, 46));
});

test('password round trip; the password is only asked for once', async () => {
  const { blob, key } = await encrypt(input({ text: 'secret', password: 'correct horse' }));
  assert.equal(blob[5], 1, 'password flag');
  assert.ok(blob.subarray(6, 22).some((b) => b !== 0), 'salt is random');
  const asked: number[] = [];
  const opened = await openPaste(sodium, new ByteReader(streamOf(blob)), key, async (attempt) => {
    asked.push(attempt);
    return 'correct horse';
  });
  assert.equal(opened.meta.text, 'secret');
  assert.deepEqual(asked, [0]);
});

test('password is Unicode-normalized (NFC)', async () => {
  const { blob, key } = await encrypt(input({ password: 'café' })); // precomposed é
  const out = await decrypt(blob, key, ['café']); // e + combining accent
  assert.equal(out.meta.text, 'hello');
});

test('wrong password fails and can be retried; cancelling stops', async () => {
  const { blob, key } = await encrypt(input({ text: 'secret', password: 'right' }));
  const out = await decrypt(blob, key, ['wrong', 'right']);
  assert.equal(out.meta.text, 'secret');
  await rejectsWith(decrypt(blob, key, ['wrong', null]), ['cancelled']);
});

test('the password alone is not enough: a wrong fragment key fails', async () => {
  const { blob } = await encrypt(input({ password: 'pw' }));
  await rejectsWith(decrypt(blob, sodium.randombytes_buf(32), ['pw', null]), ['cancelled']);
});

test('wrong fragment key fails', async () => {
  const { blob } = await encrypt(input());
  await rejectsWith(decrypt(blob, sodium.randombytes_buf(32)), ['wrong-key']);
  await rejectsWith(decrypt(blob, new Uint8Array(31)), ['wrong-key']);
});

test('truncation at any point is rejected', async () => {
  const textOnly = await encrypt(input({ text: 'short text' }));
  const withFile = await encrypt(input({ file: new Blob([bytes(2 * CHUNK_SIZE + 100)]), filename: 'f' }));
  for (const { blob, key } of [textOnly, withFile]) {
    const cuts = new Set<number>();
    for (let i = 0; i < 200; i++) cuts.add(i);
    for (const off of frameOffsets(blob)) for (let d = -3; d <= 25; d++) cuts.add(off + d);
    for (let i = 0; i < blob.length; i += 4999) cuts.add(i);
    for (let i = blob.length - 40; i < blob.length; i++) cuts.add(i);
    for (const cut of cuts) {
      if (cut < 0 || cut >= blob.length) continue;
      await rejectsWith(decrypt(blob.subarray(0, cut), key), ['truncated', 'format', 'wrong-key', 'tampered'], `cut at ${cut}`);
    }
  }
});

test('dropping the final frame is reported as truncation', async () => {
  const { blob, key } = await encrypt(input({ file: new Blob([bytes(3 * CHUNK_SIZE)]), filename: 'f' }));
  const offs = frameOffsets(blob);
  await rejectsWith(decrypt(blob.subarray(0, offs[offs.length - 1]), key), ['truncated']);
  // Text-only: dropping the only frame.
  const t = await encrypt(input());
  await rejectsWith(decrypt(t.blob.subarray(0, HEADER_BYTES), t.key), ['truncated']);
});

test('flipping any byte is rejected', async () => {
  const { blob, key } = await encrypt(input({ text: 'tamper me', file: new Blob([bytes(2 * CHUNK_SIZE + 10)]), filename: 'f' }));
  const positions = new Set<number>();
  for (let i = 0; i < 300; i++) positions.add(i);
  for (const off of frameOffsets(blob)) for (let d = 0; d < 30; d++) positions.add(off + d);
  for (let i = 0; i < blob.length; i += 997) positions.add(i);
  for (let i = blob.length - 30; i < blob.length; i++) positions.add(i);
  for (const pos of positions) {
    const t = blob.slice();
    t[pos]! ^= pos === 5 ? 0x01 : 0x80; // byte 5 is the flags byte
    // The flipped flags byte makes the viewer ask for a password; the
    // prompt then cancels. Anything but success is correct.
    await rejectsWith(decrypt(t, key, ['', null]), ['format', 'wrong-key', 'tampered', 'truncated', 'cancelled'], `byte ${pos}`);
  }
});

test('trailing data after the final frame is rejected', async () => {
  for (const inp of [input(), input({ file: new Blob([bytes(100)]), filename: 'f' })]) {
    const { blob, key } = await encrypt(inp);
    await rejectsWith(decrypt(concat([blob, new Uint8Array([0])]), key), ['tampered']);
    // A duplicated last frame.
    const offs = frameOffsets(blob);
    await rejectsWith(decrypt(concat([blob, blob.subarray(offs[offs.length - 1])]), key), ['tampered']);
  }
});

test('reordered, dropped or duplicated frames are rejected', async () => {
  const { blob, key } = await encrypt(input({ file: new Blob([bytes(4 * CHUNK_SIZE + 1)]), filename: 'f' }));
  const offs = frameOffsets(blob);
  assert.ok(offs.length >= 5);
  const frame = (i: number) => blob.subarray(offs[i]!, offs[i + 1] ?? blob.length);
  const head = blob.subarray(0, offs[0]);
  const all = offs.map((_, i) => i);
  const build = (order: number[]) => concat([head, ...order.map(frame)]);
  await rejectsWith(decrypt(build([0, 2, 1, ...all.slice(3)]), key), ['tampered'], 'swap');
  await rejectsWith(decrypt(build([0, 1, ...all.slice(3)]), key), ['tampered'], 'drop');
  await rejectsWith(decrypt(build([0, 1, 1, ...all.slice(2)]), key), ['tampered'], 'dup');
});

test('frames cannot be moved between pastes', async () => {
  // Splice paste B's later frames after paste A's first frame.
  const a = await encrypt(input({ file: new Blob([bytes(2 * CHUNK_SIZE, 1)]), filename: 'a' }));
  const b = await encrypt(input({ file: new Blob([bytes(2 * CHUNK_SIZE, 2)]), filename: 'b' }));
  const ao = frameOffsets(a.blob);
  const bo = frameOffsets(b.blob);
  assert.ok(ao.length >= 2 && bo.length >= 2);
  const spliced = concat([a.blob.subarray(0, ao[1]), b.blob.subarray(bo[1])]);
  await rejectsWith(decrypt(spliced, a.key), ['tampered']);
});

test('the header prefix is authenticated with the first frame', async () => {
  // Turning on the password flag with a zero salt on a no-password paste
  // must not decrypt with any password.
  const { blob, key } = await encrypt(input());
  const t = blob.slice();
  t[5] = 1;
  await rejectsWith(decrypt(t, key, ['anything', null]), ['cancelled']);
});

test('bad headers are rejected before any decryption', async () => {
  const { blob, key } = await encrypt(input());
  const cases: [number, number][] = [
    [0, 0x58], // magic
    [4, 0], // version
    [4, 3], // version
    [5, 0x02], // unknown flag
    [10, 1], // non-zero salt without password
  ];
  for (const [pos, val] of cases) {
    const t = blob.slice();
    t[pos] = val;
    await rejectsWith(decrypt(t, key), ['format'], `byte ${pos}`);
  }
  // Oversized frame length.
  const t = blob.slice();
  t.set([0xff, 0xff, 0xff, 0xff], HEADER_BYTES);
  await rejectsWith(decrypt(t, key), ['format']);
});

test('metadata is validated strictly', () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const ok = { type: 'text', text: 'x', filename: null, mime: null, size: 0, discussion: false };
  const file = { type: 'file', text: '', filename: 'f', mime: null, size: 1, discussion: false };
  assert.deepEqual(parseMeta(enc(ok)), ok);
  assert.deepEqual(parseMeta(enc({ ...ok, discussion: true })), { ...ok, discussion: true });
  assert.deepEqual(parseMeta(enc(file)), file);
  const bad: unknown[] = [
    { ...ok, extra: 1 },
    { ...ok, type: 'html' },
    { ...ok, size: 5 },
    { ...ok, filename: 'f' },
    { ...ok, discussion: 'yes' },
    { type: 'text', text: 'x', filename: null, mime: null, size: 0 }, // discussion missing
    { ...file, filename: '' },
    { ...file, size: -1 },
    { ...file, size: 1.5 },
    { ...file, mime: 5 },
    { ...file, text: 1 },
    { ...file, filename: 'f'.repeat(256) },
    [ok],
    'string',
    null,
  ];
  for (const v of bad) {
    assert.throws(() => parseMeta(enc(v)), PasteError, JSON.stringify(v));
  }
  assert.throws(() => parseMeta(new Uint8Array([0xff, 0xfe])), PasteError);
});

test('empty pastes and oversized text are refused before upload', () => {
  assert.throws(() => preparePaste(sodium, input({ text: '' })), PasteError);
  assert.throws(() => preparePaste(sodium, input({ text: 'x'.repeat(16 * 1024 * 1024) })), (e: unknown) => e instanceof PasteError && e.code === 'too-large');
});

test('ByteReader reads exact sizes across chunk boundaries and detects early end', async () => {
  const data = bytes(1000);
  const r = new ByteReader(streamOf(data, 3));
  assert.deepEqual(await r.read(10), data.subarray(0, 10));
  assert.deepEqual(await r.read(1), data.subarray(10, 11));
  assert.deepEqual(await r.read(989), data.subarray(11));
  assert.equal(await r.atEnd(), true);
  await rejectsWith(r.read(1), ['truncated']);

  const failing = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new Uint8Array(5));
      ctrl.error(new Error('connection reset'));
    },
  });
  const f = new ByteReader(failing);
  await rejectsWith(f.read(10), ['network']);
});

test('fragment encoding and strict parsing', () => {
  const key = sodium.randombytes_buf(32);
  const plain = encodeKeyFragment(sodium, key, false);
  const burn = encodeKeyFragment(sodium, key, true);
  assert.match(plain, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(burn, `${plain}.b`);
  assert.deepEqual(parseKeyFragment(sodium, `#${plain}`), { key, burn: false });
  assert.deepEqual(parseKeyFragment(sodium, burn), { key, burn: true });
  for (const bad of ['', '#', plain.slice(1), `${plain}A`, `${plain}.x`, `${plain}.b.b`, `${plain}=`, plain.replace(/.$/, '/'), `${plain.slice(0, 42)}B`]) {
    assert.equal(parseKeyFragment(sodium, bad), null, `accepted ${bad}`);
  }
  assert.equal(parseTokenFragment(`#d.${plain}`), plain);
  assert.equal(parseTokenFragment(`#${plain}`), null, 'a bare key must never pass as a delete token');
  assert.equal(parseTokenFragment(`#${encodeTokenFragment(plain)}`), plain);
  assert.equal(parseTokenFragment(`#d.${plain}.b`), null);
  assert.equal(parseTokenFragment('#short'), null);
  assert.equal(parseTokenFragment(`#${plain}<`), null);
});

test('a discussion works without a password, with keys from the link key alone', async () => {
  const prepared = preparePaste(sodium, input({ text: 'open talk', discussion: true }));
  assert.match(prepared.commentToken ?? '', /^[A-Za-z0-9_-]{43}$/);
  const parts: Uint8Array[] = [];
  for await (const c of prepared.chunks()) parts.push(c);
  let asked = false;
  const opened = await openPaste(sodium, new ByteReader(streamOf(concat(parts))), prepared.fragmentKey, async () => { asked = true; return null; });
  assert.equal(asked, false, 'no password is asked for');
  assert.equal(opened.meta.discussion, true);
  assert.ok(opened.discussion);
  assert.equal(opened.discussion.token, prepared.commentToken);
  // The token is derived, never the key itself.
  assert.notEqual(prepared.commentToken, sodium.to_base64(prepared.fragmentKey, sodium.base64_variants.URLSAFE_NO_PADDING));
});

test('discussion paste: token and comment key come from link key + password', async () => {
  const prepared = preparePaste(sodium, input({ text: 'talk', password: 'pw-for-talk', discussion: true }));
  assert.match(prepared.commentToken ?? '', /^[A-Za-z0-9_-]{43}$/);
  const parts: Uint8Array[] = [];
  for await (const c of prepared.chunks()) parts.push(c);
  const blob = concat(parts);

  let i = 0;
  const pw = ['pw-for-talk'];
  const opened = await openPaste(sodium, new ByteReader(streamOf(blob)), prepared.fragmentKey, async () => pw[i++] ?? null);
  assert.equal(opened.meta.discussion, true);
  assert.ok(opened.discussion);
  // The reader derives the same token the creator registered.
  assert.equal(opened.discussion.token, prepared.commentToken);
  assert.equal(opened.discussion.key.length, 32);

  // The token reveals nothing usable: it differs from the key material and
  // from the token of another paste with the same password.
  const other = preparePaste(sodium, input({ text: 'talk', password: 'pw-for-talk', discussion: true }));
  assert.notEqual(other.commentToken, prepared.commentToken);
  assert.notEqual(prepared.commentToken, sodium.to_base64(prepared.fragmentKey, sodium.base64_variants.URLSAFE_NO_PADDING));
});

test('pastes without a discussion carry no comment token', async () => {
  const prepared = preparePaste(sodium, input({ password: 'secret' }));
  assert.equal(prepared.commentToken, null);
  const { blob, key } = await encrypt(input());
  const opened = await openPaste(sodium, new ByteReader(streamOf(blob)), key, async () => null);
  assert.equal(opened.discussion, null);
});


test('ByteReader applies backpressure during prompts and cancels the source', async () => {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { pulls++; c.enqueue(new Uint8Array(64 * 1024)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const reader = new ByteReader(stream);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pulls, 0, 'nothing pulled before demand');
  await reader.read(46);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pulls, 1, 'waiting for a prompt does not buffer the file');
  await reader.read(100);
  assert.equal(pulls, 1, 'reuse unread bytes');
  await reader.cancel();
  assert.ok(cancelled);
  await rejectsWith(reader.read(1), ['truncated']);
  await rejectsWith(reader.read(100 * 1024 * 1024), ['too-large']);
});

test('burn capability depends on the master key and differs from encryption/comment keys', async () => {
  const { burnAccessToken, deriveKey, discussionKeys } = await import('../src/crypto.ts');
  const fragment = sodium.randombytes_buf(32);
  const salt = sodium.randombytes_buf(16);
  const master = deriveKey(sodium, fragment, 'correct password', salt);
  const wrong = deriveKey(sodium, fragment, 'wrong password', salt);
  const token = burnAccessToken(sodium, master);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, burnAccessToken(sodium, wrong));
  assert.notEqual(token, burnAccessToken(sodium, fragment));
  assert.notEqual(token, sodium.to_base64(master, sodium.base64_variants.URLSAFE_NO_PADDING));
  assert.notEqual(token, discussionKeys(sodium, master).token);
  assert.equal(token, burnAccessToken(sodium, master));
});

// --- Size padding (format version 2) and reading version 1 ---

const textMeta = (text: string) => ({ type: 'text', text, filename: null, mime: null, size: 0, discussion: false });
const fileMeta = (size: number) => ({ type: 'file', text: '', filename: 'f', mime: null, size, discussion: false });
const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** Encrypts the given frame plaintexts as a blob without a password, the way preparePaste does. */
function sealFrames(frames: Uint8Array[], version: number): { blob: Uint8Array; key: Uint8Array } {
  const key = sodium.randombytes_buf(32);
  const prefix = buildPrefix(false, new Uint8Array(16));
  prefix[4] = version;
  const streamKey = sodium.crypto_kdf_derive_from_key(32, 1, 'nbstream', key);
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(streamKey);
  const parts: Uint8Array[] = [prefix, header];
  frames.forEach((plain, i) => {
    const tag = i === frames.length - 1
      ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
      : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    const ct = sodium.crypto_secretstream_xchacha20poly1305_push(state, plain, i === 0 ? prefix : null, tag);
    parts.push(encodeFrameLength(ct.length), ct);
  });
  return { blob: concat(parts), key };
}

/** Cuts a stream into frames of the given sizes (default: the canonical layout). */
function split(stream: Uint8Array, sizes?: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (!sizes) {
    sizes = [];
    for (let left = stream.length; left > 0; left -= CHUNK_SIZE) sizes.push(Math.min(left, CHUNK_SIZE));
  }
  let off = 0;
  for (const n of sizes) {
    out.push(stream.subarray(off, off + n));
    off += n;
  }
  assert.equal(off, stream.length);
  return out;
}

/** A version 2 stream: metadata length, metadata, file, then zeros up to padTo (default: the padded length). */
function v2Stream(meta: unknown, file = new Uint8Array(0), padTo?: number): Uint8Array {
  const m = jsonBytes(meta);
  const content = META_LENGTH_BYTES + m.length + file.length;
  const out = new Uint8Array(padTo ?? paddedLength(content));
  out.set(encodeFrameLength(m.length), 0);
  out.set(m, META_LENGTH_BYTES);
  out.set(file, META_LENGTH_BYTES + m.length);
  return out;
}

/** A version 1 blob, as earlier releases wrote it. */
function sealV1(meta: unknown, file: Uint8Array | null): { blob: Uint8Array; key: Uint8Array } {
  const frames = [jsonBytes(meta)];
  if (file) {
    if (file.length === 0) frames.push(new Uint8Array(0));
    for (let off = 0; off < file.length; off += CHUNK_SIZE) frames.push(file.subarray(off, off + CHUNK_SIZE));
  }
  return sealFrames(frames, 1);
}

test('paddedLength: a minimum, then Padmé rounding', () => {
  assert.equal(paddedLength(0), MIN_PADDED_LENGTH);
  assert.equal(paddedLength(1), MIN_PADDED_LENGTH);
  assert.equal(paddedLength(MIN_PADDED_LENGTH), MIN_PADDED_LENGTH);
  assert.equal(paddedLength(MIN_PADDED_LENGTH + 1), MIN_PADDED_LENGTH + 1024);
  assert.equal(paddedLength(65_536), 65_536);
  assert.equal(paddedLength(65_537), 65_536 + 2048);
  assert.equal(paddedLength(100 * 2 ** 20), 100 * 2 ** 20);
  assert.equal(paddedLength(100 * 2 ** 20 + 1), 100 * 2 ** 20 + 2 ** 21);
  assert.equal(paddedLength(2 ** 32 + 1), 2 ** 32 + 2 ** 26);
  assert.equal(paddedLength(MAX_STREAM_LENGTH), MAX_STREAM_LENGTH);
  for (const bad of [-1, 1.5, Number.NaN, Infinity, MAX_STREAM_LENGTH + 1]) {
    assert.throws(() => paddedLength(bad), RangeError, String(bad));
  }

  const r = (() => { let x = 7; return () => (x = (x * 1103515245 + 12345) >>> 0); })();
  const ns = new Set<number>();
  for (let e = 0; e <= 40; e++) for (const d of [-2, -1, 0, 1, 2]) if (2 ** e + d >= 0) ns.add(2 ** e + d);
  for (let i = 0; i < 20_000; i++) ns.add(r() % (1 << 26));
  for (let i = 0; i < 2000; i++) ns.add(r() * 1024 + (r() % 1024));
  for (const n of ns) {
    const p = paddedLength(n);
    assert.ok(p >= n && p >= MIN_PADDED_LENGTH, `${n} -> ${p}`);
    assert.equal(paddedLength(p), p, `${n}: not idempotent`);
    assert.ok(paddedLength(n + 1) >= p, `${n}: not monotonic`);
    if (n > MIN_PADDED_LENGTH) assert.ok((p - n) / n < 1 / 16, `${n}: overhead`);
    if (n >= 65_536) assert.ok((p - n) / n < 1 / 32, `${n}: overhead`);
  }
});

test('all short pastes have the same size, whatever they hold', async () => {
  const sizes = new Set<number>();
  for (const inp of [
    input({ text: 'a' }),
    input({ text: 'x'.repeat(12_000) }),
    input({ text: 'é'.repeat(5000) }),
    input({ text: '', file: new Blob([bytes(8000)]), filename: 'secret-file-name.txt', mime: 'text/plain' }),
    input({ text: 'pw', password: 'correct horse' }),
    input({ text: 'talk', discussion: true }),
  ]) {
    const { blob, totalSize } = await encrypt(inp);
    assert.equal(blob.length, totalSize);
    sizes.add(blob.length);
  }
  assert.deepEqual([...sizes], [blobSize(MIN_PADDED_LENGTH)]);
});

test('the frame layout depends only on the padded length', async () => {
  for (const size of [0, 1, 20_000, CHUNK_SIZE, 3 * CHUNK_SIZE + 12_345, 9 * CHUNK_SIZE]) {
    const content = bytes(size, size + 9);
    const { blob, key, totalSize } = await encrypt(input({ text: 't', file: new Blob([content]), filename: 'a.bin', mime: null }));
    const metaLength = jsonBytes({ type: 'file', text: 't', filename: 'a.bin', mime: null, size, discussion: false }).length;
    const padded = paddedLength(META_LENGTH_BYTES + metaLength + size);
    assert.equal(blob.length, blobSize(padded), `size ${size}`);
    assert.equal(totalSize, blob.length);
    const offs = frameOffsets(blob);
    const lengths = offs.map((o) => decodeFrameLength(blob.subarray(o, o + FRAME_LENGTH_BYTES)));
    lengths.slice(0, -1).forEach((n) => assert.equal(n, CHUNK_SIZE + ABYTES, `size ${size}: inner frame`));
    assert.equal(lengths.reduce((a, n) => a + n - ABYTES, 0), padded, `size ${size}: stream length`);
    const out = await decrypt(blob, key);
    assert.ok(out.file && Buffer.from(out.file).equals(Buffer.from(content)), `size ${size}: content`);
  }
});

test('text round trip at padding boundaries', async () => {
  const overhead = META_LENGTH_BYTES + jsonBytes(textMeta('')).length;
  for (const target of [MIN_PADDED_LENGTH - 1, MIN_PADDED_LENGTH, MIN_PADDED_LENGTH + 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 3 * CHUNK_SIZE + 7]) {
    const text = 'y'.repeat(target - overhead);
    const { blob, key } = await encrypt(input({ text }));
    assert.equal(blob.length, blobSize(paddedLength(target)), `stream ${target}`);
    const out = await decrypt(blob, key);
    assert.equal(out.meta.text, text, `stream ${target}`);
    assert.equal(out.file, null);
  }
});

test('the canonical padded stream opens; any other padding is rejected', async () => {
  const meta = textMeta('hi');
  const good = sealFrames(split(v2Stream(meta)), 2);
  assert.equal((await decrypt(good.blob, good.key)).meta.text, 'hi');

  const content = META_LENGTH_BYTES + jsonBytes(meta).length;
  const padded = paddedLength(content);
  for (const padTo of [content, padded - 1, padded + 1, padded + 1024, padded + CHUNK_SIZE, 2 * padded]) {
    const { blob, key } = sealFrames(split(v2Stream(meta, undefined, padTo)), 2);
    await rejectsWith(decrypt(blob, key), ['format'], `padded to ${padTo}`);
  }
  for (const pos of [content, content + 1, padded - 1]) {
    const s = v2Stream(meta);
    s[pos] = 1;
    const { blob, key } = sealFrames(split(s), 2);
    await rejectsWith(decrypt(blob, key), ['format'], `non-zero padding at ${pos}`);
  }
});

test('padding after a file is checked to the last byte, across frames', async () => {
  // Just over 4 MiB of content: 128 KiB - 1 of padding, spread over three
  // frames, and a padded stream of exactly 66 full frames.
  const content = 2 ** 22 + 1;
  const size = content - META_LENGTH_BYTES - jsonBytes(fileMeta(2 ** 22)).length;
  assert.equal(META_LENGTH_BYTES + jsonBytes(fileMeta(size)).length + size, content);
  const file = bytes(size, 4);
  const s = v2Stream(fileMeta(size), file);
  assert.equal(s.length, 2 ** 22 + 2 ** 17);
  assert.equal(s.length % CHUNK_SIZE, 0);
  const frames = split(s);

  const ok = sealFrames(frames, 2);
  assert.ok(Buffer.from((await decrypt(ok.blob, ok.key)).file!).equals(Buffer.from(file)));

  const cases: [string, Uint8Array[]][] = [
    ['empty final frame', [...frames, new Uint8Array(0)]],
    ['short inner frame', [...split(frames[0]!, [100, CHUNK_SIZE - 100]), ...frames.slice(1)]],
    ['split frame', [...frames.slice(0, 5), ...split(frames[5]!, [CHUNK_SIZE / 2, CHUNK_SIZE / 2]), ...frames.slice(6)]],
    ['extra zero frame', [...frames, new Uint8Array(CHUNK_SIZE)]],
    ['missing padding frame', frames.slice(0, -1)],
    ['missing padding frames', frames.slice(0, -2)],
  ];
  for (const pos of [content, content + CHUNK_SIZE, s.length - CHUNK_SIZE, s.length - 1]) {
    const t = s.slice();
    t[pos] = 0x80;
    cases.push([`non-zero padding at ${pos}`, split(t)]);
  }
  for (const [label, frames] of cases) {
    const { blob, key } = sealFrames(frames, 2);
    await rejectsWith(decrypt(blob, key), ['format'], label);
  }
});

test('the metadata length and file size must fit the padded stream', async () => {
  const cases: [string, Uint8Array][] = [];
  const long = v2Stream(textMeta('x'));
  long.set(encodeFrameLength(MAX_META_BYTES + 1), 0);
  cases.push(['metadata length over the limit', long]);
  const past = v2Stream(textMeta('x'));
  past.set(encodeFrameLength(past.length), 0);
  cases.push(['metadata length past the end', past]);
  const zero = v2Stream(textMeta('x'));
  zero.set(encodeFrameLength(0), 0);
  cases.push(['empty metadata', zero]);
  const m = jsonBytes(fileMeta(1_000_000)).length;
  cases.push(['file size larger than the stream', v2Stream(fileMeta(1_000_000), bytes(100), paddedLength(META_LENGTH_BYTES + m + 100))]);
  cases.push(['file size beyond any stream', v2Stream(fileMeta(MAX_STREAM_LENGTH), bytes(100), MIN_PADDED_LENGTH)]);
  for (const [label, s] of cases) {
    const { blob, key } = sealFrames(split(s), 2);
    await rejectsWith(decrypt(blob, key), ['format'], label);
  }
});

test('the format version is authenticated: it cannot be switched', async () => {
  const v2 = await encrypt(input({ text: 'two' }));
  const t2 = v2.blob.slice();
  t2[4] = 1;
  await rejectsWith(decrypt(t2, v2.key), ['wrong-key']);

  const v1 = sealV1(textMeta('one'), null);
  const t1 = v1.blob.slice();
  t1[4] = 2;
  await rejectsWith(decrypt(t1, v1.key), ['wrong-key']);
});

test('version 1 pastes from earlier releases still open', async () => {
  const text = sealV1({ ...textMeta('old paste'), discussion: true }, null);
  const t = await openPaste(sodium, new ByteReader(streamOf(text.blob)), text.key, async () => null);
  assert.equal(t.meta.text, 'old paste');
  assert.ok(t.discussion);
  assert.equal(t.file, null);

  for (const size of [0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 3 * CHUNK_SIZE]) {
    const content = bytes(size, size + 1);
    const { blob, key } = sealV1(fileMeta(size), content);
    const out = await decrypt(blob, key);
    assert.equal(out.meta.size, size);
    assert.ok(out.file && Buffer.from(out.file).equals(Buffer.from(content)), `size ${size}`);
  }
});

test('version 1 pastes are still parsed strictly', async () => {
  const file = bytes(2 * CHUNK_SIZE + 5);
  const good = sealV1(fileMeta(file.length), file);
  const offs = frameOffsets(good.blob);
  await rejectsWith(decrypt(concat([good.blob, new Uint8Array(1)]), good.key), ['tampered'], 'trailing data');
  await rejectsWith(decrypt(good.blob.subarray(0, offs[offs.length - 1]), good.key), ['truncated'], 'missing final frame');

  const cases: [string, Uint8Array[]][] = [
    ['text paste that is not final', [jsonBytes(textMeta('x')), new Uint8Array(0)]],
    ['file paste that is final', [jsonBytes(fileMeta(0))]],
    ['short inner frame', [jsonBytes(fileMeta(10)), new Uint8Array(5), new Uint8Array(5)]],
  ];
  for (const [label, frames] of cases) {
    const { blob, key } = sealFrames(frames, 1);
    await rejectsWith(decrypt(blob, key), ['format'], label);
  }
  const { blob, key } = sealFrames([jsonBytes(fileMeta(10)), new Uint8Array(9)], 1);
  await rejectsWith(decrypt(blob, key), ['tampered'], 'file size mismatch');
});
