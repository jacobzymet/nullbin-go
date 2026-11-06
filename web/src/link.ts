// URL fragments. The fragment is never sent to the server by browsers.
//
//   view link:   /p/<id>#<key>      or /p/<id>#<key>.b  (.b = burn after reading)
//   delete link: /d/<id>#d.<delete token>
//
// Keys and delete tokens are both 43 random base64url characters. The "d."
// marks a delete token, so a view link edited to /d/ can never send its key
// to the server as a delete token.

import type { Sodium } from './sodium.ts';
import { KEY_BYTES } from './format.ts';

const B64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

export function encodeKeyFragment(sodium: Sodium, key: Uint8Array, burn: boolean): string {
  if (key.length !== KEY_BYTES) throw new Error('bad key length');
  const k = sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);
  return burn ? `${k}.b` : k;
}

export interface KeyFragment {
  key: Uint8Array;
  burn: boolean;
}

/** Parses "#<key>" or "#<key>.b". Returns null for anything else. */
export function parseKeyFragment(sodium: Sodium, fragment: string): KeyFragment | null {
  const f = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  const parts = f.split('.');
  if (parts.length > 2 || (parts.length === 2 && parts[1] !== 'b')) return null;
  const k = parts[0] ?? '';
  if (!B64URL_32_BYTES.test(k)) return null;
  let key: Uint8Array;
  try {
    key = sodium.from_base64(k, sodium.base64_variants.URLSAFE_NO_PADDING);
  } catch {
    return null;
  }
  // Reject non-canonical encodings (stray bits in the last character).
  if (key.length !== KEY_BYTES || sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING) !== k) return null;
  return { key, burn: parts.length === 2 };
}

/** The fragment of a delete link, without the "#". */
export function encodeTokenFragment(token: string): string {
  if (!B64URL_32_BYTES.test(token)) throw new Error('bad delete token');
  return `d.${token}`;
}

/** Parses "#d.<delete token>". The token is opaque: 43 base64url characters. */
export function parseTokenFragment(fragment: string): string | null {
  const f = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!f.startsWith('d.')) return null;
  const token = f.slice(2);
  return B64URL_32_BYTES.test(token) ? token : null;
}
