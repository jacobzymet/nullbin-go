// Tests for encrypted comments (web/src/comments.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadSodium } from '../src/sodium.ts';
import { buildThread, uniqueComments, cleanName, decryptComment, encryptComment, COMMENT_PADDED_LENGTH, MAX_COMMENT_BYTES, MAX_COMMENT_LENGTH, type Comment } from '../src/comments.ts';
import { PasteError, paddedLength } from '../src/format.ts';

const sodium = await loadSodium();
const key = sodium.randombytes_buf(32);
const pasteId = '0123456789abcdef0123456789abcdef';
const enc = new TextEncoder();
/** Fixed overhead of a stored comment: version byte, nonce and tag. */
const OVERHEAD = 1 + 24 + 16;

/** Seals any plaintext as a comment of the given version, with that version's AD unless another is given. */
function sealRaw(version: number, plain: Uint8Array, adVersion = version): Uint8Array {
  const nonce = sodium.randombytes_buf(24);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, enc.encode(`nullbin comment v${adVersion} ${pasteId}`), null, nonce, key);
  return new Uint8Array([version, ...nonce, ...ct]);
}

/** A version 2 plaintext: a 4-byte length, the JSON, then zeros up to `padTo` (the canonical length by default). */
function padded(json: Uint8Array, padTo = paddedLength(4 + json.length, COMMENT_PADDED_LENGTH), length = json.length): Uint8Array {
  const out = new Uint8Array(padTo);
  if (padTo >= 4) new DataView(out.buffer).setUint32(0, length);
  out.set(json.subarray(0, Math.max(0, Math.min(json.length, padTo - 4))), 4);
  return out;
}

test('comment round trip', () => {
  const { bytes, comment } = encryptComment(sodium, key, pasteId, { parent: null, name: '  Ada  ', text: '  Looks good.\nShip it.  ' }, 1_700_000_000_000);
  assert.equal(bytes[0], 2);
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

for (const version of [2, 1]) test(`well-encrypted but malformed comments are rejected (version ${version})`, () => {
  const seal = (v: unknown) => {
    const json = enc.encode(JSON.stringify(v));
    return sealRaw(version, version === 2 ? padded(json) : json);
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

test('comments are padded: every ordinary comment has the same size', () => {
  const sizes = new Set<number>();
  for (const text of ['y', 'no', 'x'.repeat(500), 'Longer reply. '.repeat(300).slice(0, 3800)]) {
    for (const name of ['', 'Ada', 'n'.repeat(40)]) {
      for (const parent of [null, 'b'.repeat(32)]) {
        const { bytes, comment } = encryptComment(sodium, key, pasteId, { parent, name, text });
        sizes.add(bytes.length);
        assert.deepEqual(decryptComment(sodium, key, pasteId, bytes), comment);
      }
    }
  }
  assert.deepEqual([...sizes], [OVERHEAD + COMMENT_PADDED_LENGTH]);
});

test('longer comments are rounded up to a padded length, and the longest still fits', () => {
  // Characters that take more than one byte in JSON push 4,000 of them past
  // the minimum; a control character or lone surrogate takes six.
  for (const text of ['é'.repeat(MAX_COMMENT_LENGTH), '"'.repeat(MAX_COMMENT_LENGTH), '\u0001'.repeat(MAX_COMMENT_LENGTH)]) {
    const { bytes, comment } = encryptComment(sodium, key, pasteId, { parent: 'c'.repeat(32), name: '\uD800'.repeat(40), text });
    const json = enc.encode(JSON.stringify(comment)).length;
    assert.ok(4 + json > COMMENT_PADDED_LENGTH);
    assert.equal(bytes.length, OVERHEAD + paddedLength(4 + json, COMMENT_PADDED_LENGTH));
    assert.ok(bytes.length <= MAX_COMMENT_BYTES, `${bytes.length} bytes`);
    assert.deepEqual(decryptComment(sodium, key, pasteId, bytes), comment);
  }
});

test('version 2 comments must carry exactly their padding', () => {
  const json = enc.encode(JSON.stringify({ id: 'a'.repeat(32), parent: null, name: 'n', text: 't', time: 1 }));
  assert.ok(decryptComment(sodium, key, pasteId, sealRaw(2, padded(json))));
  const nonZero = padded(json);
  nonZero[nonZero.length - 1] = 1;
  const cases: [string, Uint8Array][] = [
    ['unpadded', padded(json, 4 + json.length)],
    ['one byte short', padded(json, COMMENT_PADDED_LENGTH - 1)],
    ['one byte long', padded(json, COMMENT_PADDED_LENGTH + 1)],
    ['padded to the next size', padded(json, paddedLength(COMMENT_PADDED_LENGTH + 1, COMMENT_PADDED_LENGTH))],
    ['non-zero padding', nonZero],
    ['length past the end', padded(json, COMMENT_PADDED_LENGTH, COMMENT_PADDED_LENGTH)],
    ['length cuts the JSON short', padded(json, COMMENT_PADDED_LENGTH, json.length - 1)],
    ['length counts padding as JSON', padded(json, COMMENT_PADDED_LENGTH, json.length + 1)],
    ['no room for the length', new Uint8Array(3)],
    ['empty', new Uint8Array(0)],
  ];
  for (const [label, plain] of cases) assert.equal(decryptComment(sodium, key, pasteId, sealRaw(2, plain)), null, label);
});

test('version 1 comments still open, and neither version can pass as the other', () => {
  const json = enc.encode(JSON.stringify({ id: 'a'.repeat(32), parent: null, name: 'n', text: 'old', time: 1 }));
  assert.equal(decryptComment(sodium, key, pasteId, sealRaw(1, json))?.text, 'old');
  assert.equal(decryptComment(sodium, key, pasteId, sealRaw(2, json, 1)), null, 'v1 relabelled as v2');
  assert.equal(decryptComment(sodium, key, pasteId, sealRaw(1, padded(json), 2)), null, 'v2 relabelled as v1');
  assert.equal(decryptComment(sodium, key, pasteId, sealRaw(1, padded(json))), null, 'a padded plaintext is not a v1 comment');
  for (const version of [0, 3, 255]) {
    for (const plain of [json, padded(json)]) assert.equal(decryptComment(sodium, key, pasteId, sealRaw(version, plain)), null, `version ${version}`);
  }
  const { bytes } = encryptComment(sodium, key, pasteId, { parent: null, name: '', text: 'new' });
  for (const version of [1, 3]) {
    const relabelled = bytes.slice();
    relabelled[0] = version;
    assert.equal(decryptComment(sodium, key, pasteId, relabelled), null, `relabelled as ${version}`);
  }
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
