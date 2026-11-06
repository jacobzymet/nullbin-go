// Loads libsodium (WebAssembly, bundled; nothing is fetched from elsewhere).

import sodium from 'libsodium-wrappers-sumo';
import { ABYTES, KEY_BYTES, SALT_BYTES, STREAM_HEADER_BYTES } from './format.ts';

export type Sodium = typeof sodium;

let loading: Promise<Sodium> | null = null;

export function loadSodium(): Promise<Sodium> {
  loading ??= sodium.ready.then(() => {
    // The blob format hard-codes these sizes. Refuse to run with a build
    // where they differ.
    if (
      sodium.crypto_secretstream_xchacha20poly1305_ABYTES !== ABYTES ||
      sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES !== STREAM_HEADER_BYTES ||
      sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES !== KEY_BYTES ||
      sodium.crypto_pwhash_SALTBYTES !== SALT_BYTES
    ) {
      throw new Error('Unexpected libsodium build.');
    }
    return sodium;
  });
  return loading;
}
