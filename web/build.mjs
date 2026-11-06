// Builds the frontend into internal/assets/dist for go:embed:
//   app.js     one ES module bundle (TypeScript + libsodium.js)
//   app.css    one stylesheet (Bootstrap 5.3.8 CSS + Nullbin styles)
//   index.html the page, with Subresource Integrity hashes filled in
//
// The output is deterministic: the same sources, lockfile and esbuild
// version give byte-identical files on every machine.

import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseAPIOrigin, frontendHeaders } from './frontend.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(root, 'internal', 'assets', 'dist');
const staticDir = path.join(root, 'web', 'dist');
const generatedDir = path.join(root, 'web', 'generated');
const frontendOnly = process.argv.includes('--frontend-only');
const apiOrigin = parseAPIOrigin(process.env.NULLBIN_API_ORIGIN ?? '');

// The version shown in the footer. Docker and release builds pass it in
// NULLBIN_VERSION (from the VERSION build argument). Otherwise a build from
// a Git checkout asks Git: "v1.2.3" on a release, "v1.2.3-4-gabc1234" four
// commits later. Without either, it is "dev".
function buildVersion() {
  const given = process.env.NULLBIN_VERSION;
  if (given !== undefined && given !== '') return given;
  try {
    return execFileSync('git', ['describe', '--tags', '--always', '--dirty'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'dev';
  }
}
const version = buildVersion();
if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(version)) {
  console.error(`build: invalid version ${JSON.stringify(version)}`);
  process.exit(1);
}
const wordmarkLicense = await readFile(path.join(root, 'web', 'fonts', 'OFL.txt'), 'utf8');

const common = {
  absWorkingDir: root,
  bundle: true,
  minify: true,
  write: false,
  sourcemap: false,
  charset: 'utf8',
  legalComments: 'eof',
  logLevel: 'warning',
};

const js = await esbuild.build({
  ...common,
  entryPoints: ['web/src/main.ts'],
  outfile: 'app.js',
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  loader: { '.ttf': 'binary' },
  define: { __NULLBIN_API_ORIGIN__: JSON.stringify(apiOrigin) },
  // libsodium.js ships no license comment of its own; its ISC license asks
  // for the notice in all copies.
  banner: {
    js: `/*! Nullbin bundles libsodium.js (and libsodium, ISC License). See THIRD_PARTY_NOTICES.
 * libsodium.js: Copyright (c) 2015-2026 Ahmad Ben Mrad <batikhsouri at gmail dot org>,
 * Frank Denis <j at pureftpd dot org>, Ryan Lester <ryan at cyph dot com>.
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
/*! Damion — bundled wordmark font.
${wordmarkLicense}
 */`,
  },
});

// Progress-bar width classes, so the UI never needs inline styles.
let widths = '';
for (let i = 0; i <= 100; i++) widths += `.nb-w-${i}{width:${i}%}`;

const css = await esbuild.build({
  ...common,
  stdin: {
    contents: `@import "./app.css";\n${widths}\n`,
    resolveDir: path.join(root, 'web', 'styles'),
    sourcefile: 'web/styles/entry.css',
    loader: 'css',
  },
  outfile: 'app.css',
});

const jsBytes = js.outputFiles[0].contents;
const cssBytes = css.outputFiles[0].contents;
const jsText = new TextDecoder().decode(jsBytes);
const cssText = new TextDecoder().decode(cssBytes);

// Guard rails. The browser test is the real check; these catch mistakes
// at build time.
const fail = (msg) => {
  console.error(`build: ${msg}`);
  process.exit(1);
};
for (const m of cssText.matchAll(/url\(\s*(['"]?)([^'")]*)/g)) {
  if (!m[2].startsWith('data:')) fail(`app.css references a non-data URL: ${m[2].slice(0, 80)}`);
}
if (/@import/.test(cssText)) fail('app.css still contains @import');
if (!/Bootstrap\s+v5\.3\.8/.test(cssText) || !/Licensed under MIT/.test(cssText)) fail("Bootstrap's MIT license notice is missing from app.css");
if (/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write/.test(jsText)) fail('app.js uses an HTML-injection API');
if (/\beval\(|new Function\(/.test(jsText)) fail('app.js uses eval or new Function');

const sri = (bytes) => `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
const hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

let html = await readFile(path.join(root, 'web', 'index.html'), 'utf8');
if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) fail('index.html has an inline script');
if (/<style[\s>]/i.test(html) || /\sstyle\s*=/i.test(html)) fail('index.html has inline styles');
if (/\son[a-z]+\s*=/i.test(html)) fail('index.html has an inline event handler');
if (/(src|href)\s*=\s*"(https?:)?\/\//i.test(html)) fail('index.html references another origin');
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const dup = ids.find((id, i) => ids.indexOf(id) !== i);
if (dup) fail(`index.html has a duplicate id: ${dup}`);
html = html.replace('__JS_INTEGRITY__', sri(jsBytes)).replace('__CSS_INTEGRITY__', sri(cssBytes));
// The footer's Version link opens the API's version endpoint. With a
// separately hosted API that is on another origin, fixed at build time.
const versionLink = 'href="/api/v1/version"';
if (html.split(versionLink).length !== 2) fail('index.html must contain exactly one Version link');
html = html.replace(versionLink, `href="${apiOrigin}/api/v1/version"`);
if (html.split('__NULLBIN_VERSION__').length !== 2) fail('index.html must show the version exactly once');
html = html.replace('__NULLBIN_VERSION__', version);
if (html.includes('__')) fail('index.html has an unreplaced placeholder');
const htmlBytes = new TextEncoder().encode(html);

if (!frontendOnly) {
  await mkdir(outDir, { recursive: true });
  for (const name of await readdir(outDir)) {
    if (name !== '.gitkeep') await rm(path.join(outDir, name), { recursive: true });
  }
  await writeFile(path.join(outDir, 'app.js'), jsBytes);
  await writeFile(path.join(outDir, 'app.css'), cssBytes);
  await writeFile(path.join(outDir, 'index.html'), htmlBytes);
}

// Standalone frontend: copy this directory to a static host. Public assets
// have content-hashed names; index.html always requests a fresh version.
await rm(staticDir, { recursive: true, force: true });
await mkdir(path.join(staticDir, 'assets'), { recursive: true });
await mkdir(generatedDir, { recursive: true });
const jsName = `app.${hex(jsBytes)}.js`;
const cssName = `app.${hex(cssBytes)}.css`;
const staticHTML = html.replace('/assets/app.js', `/assets/${jsName}`).replace('/assets/app.css', `/assets/${cssName}`);
await writeFile(path.join(staticDir, 'index.html'), staticHTML);
await writeFile(path.join(staticDir, 'assets', jsName), jsBytes);
await writeFile(path.join(staticDir, 'assets', cssName), cssBytes);
const headers = frontendHeaders(apiOrigin);
let headersFile = '/*\n' + Object.entries(headers).map(([k, v]) => `  ${k}: ${v}\n`).join('');
for (const page of ['/', '/index.html', '/p/*', '/d/*', '/version.json']) headersFile += `${page}\n  Cache-Control: no-store\n`;
headersFile += '/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n';
await writeFile(path.join(staticDir, '_headers'), headersFile);
await writeFile(path.join(staticDir, '_redirects'), '/p/* /index.html 200\n/d/* /index.html 200\n');
await writeFile(path.join(staticDir, 'version.json'), JSON.stringify({
  version,
  api_origin: apiOrigin || 'same-origin',
  html_sha256: hex(new TextEncoder().encode(staticHTML)),
  js: `/assets/${jsName}`, js_sha256: hex(jsBytes),
  css: `/assets/${cssName}`, css_sha256: hex(cssBytes),
}) + '\n');
await writeFile(path.join(generatedDir, 'headers.caddy'), 'header {\n' +
  Object.entries(headers).map(([k, v]) => `  ${k} ${JSON.stringify(v)}\n`).join('') + '}\n');

console.log(`app.js     ${String(jsBytes.length).padStart(8)} bytes  sha256 ${hex(jsBytes)}`);
console.log(`app.css    ${String(cssBytes.length).padStart(8)} bytes  sha256 ${hex(cssBytes)}`);
console.log(`index.html ${String(htmlBytes.length).padStart(8)} bytes  sha256 ${hex(htmlBytes)}`);
console.log(`Static frontend: web/dist/ (API: ${apiOrigin || 'same origin'})`);
