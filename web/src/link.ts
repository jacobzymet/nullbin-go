// URL fragments. The fragment is never sent to the server by browsers.
//
//   view link:   /p/<id>#<key>      or /p/<id>#<key>.b  (.b = burn after reading)
//   delete link: /d/<id>#<delete token>

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

/** Parses "#<delete token>". The token is opaque: 43 base64url characters. */
export function parseTokenFragment(fragment: string): string | null {
  const f = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  return B64URL_32_BYTES.test(f) ? f : null;
}
