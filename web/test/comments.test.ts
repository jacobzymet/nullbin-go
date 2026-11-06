// Tests for encrypted comments (web/src/comments.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadSodium } from '../src/sodium.ts';
import { buildThread, uniqueComments, cleanName, decryptComment, encryptComment, MAX_COMMENT_BYTES, MAX_COMMENT_LENGTH, type Comment } from '../src/comments.ts';
import { PasteError } from '../src/format.ts';

const sodium = await loadSodium();
const key = sodium.randombytes_buf(32);
const pasteId = '0123456789abcdef0123456789abcdef';

test('comment round trip', () => {
  const { bytes, comment } = encryptComment(sodium, key, pasteId, { parent: null, name: '  Ada  ', text: '  Looks good.\nShip it.  ' }, 1_700_000_000_000);
  assert.equal(bytes[0], 1);
  assert.deepEqual(comment, { id: comment.id, parent: null, name: 'Ada', text: 'Looks good.\nShip it.', time: 1_700_000_000_000 });
  assert.match(comment.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(decryptComment(sodium, key, pasteId, bytes), comment);
  assert.ok(!Buffer.from(bytes).toString('latin1').includes('Ship it'), 'plaintext not in ciphertext');
});

test('replies keep their parent inside the ciphertext', () => {
  const parent = encryptComment(sodium, key, pasteId, { parent: null, name: '', text: 'q' }).comment;
  const { bytes } = encryptComment(sodium, key, pasteId, { parent: parent.id, name: 'b', text: 'a' });
  assert.equal(decryptComment(sodium, key, pasteId, bytes)?.parent, parent.id);
  assert.ok(!Buffer.from(bytes).toString('latin1').includes(parent.id), 'thread structure hidden from the server');
});

test('anything inauthentic decrypts to null', () => {
  const { bytes } = encryptComment(sodium, key, pasteId, { parent: null, name: 'x', text: 'hello' });
  assert.equal(decryptComment(sodium, sodium.randombytes_buf(32), pasteId, bytes), null, 'wrong key');
  assert.equal(decryptComment(sodium, key, 'ffffffffffffffffffffffffffffffff', bytes), null, 'moved to another paste');
  for (let i = 0; i < bytes.length; i++) {
    const t = bytes.slice();
    t[i]! ^= 0x01;
    assert.equal(decryptComment(sodium, key, pasteId, t), null, `flipped byte ${i}`);
  }
  assert.equal(decryptComment(sodium, key, pasteId, bytes.subarray(0, bytes.length - 1)), null, 'truncated');
  assert.equal(decryptComment(sodium, key, pasteId, new Uint8Array(0)), null, 'empty');
  assert.equal(decryptComment(sodium, key, pasteId, sodium.randombytes_buf(100)), null, 'garbage');
});

test('well-encrypted but malformed comments are rejected', () => {
  const seal = (v: unknown) => {
    const nonce = sodium.randombytes_buf(24);
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      new TextEncoder().encode(JSON.stringify(v)), new TextEncoder().encode(`nullbin comment v1 ${pasteId}`), null, nonce, key);
    return new Uint8Array([1, ...nonce, ...ct]);
  };
  const ok = { id: 'a'.repeat(32), parent: null, name: 'n', text: 't', time: 1 };
  assert.ok(decryptComment(sodium, key, pasteId, seal(ok)));
  for (const bad of [
    { ...ok, extra: 1 },
    { ...ok, id: 'xyz' },
    { ...ok, parent: ok.id },
    { ...ok, parent: 'nope' },
    { ...ok, name: 'n'.repeat(41) },
    { ...ok, text: '' },
    { ...ok, text: 't'.repeat(MAX_COMMENT_LENGTH + 1) },
    { ...ok, time: -5 },
    { ...ok, time: 1.5 },
    { ...ok, time: 8_640_000_000_000_001 },
    { ...ok, time: Number.MAX_SAFE_INTEGER },
    [ok],
  ]) {
    assert.equal(decryptComment(sodium, key, pasteId, seal(bad)), null, JSON.stringify(bad).slice(0, 60));
  }
});

test('empty and oversized comments are refused before sending', () => {
  assert.throws(() => encryptComment(sodium, key, pasteId, { parent: null, name: '', text: '   ' }), PasteError);
  assert.throws(() => encryptComment(sodium, key, pasteId, { parent: null, name: '', text: 'x'.repeat(MAX_COMMENT_LENGTH + 1) }), PasteError);
  // The largest allowed comment still fits the server limit, even with
  // characters that JSON escapes into six bytes.
  const { bytes } = encryptComment(sodium, key, pasteId, { parent: null, name: 'n'.repeat(40), text: '"'.repeat(MAX_COMMENT_LENGTH) });
  assert.ok(bytes.length <= MAX_COMMENT_BYTES);
});

test('names lose control and bidi characters', () => {
  assert.equal(cleanName('ali\u202Ece\u0000\n bob'), 'alice bob');
  assert.equal(cleanName('x'.repeat(100)).length, 40);
});

test('threads: replies nest, duplicates and loops are neutralized', () => {
  const c = (id: string, parent: string | null): Comment => ({ id: id.repeat(32), parent: parent ? parent.repeat(32) : null, name: '', text: id, time: 1 });
  const a = c('a', null);
  const b = c('b', 'a');
  const d = c('d', 'b');
  const orphan = c('e', 'f'); // parent unknown
  const early = c('g', 'h'); // the server put the reply before its parent
  const h = c('h', null);
  const x = c('x', 'y'); // a loop: each claims the other as parent
  const y = c('y', 'x');
  const roots = buildThread([a, b, d, a, orphan, early, h, x, y]);
  assert.deepEqual(roots.map((r) => r.comment.text), ['a', 'e', 'h', 'x', 'y']);
  assert.equal(roots[0]!.replies.length, 1, 'a replayed comment shows once');
  assert.equal(roots[0]!.replies[0]!.comment.text, 'b');
  assert.equal(roots[0]!.replies[0]!.replies[0]!.comment.text, 'd');
  assert.equal(roots[2]!.replies[0]!.comment.text, 'g', 'a reply sits under its parent whatever the order');
  assert.deepEqual(uniqueComments([a, b, a, b]).map((m) => m.text), ['a', 'b']);
});

test('names lose every invisible character that could disguise them', () => {
  for (const cp of [0x2060, 0xfeff, 0xe0041, 0x202e, 0x200b]) {
    assert.equal(cleanName(`Al${String.fromCodePoint(cp)}ice`), 'Alice', `U+${cp.toString(16)} must be removed`);
  }
});
