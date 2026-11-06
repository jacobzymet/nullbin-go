// Encrypted comments for discussion pastes.
//
// Wire format of one comment (what the server stores):
//   version (1 byte = 1) || nonce (24 bytes) ||
//   XChaCha20-Poly1305(JSON {id, parent, name, text, time},
//                      key = comment key, AD = "nullbin comment v1 <paste id>")
//
// The comment key and the access token come from the paste's master key
// (see crypto.ts), so only readers who know the link and the password can
// read or post. Thread structure (parent) is inside the ciphertext: the
// server sees only an ordered list of opaque blobs.
//
// Names are not authenticated: anyone with the link and password can post
// under any name.

import type { Sodium } from './sodium.ts';
import { PasteError } from './format.ts';

export const COMMENT_VERSION = 1;
export const MAX_NAME_LENGTH = 40;
export const MAX_COMMENT_LENGTH = 4000;
/** Must match the server's limit. */
export const MAX_COMMENT_BYTES = 32 * 1024;
/** Largest millisecond timestamp supported by JavaScript Date. */
export const MAX_COMMENT_TIME = 8_640_000_000_000_000;

const NONCE_BYTES = 24;
const ID = /^[0-9a-f]{32}$/;
// Control characters and bidi overrides, which could disguise a name.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

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

function ad(pasteId: string): Uint8Array {
  return new TextEncoder().encode(`nullbin comment v1 ${pasteId}`);
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
  const plain = new TextEncoder().encode(JSON.stringify(comment));
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, ad(pasteId), null, nonce, key);
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
  if (bytes.length < 1 + NONCE_BYTES + 16 || bytes.length > MAX_COMMENT_BYTES || bytes[0] !== COMMENT_VERSION) return null;
  let plain: Uint8Array;
  try {
    plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      bytes.subarray(1 + NONCE_BYTES),
      ad(pasteId),
      bytes.subarray(1, 1 + NONCE_BYTES),
      key,
    );
  } catch {
    return null;
  }
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
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

/**
 * Builds the reply tree in arrival order. Duplicate ids (a replayed
 * comment) keep the first copy. Replies to unknown comments, and replies
 * that would form a loop, become top-level comments.
 */
export function buildThread(comments: Comment[]): ThreadNode[] {
  const nodes = new Map<string, ThreadNode>();
  const order = new Map<string, number>();
  comments.forEach((c, i) => {
    if (nodes.has(c.id)) return;
    nodes.set(c.id, { comment: c, replies: [] });
    order.set(c.id, i);
  });
  const roots: ThreadNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.comment.parent ? nodes.get(node.comment.parent) : undefined;
    // A parent must have arrived earlier; this also rules out loops.
    if (parent && order.get(parent.comment.id)! < order.get(node.comment.id)!) parent.replies.push(node);
    else roots.push(node);
  }
  return roots;
}
