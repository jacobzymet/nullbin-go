// Shared by the paste viewer and discussions.

// Characters that change how text looks without being visible: direction
// overrides, embeddings, isolates and marks, the zero-width space, the word
// joiner, a byte-order mark after the start, and Unicode tag characters.
// They let a paste display differently from what copying it yields
// ("Trojan Source", CVE-2021-42574). Zero-width joiners and non-joiners are
// not flagged: emoji and Persian or Indic scripts use them legitimately.
const HIDDEN_CHARS = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069]|(?<!^)\uFEFF|[\u{E0000}-\u{E007F}]/u;

/** Reports whether text contains characters that can disguise what it says. */
export function hasHiddenChars(text: string): boolean {
  return HIDDEN_CHARS.test(text);
}
