// Source hygiene: no invisible or direction-changing characters anywhere in
// the code, configuration or docs. They can make code display differently
// from what it does ("Trojan Source", CVE-2021-42574). Write such
// characters as escapes (for example a backslash, u and 202E) instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const hidden = new Set([
  0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
]);
const skipDirs = new Set(['node_modules', '.git', 'dist', 'generated', 'out', 'data', 'testdata']);
const textFile = /\.(ts|mjs|js|go|html|css|md|ya?ml|json|txt|example)$|^(Dockerfile|Caddyfile.*|LICENSE|THIRD_PARTY_NOTICES|go\.mod|\.[a-z]+)$/;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!skipDirs.has(name)) yield* files(full);
    } else if (textFile.test(name)) {
      yield full;
    }
  }
}

test('no source, config or doc file contains invisible or direction-changing characters', () => {
  const found: string[] = [];
  let checked = 0;
  for (const file of files(root)) {
    checked++;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const ch of line) {
        const cp = ch.codePointAt(0)!;
        if (hidden.has(cp) || (cp >= 0xe0000 && cp <= 0xe007f)) {
          found.push(`${path.relative(root, file)}:${i + 1} U+${cp.toString(16).toUpperCase()}`);
        }
      }
    });
  }
  assert.ok(checked > 50, `only ${checked} files were checked`);
  assert.deepEqual(found, [], 'write these characters as escapes');
});
