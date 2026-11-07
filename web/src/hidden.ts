// Shared by the paste viewer and discussions.

// Characters that change how text looks without being visible: every
// Unicode format character (category Cf: direction overrides and isolates,
// zero-width and invisible characters, the soft hyphen, tag characters and
// more) and every control character except tab and line breaks. They let a
// paste display differently from what copying it yields ("Trojan Source",
// CVE-2021-42574). Zero-width joiners and non-joiners are allowed: emoji and
// Persian or Indic scripts use them. So is a byte-order mark at the start.
const HIDDEN_CHARS = /(?![\u200C\u200D\t\n\r])[\p{Cf}\p{Cc}]/u;

/** Reports whether text contains characters that can disguise what it says. */
export function hasHiddenChars(text: string): boolean {
  return HIDDEN_CHARS.test(text.startsWith('\uFEFF') ? text.slice(1) : text);
}

/** Removes every character hasHiddenChars would flag (and line breaks and tabs). */
export function stripHiddenChars(text: string): string {
  return text.replace(/(?![\u200C\u200D])[\p{Cf}\p{Cc}]/gu, '');
}
