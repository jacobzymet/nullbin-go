// Unit tests for UI helpers that do not need a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UPLOAD_CHUNK, fetchPaste, rechunk } from '../src/api.ts';
import { hasHiddenChars, safeFilename, textPreview, MAX_PREVIEW_LINES, MAX_PREVIEW_CHARS } from '../src/view.ts';
import { CloneableAttachment, MAX_BUFFERED_DOWNLOAD } from '../src/attachments.ts';
import { emailHref } from '../src/share.ts';

async function* pieces(sizes: number[]): AsyncGenerator<Uint8Array> {
  let v = 0;
  for (const n of sizes) {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = v++ & 0xff;
    yield b;
  }
}

test('clone attachments are verified completely, reusable, and bounded', async () => {
  const source = new CloneableAttachment(pieces([3, 4]), 'note.txt', 7, 'text/plain');
  const file = await source.clone();
  assert.equal(file.name, 'note.txt');
  assert.equal(file.type, 'text/plain');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(await source.clone(), file, 'repeat cloning uses the verified file');
  const saved: number[] = [];
  for await (const chunk of source.stream()) saved.push(...chunk);
  assert.deepEqual(saved, [0, 1, 2, 3, 4, 5, 6]);
  const empty = await new CloneableAttachment(pieces([]), 'empty.txt', 0, '').clone();
  assert.equal(empty.size, 0);
  let read = false;
  const huge = new CloneableAttachment((async function* () { read = true; yield new Uint8Array(1); })(), 'big.bin', MAX_BUFFERED_DOWNLOAD + 1, '');
  assert.equal(huge.canClone, false);
  await assert.rejects(huge.clone(), /64 MiB/);
  assert.equal(read, false, 'over-limit cloning does not consume the attachment');
});

test('cloning rejects truncation, excess bytes, authentication failure, and concurrent access', async () => {
  for (const source of [
    new CloneableAttachment(pieces([2]), 'bad', 3, ''),
    new CloneableAttachment(pieces([4]), 'bad', 3, ''),
    new CloneableAttachment((async function* () { yield new Uint8Array(3); throw Error('invalid final tag'); })(), 'bad', 3, ''),
  ]) {
    await assert.rejects(source.clone());
    assert.equal(source.canClone, false);
    await assert.rejects(source.clone(), /already being read|could not be verified/);
  }
  const source = new CloneableAttachment(pieces([3, 4]), 'file', 7, '');
  const stream = source.stream();
  await stream.next();
  await assert.rejects(source.clone(), /already being read/);
  await stream.return();
  assert.equal(source.canClone, false, 'abandoned streams never publish a file');
});

test('email sharing includes the complete secret link without injectable headers', () => {
  const link = `https://paste.example/p/${'a'.repeat(32)}#${'B'.repeat(43)}.b`;
  const href = new URL(emailHref(link));
  assert.equal(href.protocol, 'mailto:');
  assert.equal(href.searchParams.get('subject'), 'Encrypted note on Nullbin');
  assert.ok(href.searchParams.get('body')!.includes(link));
  assert.deepEqual([...href.searchParams.keys()], ['subject', 'body']);
  const malicious = new URL(emailHref(`${link}\r\n&bcc=attacker@example.com`));
  assert.equal(malicious.searchParams.has('bcc'), false);
});

test('rechunk regroups a stream into fixed-size pieces without losing bytes', async () => {
  for (const sizes of [[], [0], [10], [3, 3, 3, 3], [1, 100, 7, 25, 0, 2], [64, 64]]) {
    const out: Uint8Array[] = [];
    for await (const c of rechunk(pieces(sizes), 16)) out.push(c.slice());
    const total = sizes.reduce((a, b) => a + b, 0);
    assert.equal(out.reduce((n, c) => n + c.length, 0), total);
    out.forEach((c, i) => {
      if (i < out.length - 1) assert.equal(c.length, 16);
      else assert.ok(c.length > 0 && c.length <= 16);
    });
    const flat = out.flatMap((c) => [...c]);
    flat.forEach((b, i) => assert.equal(b, i & 0xff));
  }
});

test('safeFilename strips paths and control characters', () => {
  const cases: [string | null, string][] = [
    ['report.pdf', 'report.pdf'],
    ['../../etc/passwd', '_.._etc_passwd'],
    ['..\\..\\windows\\system32', '_.._windows_system32'],
    ['.bashrc', 'bashrc'],
    ['a\u0000b\nc.txt', 'a_b_c.txt'],
    ['invoice\u202Efdp.exe', 'invoice_fdp.exe'], // right-to-left override hides the real extension
    ['x\u2066y\u200Fz', 'x_y_z'],
    ['a\u00ADb\u2061c\uFFF9d.txt', 'a_b_c_d.txt'], // soft hyphen, invisible operator, annotation
    ['con:name?.txt', 'con_name_.txt'],
    ['', 'download'],
    [null, 'download'],
    ['...', 'download'],
    ['x'.repeat(300), 'x'.repeat(200)],
    // Windows device names, which would not save as a normal file.
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['COM1', '_COM1'],
    ['lpt9.log', '_lpt9.log'],
    ['CONOUT$', '_CONOUT$'],
    ['aux .txt', '_aux .txt'],
    ['console.txt', 'console.txt'],
    ['report. . ', 'report'],
  ];
  for (const [input, want] of cases) assert.equal(safeFilename(input), want, String(input));
});

test('a chunk whose response was lost is not uploaded twice', async () => {
  const { putChunk } = await import('../src/api.ts');
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  let stored = false;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    if (!stored) {
      stored = true; // the server stores the chunk, then the connection drops
      throw new TypeError('network error');
    }
    return new Response(JSON.stringify({ error: 'chunk out of order', next_chunk: 4 }), { status: 409 });
  }) as typeof fetch;
  try {
    await putChunk('0123456789abcdef0123456789abcdef', 3, 'x'.repeat(43), new Uint8Array(1));
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a genuinely out-of-order chunk is an error', async () => {
  const { putChunk, ApiError } = await import('../src/api.ts');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'chunk out of order', next_chunk: 0 }), { status: 409 })) as typeof fetch;
  try {
    await assert.rejects(putChunk('0123456789abcdef0123456789abcdef', 3, 'x'.repeat(43), new Uint8Array(1)), ApiError);
  } finally {
    globalThis.fetch = realFetch;
  }
});


test('text preview bounds line allocation and layout while preserving full counts', () => {
  // A lone \r is a line break too, as the browser displays it.
  for (const [text, lines] of [['', 1], ['one', 1], ['one\n', 1], ['one\r\ntwo', 2], ['\n\n', 2], ['a\rb\rc', 3], ['a\r\rb', 3], ['one\r', 1], ['a\r\nb\rc\n', 3]] as const) {
    assert.deepEqual(textPreview(text), { text, lines, truncated: false });
  }
  const text = '\n'.repeat(8_000_000);
  const preview = textPreview(text);
  assert.equal(preview.lines, text.length);
  assert.equal(preview.truncated, true);
  assert.ok(preview.text.split('\n').length <= MAX_PREVIEW_LINES);
  const long = textPreview('x'.repeat(MAX_PREVIEW_CHARS + 1));
  assert.equal(long.text.length, MAX_PREVIEW_CHARS);
  assert.equal(long.truncated, true);
  const unicode = textPreview('x'.repeat(MAX_PREVIEW_CHARS - 1) + '😀');
  assert.equal(unicode.text.length, MAX_PREVIEW_CHARS - 1);
  assert.equal(textPreview('row\r\n'.repeat(MAX_PREVIEW_LINES + 1)).text.split('\r\n').length, MAX_PREVIEW_LINES);
  assert.equal(textPreview('row\r'.repeat(MAX_PREVIEW_LINES + 1)).text.split('\r').length, MAX_PREVIEW_LINES);
});

test('remaining-open metadata accepts valid counts and legacy responses, and rejects malformed counts', async () => {
  const original = globalThis.fetch;
  try {
    for (const header of [null, '0', '2', '999', '-1', '1.5', '1000', '', 'not-a-number']) {
      globalThis.fetch = (async () => new Response('ciphertext', {
        headers: header === null ? {} : { 'Nullbin-Reads-Remaining': header },
      })) as typeof fetch;
      if (header === null || ['0', '2', '999'].includes(header)) {
        const paste = await fetchPaste('0123456789abcdef0123456789abcdef', 'token');
        assert.equal(paste.readsRemaining, header === null ? 0 : Number(header));
        await paste.body.cancel();
      } else {
        await assert.rejects(fetchPaste('0123456789abcdef0123456789abcdef', 'token'), /invalid read count/);
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});

// Browser translation and enhanced spell check (Chrome, Edge) send page
// text to cloud services. Every field that can hold a secret must opt out,
// including password fields, which "Show password" turns into text fields.
test('the page opts out of translation, and every text field opts out of spell check', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<html [^>]*translate="no"/);
  assert.match(html, /<meta name="google" content="notranslate">/);
  const fields = html.match(/<(textarea|input)\b[^>]*>/g) ?? [];
  const textual = fields.filter((f) => f.startsWith('<textarea') || !/type="(checkbox|file|number|radio|hidden)"/.test(f));
  assert.ok(textual.length >= 6, `expected the text and password fields, found ${textual.length}`);
  for (const f of textual) {
    if (/\breadonly\b/.test(f)) continue;
    for (const attr of ['spellcheck="false"', 'autocorrect="off"', 'autocapitalize="off"']) {
      assert.ok(f.includes(attr), `${f} is missing ${attr}`);
    }
  }
});

test('upload chunks meet the server minimum and maximum', () => {
  // internal/storage.MinChunkBytes and internal/server.maxChunkBody.
  assert.ok(UPLOAD_CHUNK >= 4 * 1024 * 1024 && UPLOAD_CHUNK <= 8 * 1024 * 1024);
});

test('text that can look different from what it contains is flagged', () => {
  // Trojan Source: an override makes a line display reversed.
  assert.equal(hasHiddenChars('if (admin) {\u202E } \u2066// check\u2069'), true);
  for (const c of ['\u061C', '\u200B', '\u200E', '\u200F', '\u202A', '\u202E', '\u2060', '\u2066', '\u2069', '\uFEFF', '\u{E0041}',
    '\u00AD', '\u2061', '\u2064', '\u206A', '\u206F', '\u180E', '\uFFF9', '\uFFFB', '\u0008', '\u001B']) {
    assert.equal(hasHiddenChars(`a${c}b`), true, `U+${c.codePointAt(0)!.toString(16)} must be flagged`);
  }
  // Ordinary text, accents, right-to-left scripts, emoji and a leading BOM are fine.
  for (const ok of ['plain text\n\tindented', 'café naïve', 'שלום עולם', 'مرحبا', '👍🏽 👨\u200D👩\u200D👧', 'می\u200Cخواهم', '\uFEFFfirst line']) {
    assert.equal(hasHiddenChars(ok), false, `${JSON.stringify(ok)} must not be flagged`);
  }
});

test('blank-looking characters cannot pad names, and line separators are flagged in text', async () => {
  const { cleanName } = await import('../src/comments.ts');
  const { stripHiddenChars } = await import('../src/hidden.ts');
  const c = (n: number) => String.fromCharCode(n);
  for (const n of [0x2028, 0x2029, 0x115f, 0x1160, 0x3164, 0xffa0, 0x2800]) {
    assert.equal(safeFilename(`invoice${c(n)}.pdf.exe`), 'invoice_.pdf.exe', n.toString(16));
    assert.equal(cleanName(`ad${c(n)}min`), 'admin', n.toString(16));
    assert.equal(stripHiddenChars(`image/png${c(n)}`), 'image/png', n.toString(16));
  }
  assert.equal(hasHiddenChars(`a${c(0x2028)}b`), true, 'a line separator is flagged in text');
  assert.equal(hasHiddenChars(`Braille ${c(0x2800)}${c(0x2801)}`), false, 'Braille text is not flagged');
});
