// Randomized robustness tests for every parser that handles data from a
// link, the server or another user. Each must either reject the input with
// its documented error or accept it in a valid form; altered paste data
// must never decrypt to anything but the original.
//
// Deterministic: a fixed seed, so a failure reproduces exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildThread, decryptComment, encryptComment, type Comment } from '../src/comments.ts';
import { openPaste, preparePaste } from '../src/crypto.ts';
import { ByteReader, PasteError, PREFIX_BYTES, parseMeta, parsePrefix } from '../src/format.ts';
import { parseKeyFragment, parseTokenFragment } from '../src/link.ts';
import { loadSodium } from '../src/sodium.ts';

// xorshift32: small, fast and reproducible.
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  const next = () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
  return {
    int: (n: number) => next() % n,
    bytes: (n: number) => Uint8Array.from({ length: n }, () => next() & 0xff),
  };
}

const ID = '0123456789abcdef0123456789abcdef';

function reader(bytes: Uint8Array, chunk: number): ByteReader {
  let off = 0;
  return new ByteReader(new ReadableStream<Uint8Array>({
    pull(c) {
      if (off >= bytes.length) { c.close(); return; }
      c.enqueue(bytes.slice(off, off + chunk));
      off += chunk;
    },
  }));
}

async function blobOf(prepared: ReturnType<typeof preparePaste>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of prepared.chunks()) parts.push(p);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Decrypts fully. Returns the text and file bytes, or the PasteError. */
async function open(sodium: Awaited<ReturnType<typeof loadSodium>>, blob: Uint8Array, key: Uint8Array, chunk: number) {
  try {
    const opened = await openPaste(sodium, reader(blob, chunk), key.slice(), async () => null);
    const file: number[] = [];
    if (opened.file) for await (const piece of opened.file) file.push(...piece);
    return { text: opened.meta.text, file };
  } catch (e) {
    if (!(e instanceof PasteError)) throw e; // anything else is a bug
    return e;
  }
}

test('altered paste data never decrypts to anything but the original', async () => {
  const sodium = await loadSodium();
  const r = rng(0x5eed1);
  const file = new Blob([r.bytes(64 * 1024 * 2 + 777)]);
  const prepared = preparePaste(sodium, { text: 'secret text', file, filename: 'a.bin', mime: null, password: '', discussion: false });
  const key = prepared.fragmentKey.slice();
  const original = await blobOf(prepared);
  const want = await open(sodium, original, key, 4096);
  assert.ok(!(want instanceof PasteError));

  let rejected = 0;
  for (let i = 0; i < 1500; i++) {
    const b = original.slice();
    let mutated: Uint8Array;
    switch (r.int(5)) {
      case 0: { // flip bits
        for (let n = 1 + r.int(4); n > 0; n--) { const p = r.int(b.length); b[p] = b[p]! ^ (1 << r.int(8)); }
        mutated = b;
        break;
      }
      case 1: mutated = b.slice(0, r.int(b.length)); break; // truncate
      case 2: { const extra = r.bytes(1 + r.int(64)); mutated = new Uint8Array([...b, ...extra]); break; } // append
      case 3: { // drop a range from the middle
        const a = r.int(b.length), len = 1 + r.int(200);
        mutated = new Uint8Array([...b.slice(0, a), ...b.slice(a + len)]);
        break;
      }
      default: { // duplicate a range
        const a = r.int(b.length - 300), len = 1 + r.int(300);
        mutated = new Uint8Array([...b.slice(0, a + len), ...b.slice(a, a + len), ...b.slice(a + len)]);
      }
    }
    const got = await open(sodium, mutated, key, 1 + r.int(70_000));
    if (got instanceof PasteError) { rejected++; continue; }
    // Only an unchanged blob may decrypt (a no-op mutation, e.g. flipping a bit twice).
    assert.deepEqual(got, want, `mutation ${i} decrypted to different content`);
  }
  assert.ok(rejected > 1400, `only ${rejected} of 1500 altered blobs were rejected`);
});

test('the blob prefix parser accepts only well-formed prefixes', () => {
  const r = rng(2);
  for (let i = 0; i < 20_000; i++) {
    const p = r.bytes(PREFIX_BYTES);
    if (i % 2) p.set([0x4e, 0x42, 0x4e, 0x31, 1], 0); // often a valid magic and version
    try {
      const got = parsePrefix(p);
      assert.equal(p[5]! & ~1, 0);
      if (!got.password) assert.ok(got.salt.every((x) => x === 0));
    } catch (e) {
      assert.ok(e instanceof PasteError);
    }
  }
});

test('the metadata parser accepts only the exact schema', () => {
  const r = rng(3);
  const enc = new TextEncoder();
  const values = ['"text"', '"file"', '""', '"a.bin"', 'null', '0', '1', '-1', '1.5', '9007199254740993', 'true', 'false', '[]', '{}', '"x"'];
  const keys = ['type', 'text', 'filename', 'mime', 'size', 'discussion', 'extra', '__proto__', 'constructor'];
  for (let i = 0; i < 20_000; i++) {
    const fields: string[] = [];
    for (const k of keys) if (r.int(4) !== 0 || i % 3 === 0) fields.push(`"${k}":${values[r.int(values.length)]}`);
    const json = r.int(20) === 0 ? String.fromCharCode(...r.bytes(20)) : `{${fields.join(',')}}`;
    for (const final of [true, false]) {
      for (const pw of [true, false]) {
        try {
          const m = parseMeta(enc.encode(json), final, pw);
          assert.ok(m.type === 'text' || m.type === 'file');
          assert.ok(Number.isSafeInteger(m.size) && m.size >= 0);
          assert.ok(!m.discussion || pw);
          assert.equal(Object.getPrototypeOf(m), Object.prototype);
        } catch (e) {
          assert.ok(e instanceof PasteError);
        }
      }
    }
  }
});

test('link fragments are accepted only in canonical form', async () => {
  const sodium = await loadSodium();
  const r = rng(4);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.#=+/ %';
  for (let i = 0; i < 20_000; i++) {
    const len = r.int(4) === 0 ? 43 + r.int(3) : r.int(60);
    const s = Array.from({ length: len }, () => alphabet[r.int(alphabet.length)]).join('');
    const k = parseKeyFragment(sodium, s);
    if (k) {
      assert.equal(k.key.length, 32);
      const body = s.replace(/^#/, '').replace(/\.b$/, '');
      assert.equal(sodium.to_base64(k.key, sodium.base64_variants.URLSAFE_NO_PADDING), body);
    }
    const t = parseTokenFragment(s);
    if (t !== null) assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  }
});

test('comments: garbage never decrypts, and threads stay finite and complete', async () => {
  const sodium = await loadSodium();
  const r = rng(5);
  const key = sodium.randombytes_buf(32);
  for (let i = 0; i < 20_000; i++) {
    const bytes = r.bytes(r.int(200));
    if (bytes.length > 0 && r.int(2)) bytes[0] = 1;
    assert.equal(decryptComment(sodium, key, ID, bytes), null);
  }
  // A real comment survives only unchanged and only for its own paste.
  const { bytes } = encryptComment(sodium, key, ID, { parent: null, name: 'n', text: 't' });
  assert.ok(decryptComment(sodium, key, ID, bytes));
  assert.equal(decryptComment(sodium, key, ID.replace('0', '1'), bytes), null);
  for (let i = 0; i < 2000; i++) {
    const b = bytes.slice();
    const p = r.int(b.length);
    b[p] = b[p]! ^ (1 << r.int(8));
    assert.equal(decryptComment(sodium, key, ID, b), null);
  }
  // Random reply graphs, including loops and duplicate ids.
  const ids = Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(32, '0'));
  for (let i = 0; i < 2000; i++) {
    const comments: Comment[] = Array.from({ length: 1 + r.int(40) }, () => ({
      id: ids[r.int(ids.length)]!, parent: r.int(3) ? ids[r.int(ids.length)]! : null, name: '', text: 'x', time: 1,
    }));
    const seen = new Set<string>();
    const walk = (nodes: ReturnType<typeof buildThread>, depth: number) => {
      assert.ok(depth < 100, 'thread is not finite');
      for (const n of nodes) {
        assert.ok(!seen.has(n.comment.id), 'a comment appears twice');
        seen.add(n.comment.id);
        walk(n.replies, depth + 1);
      }
    };
    walk(buildThread(comments), 0);
    assert.equal(seen.size, new Set(comments.map((c) => c.id)).size, 'a comment went missing');
  }
});
