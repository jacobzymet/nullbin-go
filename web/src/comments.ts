// Encrypted comments for discussion pastes.
//
// Wire format of one comment (what the server stores), version 2:
//   version (1 byte = 2) || nonce (24 bytes) ||
//   XChaCha20-Poly1305(length of JSON (4 bytes, big-endian) ||
//                      JSON {id, parent, name, text, time} || zeros,
//                      key = comment key, AD = "nullbin comment v2 <paste id>")
// The plaintext is padded to paddedLength(4 + JSON length,
// COMMENT_PADDED_LENGTH): 4 KiB for every comment that fits, which is
// almost all of them, so the server cannot tell a short reply from a long
// one. Readers accept only that exact length with zero padding.
//
// Version 1 (written before padding, still read): the same without the
// length and padding, with AD "nullbin comment v1 <paste id>". The version
// is part of the AD, so a comment cannot be relabelled as the other version.
//
// The comment key and the access token come from the paste's master key
// (see crypto.ts), so only readers who know the link and the password can
// read or post. Thread structure (parent) is inside the ciphertext: the
// server sees only an ordered list of opaque blobs.
//
// Names are not authenticated: anyone with the link and password can post
// under any name.

import type { Sodium } from './sodium.ts';
import { PasteError, paddedLength } from './format.ts';

export const COMMENT_VERSION = 2;
/** Unpadded comments, written before version 2. Still read. */
export const COMMENT_VERSION_UNPADDED = 1;
/** Every comment's plaintext is padded to at least this many bytes. */
export const COMMENT_PADDED_LENGTH = 4 * 1024;
const LENGTH_BYTES = 4;
export const MAX_NAME_LENGTH = 40;
export const MAX_COMMENT_LENGTH = 4000;
/** Must match the server's limit. */
export const MAX_COMMENT_BYTES = 32 * 1024;
/** Largest millisecond timestamp supported by JavaScript Date. */
export const MAX_COMMENT_TIME = 8_640_000_000_000_000;

const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const ID = /^[0-9a-f]{32}$/;
// Control characters, bidi overrides and invisible characters, which could
// disguise a name.
const UNSAFE_CHARS = /(?![\u200C\u200D])[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800]/gu;

export interface CommentDraft {
  /** id of the comment this replies to, or null. */
  parent: string | null;
  name: string;
  text: string;
}

export interface Comment extends CommentDraft {
  id: string;
  /** Milliseconds since the epoch, from the writer's clock. */
  time: number;
}

export function cleanName(name: string): string {
  return name.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

function ad(version: number, pasteId: string): Uint8Array {
  return new TextEncoder().encode(`nullbin comment v${version} ${pasteId}`);
}

/** Encrypts a new comment. Throws PasteError if it is empty or too long. */
export function encryptComment(
  sodium: Sodium,
  key: Uint8Array,
  pasteId: string,
  draft: CommentDraft,
  now: number = Date.now(),
): { bytes: Uint8Array; comment: Comment } {
  const text = draft.text.trim();
  if (text.length === 0) throw new PasteError('format', 'Write a comment first.');
  if (text.length > MAX_COMMENT_LENGTH) {
    throw new PasteError('too-large', `Comments can be up to ${MAX_COMMENT_LENGTH.toLocaleString('en')} characters.`);
  }
  if (draft.parent !== null && !ID.test(draft.parent)) throw new Error('bad parent id');
  if (!Number.isSafeInteger(now) || now <= 0 || now > MAX_COMMENT_TIME) throw new PasteError('format', 'Invalid comment time.');
  const comment: Comment = {
    id: sodium.to_hex(sodium.randombytes_buf(16)),
    parent: draft.parent,
    name: cleanName(draft.name),
    text,
    time: Math.floor(now),
  };
  const json = new TextEncoder().encode(JSON.stringify(comment));
  const plain = new Uint8Array(paddedLength(LENGTH_BYTES + json.length, COMMENT_PADDED_LENGTH)); // zero-filled
  new DataView(plain.buffer).setUint32(0, json.length);
  plain.set(json, LENGTH_BYTES);
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, ad(COMMENT_VERSION, pasteId), null, nonce, key);
  const bytes = new Uint8Array(1 + NONCE_BYTES + ct.length);
  bytes[0] = COMMENT_VERSION;
  bytes.set(nonce, 1);
  bytes.set(ct, 1 + NONCE_BYTES);
  if (bytes.length > MAX_COMMENT_BYTES) throw new PasteError('too-large', 'This comment is too long.');
  return { bytes, comment };
}

/**
 * Decrypts and validates one stored comment. Returns null for anything
 * that is not an authentic, well-formed comment of this paste (garbage,
 * tampering, another paste's comment, an unknown version).
 */
export function decryptComment(sodium: Sodium, key: Uint8Array, pasteId: string, bytes: Uint8Array): Comment | null {
  const version = bytes[0];
  if (bytes.length < 1 + NONCE_BYTES + TAG_BYTES || bytes.length > MAX_COMMENT_BYTES) return null;
  if (version !== COMMENT_VERSION && version !== COMMENT_VERSION_UNPADDED) return null;
  let plain: Uint8Array;
  try {
    plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      bytes.subarray(1 + NONCE_BYTES),
      ad(version, pasteId),
      bytes.subarray(1, 1 + NONCE_BYTES),
      key,
    );
  } catch {
    return null;
  }
  let json = plain;
  if (version === COMMENT_VERSION) {
    // Exactly the padded length for this JSON length, and only zeros after it.
    if (plain.length < LENGTH_BYTES) return null;
    const length = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0);
    // Also rules out a length past the end: the padded length is never shorter.
    if (plain.length !== paddedLength(LENGTH_BYTES + length, COMMENT_PADDED_LENGTH)) return null;
    if (!plain.subarray(LENGTH_BYTES + length).every((b) => b === 0)) return null;
    json = plain.subarray(LENGTH_BYTES, LENGTH_BYTES + length);
  }
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== 'id,name,parent,text,time') return null;
  const { id, parent, name, text, time } = o;
  if (typeof id !== 'string' || !ID.test(id)) return null;
  if (parent !== null && (typeof parent !== 'string' || !ID.test(parent) || parent === id)) return null;
  if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH) return null;
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_COMMENT_LENGTH) return null;
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time <= 0 || time > MAX_COMMENT_TIME) return null;
  return { id, parent, name: cleanName(name), text, time };
}

export interface ThreadNode {
  comment: Comment;
  replies: ThreadNode[];
}

/** Comments with duplicate ids (a replayed comment) removed, keeping the first copy. */
export function uniqueComments(comments: Comment[]): Comment[] {
  const seen = new Set<string>();
  return comments.filter((c) => !seen.has(c.id) && seen.add(c.id));
}

/**
 * Builds the reply tree in arrival order. Duplicate ids (a replayed
 * comment) keep the first copy. A reply sits under its parent wherever the
 * server placed the two in the list. Replies to unknown comments, and
 * comments whose parents lead back to themselves, become top-level.
 */
export function buildThread(comments: Comment[]): ThreadNode[] {
  const nodes = new Map<string, ThreadNode>();
  for (const c of uniqueComments(comments)) nodes.set(c.id, { comment: c, replies: [] });
  const loops = (node: ThreadNode): boolean => {
    const seen = new Set<string>([node.comment.id]);
    for (let p = node.comment.parent; p !== null; ) {
      if (seen.has(p)) return true;
      seen.add(p);
      const up = nodes.get(p);
      if (!up) return false;
      p = up.comment.parent;
    }
    return false;
  };
  const roots: ThreadNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.comment.parent ? nodes.get(node.comment.parent) : undefined;
    if (parent && !loops(node)) parent.replies.push(node);
    else roots.push(node);
  }
  return roots;
}
