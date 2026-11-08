/** Bound both line layout and character shaping for attacker-written text. */
export const MAX_PREVIEW_LINES = 5000;
export const MAX_PREVIEW_CHARS = 100_000;

/** Count without splitting millions of lines into a large temporary array. */
export function textPreview(text: string): { text: string; lines: number; truncated: boolean } {
  let lines = 1;
  let end = Math.min(text.length, MAX_PREVIEW_CHARS);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13 && text.charCodeAt(i + 1) === 10) continue;
    if ((c !== 10 && c !== 13) || i === text.length - 1) continue;
    lines++;
    if (lines === MAX_PREVIEW_LINES + 1) end = Math.min(end, c === 10 && i > 0 && text.charCodeAt(i - 1) === 13 ? i - 1 : i);
  }
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return { text: text.slice(0, end), lines, truncated: end < text.length };
}
