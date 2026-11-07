// End-to-end browser test. Starts the real nullbin binary (with the real
// embedded bundles and the real headers) and drives Chrome through every
// page. It fails on:
//   - any Content-Security-Policy violation
//   - any request to an origin other than the nullbin server
//   - any console error or warning, or uncaught page error
//
// Requirements: `npm run build` first; Go on PATH (or NB_TEST_BINARY set to
// a built binary); Google Chrome installed (or CHROME_PATH set).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { createServer, type Server } from 'node:http';
import { frontendHeaders } from '../../frontend.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { UPLOAD_CHUNK, rechunk } from '../../src/api.ts';
import { preparePaste } from '../../src/crypto.ts';
import { encodeKeyFragment } from '../../src/link.ts';
import { loadSodium } from '../../src/sodium.ts';

const EXPECTED_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; " +
  "img-src 'self' blob: data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; " +
  "require-trusted-types-for 'script'; trusted-types 'none'";

const root = path.resolve(import.meta.dirname, '..', '..', '..');
let tmp = '';
let server: ChildProcess | null = null;
let serverLog = '';
let browser: Browser;
let origin = '';
let apiOrigin = '';
let frontend: Server | null = null;
let restartAPI: () => Promise<void>;
const split = process.env['NB_TEST_SPLIT'] === '1';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

before(async () => {
  assert.ok(existsSync(path.join(root, 'internal', 'assets', 'dist', 'app.js')), 'run `npm run build` first');
  tmp = await mkdtemp(path.join(tmpdir(), 'nullbin-browser-'));
  let bin = process.env['NB_TEST_BINARY'] ?? '';
  if (!bin) {
    bin = path.join(tmp, process.platform === 'win32' ? 'nullbin.exe' : 'nullbin');
    execFileSync('go', ['build', '-trimpath', '-o', bin, './cmd/nullbin'], { cwd: root, stdio: 'inherit' });
  }
  const port = await freePort();
  apiOrigin = `http://127.0.0.1:${port}`;
  origin = split ? `http://127.0.0.1:${await freePort()}` : apiOrigin;
  // The server refuses unknown NULLBIN_* variables, so pass only its own.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('NULLBIN_')) env[k] = v;
  env['NULLBIN_LISTEN_ADDR'] = `127.0.0.1:${port}`;
  env['NULLBIN_DATA_DIR'] = path.join(tmp, 'data');
  if (split) {
    env['NULLBIN_API_ONLY'] = 'true';
    env['NULLBIN_FRONTEND_ORIGIN'] = origin;
    execFileSync(process.execPath, ['web/build.mjs', '--frontend-only'], { cwd: root, env: { ...process.env, NULLBIN_API_ORIGIN: apiOrigin }, stdio: 'inherit' });
    const directory = path.join(root, 'web', 'dist');
    const manifest = JSON.parse(await readFile(path.join(directory, 'version.json'), 'utf8')) as { js: string; css: string };
    const files = new Map<string, { bytes: Buffer; type: string }>();
    for (const [name, type] of [['/index.html', 'text/html; charset=utf-8'], [manifest.js, 'text/javascript'], [manifest.css, 'text/css'], ['/version.json', 'application/json']] as const) {
      files.set(name, { bytes: await readFile(path.join(directory, name)), type });
    }
    frontend = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', origin).pathname;
      const name = pathname === '/' || /^\/(p|d)\/[0-9a-f]{32}$/.test(pathname) ? '/index.html' : pathname;
      const file = files.get(name);
      for (const [k, v] of Object.entries(frontendHeaders(apiOrigin))) res.setHeader(k, v);
      res.setHeader('Cache-Control', name.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store');
      if (!file) { res.writeHead(404); res.end('Not found'); return; }
      res.setHeader('Content-Type', file.type); res.setHeader('Content-Length', file.bytes.length);
      res.end(req.method === 'HEAD' ? undefined : file.bytes);
    });
    await new Promise<void>((resolve) => frontend!.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  }
  restartAPI = async () => {
    if (server && server.exitCode === null) {
      const exited = new Promise<void>((resolve) => server!.once('exit', () => resolve()));
      server.kill();
      await exited;
    }
    server = spawn(bin, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout?.on('data', (d) => (serverLog += String(d)));
    server.stderr?.on('data', (d) => (serverLog += String(d)));
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${apiOrigin}/api/v1/version`)).ok) break;
      } catch {
        // not up yet
      }
      if (i > 100) throw new Error(`server did not start:\n${serverLog}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  await restartAPI();

  const executablePath = process.env['CHROME_PATH'];
  browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
});

after(async () => {
  await browser?.close();
  server?.kill();
  if (frontend) await new Promise<void>((resolve) => frontend!.close(() => resolve()));
  if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

interface Harness {
  context: BrowserContext;
  page: Page;
  apiCalls: string[];
  /** Every request to the paste API, with headers and body. */
  sent: Sent[];
  /** Asserts no CSP violations, external requests or console problems so far. */
  check: (allow?: RegExp) => Promise<void>;
}

async function open(options: { colorScheme?: 'light' | 'dark'; noFileSystemAccess?: boolean; hasTouch?: boolean } = {}): Promise<Harness> {
  const context = await browser.newContext({ acceptDownloads: true, colorScheme: options.colorScheme ?? 'light', hasTouch: options.hasTouch ?? false });
  const page = await context.newPage();
  const problems: string[] = [];
  const apiCalls: string[] = [];
  const sent: Sent[] = [];

  // Runs before any page script in every document (injected by the
  // browser, so the page's CSP does not apply to it).
  await page.addInitScript((noFsa: boolean) => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI}`);
    });
    if (noFsa) Object.defineProperty(window, 'showSaveFilePicker', { value: undefined });
  }, options.noFileSystemAccess ?? false);

  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return;
    if (u.origin !== origin && !(split && u.origin === apiOrigin && u.pathname.startsWith('/api/v1/'))) problems.push(`request to another origin: ${req.url()}`);
    if (u.pathname.startsWith('/api/v1/pastes') && req.method() !== 'OPTIONS') {
      apiCalls.push(`${req.method()} ${u.pathname}`);
      sent.push({ method: req.method(), path: u.pathname, headers: req.headers(), body: req.postDataBuffer() });
    }
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    // Chrome warns about Permissions-Policy features it does not implement
    // on this platform (for example web-share on Linux). Denying them is
    // still correct where they exist, so these warnings are expected.
    if (/^Error with Permissions-Policy header: Unrecognized feature: '[a-z-]+'\.$/.test(msg.text())) return;
    problems.push(`console ${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));

  const check = async (allow?: RegExp) => {
    const csp = (await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)) ?? [];
    const remaining = problems.filter((p) => !(allow && allow.test(p)));
    assert.deepEqual([...csp.map((c) => `CSP violation: ${c}`), ...remaining], []);
  };
  return { context, page, apiCalls, sent, check };
}

async function goto(h: Harness, url: string) {
  const resp = await h.page.goto(url);
  assert.ok(resp, `no response for ${url}`);
  const headers = resp.headers();
  assert.equal(headers['content-security-policy'], split ? EXPECTED_CSP.replace("connect-src 'self';", `connect-src 'self' ${apiOrigin};`) : EXPECTED_CSP, 'page is served with the real CSP');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  // The module script (and so libsodium) has loaded once the page leaves the loading state.
  await h.page.waitForSelector('#loading', { state: 'hidden' });
}

interface CreateOptions {
  text?: string;
  password?: string;
  burn?: boolean;
  maxReads?: number;
  discussion?: boolean;
  expiry?: string;
  file?: { name: string; mimeType: string; buffer: Buffer };
  files?: { name: string; mimeType: string; buffer: Buffer }[];
}

async function createPaste(o: CreateOptions): Promise<{ share: string; del: string }> {
  const h = await open();
  await goto(h, `${origin}/`);
  if (o.text !== undefined) await h.page.fill('#text', o.text);
  if (o.file) await h.page.setInputFiles('#file', o.file);
  if (o.files) await h.page.setInputFiles('#file', o.files);
  if (o.burn) await h.page.check('#burn');
  if (o.maxReads !== undefined) await h.page.fill('#burn-reads', String(o.maxReads));
  if (o.discussion) await h.page.check('#discussion');
  if (o.password) {
    if (!o.discussion) await h.page.check('#password-switch');
    await h.page.fill('#password', o.password);
  }
  if (o.expiry) await h.page.selectOption('#expiry', o.expiry);
  await h.page.click('#create-submit');
  await h.page.waitForSelector('#result', { state: 'visible', timeout: 60_000 });
  const share = `${await h.page.textContent('#share-server')}${await h.page.textContent('#share-key')}`;
  const del = await h.page.inputValue('#delete-link');
  if (o.burn) {
    const reads = o.maxReads ?? 1;
    assert.match(await h.page.textContent('#result-chips') ?? '', new RegExp(`Burn after ${reads} ${reads === 1 ? 'open' : 'opens'}`));
    const request = h.sent.find((entry) => entry.method === 'POST' && entry.path === '/api/v1/pastes');
    const body = JSON.parse(request!.body!.toString('utf8')) as { max_reads?: number };
    assert.equal(body.max_reads ?? 1, reads, 'the requested open limit reaches the API');
  }
  assert.equal(new URL(share).origin, origin);
  assert.equal(new URL(del).origin, origin);
  assert.equal(await h.page.inputValue('#text'), '', 'plaintext cleared from the form');
  assert.equal(await h.page.inputValue('#password'), '', 'password cleared from the form');
  // The upload never carries the plaintext.
  for (const s of h.sent) {
    if (s.body && o.text) assert.ok(!s.body.toString('latin1').includes(o.text), `${s.method} ${s.path} carries plaintext`);
  }
  await h.check();
  await h.context.close();
  return { share, del };
}

/** The text shown in the viewer, line by line (line numbers excluded). */
async function viewerText(page: Page): Promise<string> {
  return page.evaluate(() => [...document.querySelectorAll('#view-text .nb-lc')].map((e) => e.textContent).join('\n'));
}

async function unlock(page: Page, password: string) {
  await page.waitForSelector('#gate-password', { state: 'visible' });
  await page.fill('#view-password', password);
  await page.press('#view-password', 'Enter');
}

const ID = '[0-9a-f]{32}';
const KEY = '[A-Za-z0-9_-]{43}';

test('negative control: the harness detects CSP violations', async () => {
  const h = await open();
  await goto(h, `${origin}/`);
  await h.page.evaluate(() => {
    const s = document.createElement('script');
    try {
      s.textContent = 'window.__ran = 1';
    } catch {
      // Trusted Types refuse the script text itself; that is reported too.
    }
    document.body.append(s);
  });
  await h.page.waitForFunction(() => (window as unknown as { __csp: string[] }).__csp.length > 0);
  const ran = await h.page.evaluate(() => (window as unknown as { __ran?: number }).__ran);
  assert.equal(ran, undefined, 'inline script must not run');
  await assert.rejects(h.check(), 'check() must report the violation');
  await h.context.close();
});

test('the browser itself blocks HTML injection and isolates the page', async () => {
  const h = await open();
  await goto(h, `${origin}/`);
  await h.page.waitForSelector('#create', { state: 'visible' });
  // Trusted Types: assigning a string to an HTML sink throws.
  const blocked = await h.page.evaluate(() => {
    try {
      document.createElement('div').innerHTML = '<img src=x>';
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(blocked, true, 'innerHTML must be refused by Trusted Types');
  assert.equal(await h.page.evaluate(() => crossOriginIsolated), true, 'COOP + COEP isolate the page');
  await h.context.close();
});

test('every page loads under the CSP with no external requests', async () => {
  const id = '0123456789abcdef0123456789abcdef';
  const pages: [string, string, RegExp | null][] = [
    [`${origin}/`, '#create', null],
    [`${origin}/p/${id}`, '#problem', /incomplete/],
    [`${origin}/d/${id}`, '#problem', /incomplete/],
    [`${origin}/d/${id}#${'A'.repeat(43)}`, '#problem', /older version/],
    [`${origin}/d/${id}#d.${'A'.repeat(43)}`, '#delete', null],
  ];
  for (const [url, visible, problem] of pages) {
    for (const colorScheme of ['light', 'dark'] as const) {
      const h = await open({ colorScheme });
      await goto(h, url);
      await h.page.waitForSelector(visible, { state: 'visible' });
      assert.equal(await h.page.getAttribute('html', 'data-bs-theme'), colorScheme, 'theme follows prefers-color-scheme');
      if (problem) assert.match((await h.page.textContent('#problem-title')) ?? '', problem);
      await h.check();
      await h.context.close();
    }
  }
});

test('the footer Version link reaches the API and reports its version', async () => {
  const h = await open();
  await goto(h, `${origin}/`);
  const report = await h.page.getAttribute('.nb-foot-link[href^="mailto:"]', 'href');
  assert.equal(report, 'mailto:hi@jacobzymet.com?subject=Nullbin%20vulnerability%20report');
  const href = await h.page.getAttribute('.nb-foot-link[href$="/api/v1/version"]', 'href');
  assert.ok(href);
  // The footer names the version in plain words, such as "Nullbin v1.2.3".
  assert.match((await h.page.textContent('.nb-foot-link[href$="/api/v1/version"]')) ?? '', /^Nullbin [0-9A-Za-z][0-9A-Za-z.+_-]*$/);
  const url = new URL(href, `${origin}/`);
  assert.equal(url.origin, apiOrigin, 'the link must point at the API, wherever it is hosted');
  const resp = await fetch(url);
  assert.equal(resp.status, 200);
  const body = (await resp.json()) as Record<string, unknown>;
  assert.equal(typeof body['version'], 'string');
  if (split) assert.equal(body['mode'], 'api');
  await h.check();
  await h.context.close();
});

test('text paste: encrypt, share, decrypt; HTML in the paste stays text', async () => {
  const text = 'Grüße 🔐\n<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>\n\ttabs   and spaces';
  const { share, del } = await createPaste({ text, expiry: '300' });
  assert.match(share, new RegExp(`^${origin}/p/${ID}#${KEY}$`));
  assert.match(del, new RegExp(`^${origin}/d/${ID}#d\\.${KEY}$`));

  const h = await open();
  await goto(h, share);
  await h.page.waitForSelector('#view-text-card', { state: 'visible' });
  assert.equal(await viewerText(h.page), text);
  assert.equal(await h.page.locator('#view-text img, #view-text script').count(), 0, 'no elements created from paste content');
  assert.equal(await h.page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), undefined);
  assert.ok(!h.page.url().includes('#'), 'fragment removed from the address bar');
  assert.deepEqual(h.apiCalls, [`GET ${new URL(share).pathname.replace('/p/', '/api/v1/pastes/')}`]);
  assert.deepEqual(await h.page.locator('.nb-paste-actions > .btn span').allTextContents(), ['New', 'Clone', 'Raw text', 'Save document', 'Email', 'QR code']);
  const mail = new URL((await h.page.getAttribute('#view-email', 'href'))!);
  assert.ok(mail.searchParams.get('body')!.includes(share));
  assert.ok(!mail.searchParams.get('body')!.includes(text));
  await h.page.click('#view-qr');
  assert.equal(await h.page.textContent('#qr-link'), share, 'QR keeps the key removed from the address bar');
  assert.equal(await h.page.locator('#qr-image svg').count(), 1);
  await h.page.keyboard.press('Escape');
  await h.page.waitForSelector('#qr-image svg', { state: 'detached' });
  assert.equal(await h.page.locator('#qr-image svg').count(), 0, 'closing removes the secret QR content');
  assert.ok(await h.page.locator('#view-qr').evaluate((button) => button === document.activeElement));
  const [raw] = await Promise.all([h.page.waitForEvent('popup'), h.page.click('#view-raw')]);
  await raw.waitForLoadState('domcontentloaded');
  assert.ok(raw.url().startsWith('blob:'));
  assert.equal(await raw.locator('body').textContent(), text);
  assert.equal(await raw.locator('script, img').count(), 0, 'raw content stays inert');
  assert.equal(await raw.evaluate(() => window.opener), null);
  await raw.close();
  const [saved] = await Promise.all([h.page.waitForEvent('download'), h.page.click('#text-download')]);
  assert.equal(await readFile(await saved.path(), 'utf8'), text);
  await h.page.click('#wrap-toggle');
  assert.equal(await h.page.getAttribute('#wrap-toggle', 'aria-pressed'), 'false');
  await h.page.click('#view-clone');
  await h.page.waitForSelector('#create:not([hidden])');
  assert.equal(new URL(h.page.url()).pathname, '/');
  assert.equal(await h.page.inputValue('#text'), text);
  assert.equal(await h.page.isChecked('#password-switch'), false);
  assert.equal(await h.page.isChecked('#burn'), false);
  assert.equal(await h.page.isChecked('#discussion'), false);
  assert.equal(h.apiCalls.length, 1, 'cloning makes a draft without fetching or publishing');
  await h.page.fill('#text', 'Edited clone');
  await h.page.click('#create-submit');
  await h.page.waitForSelector('#result:not([hidden])');
  const clonedShare = `${await h.page.textContent('#share-server')}${await h.page.textContent('#share-key')}`;
  assert.notEqual(clonedShare, share, 'publishing the clone creates a new ID and key');
  const resultMail = new URL((await h.page.getAttribute('#result-email', 'href'))!);
  assert.ok(resultMail.searchParams.get('body')!.includes(clonedShare));
  await h.page.click('#result-qr');
  assert.equal(await h.page.textContent('#qr-link'), clonedShare);
  await h.page.click('#qr-close');
  await h.check();
  await h.context.close();
});

test('decrypted text reveals once, stays usable during motion, and respects reduced motion', async () => {
  const text = 'Read immediately.\nGrüße 🔐 — 中文';
  const { share } = await createPaste({ text });
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    const h = await open();
    await h.page.emulateMedia({ reducedMotion });
    await goto(h, share);
    await h.page.waitForSelector('#view-text-card:not([hidden])');
    assert.equal(await viewerText(h.page), text, 'the real text is available throughout the animation');
    assert.ok(await h.page.isEnabled('#text-copy'));
    assert.ok(await h.page.isEnabled('#text-download'));
    assert.equal(await h.page.locator('#view-text').evaluate((box) => getComputedStyle(box).animationName), reducedMotion === 'reduce' ? 'none' : 'nb-decode');
    await h.page.locator('#view-text').evaluate(async (box) => {
      await Promise.all(box.getAnimations().map((animation) => animation.finished));
    });
    const settled = await h.page.locator('#view-text').evaluate((box) => {
      const style = getComputedStyle(box);
      return { filter: style.filter, opacity: style.opacity, clip: style.clipPath };
    });
    assert.deepEqual(settled, { filter: 'none', opacity: '1', clip: 'none' });
    await h.page.click('#wrap-toggle');
    assert.equal(await h.page.locator('#view-text').evaluate((box) => box.getAnimations().length), 0, 'changing text wrapping does not replay the reveal');
    await h.check();
    await h.context.close();
  }
});

test('hostile file names stay inert text, and the file limit holds', async () => {
  const h = await open();
  await goto(h, `${origin}/`);
  const hostile = [
    '<img src=x onerror="document.title=\'pwned\'">.txt',
    '"><svg onload=alert(1)>.png',
    "'); alert(1); ('.js",
    'invoice\u202Efdp.exe',
    '{{constructor.constructor("alert(1)")()}}',
  ];
  await h.page.setInputFiles('#file', hostile.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from('x') })));
  const shown = await h.page.locator('#file-list .nb-file-chip-name').allTextContents();
  assert.deepEqual(shown, hostile, 'names are shown exactly as text');
  assert.equal(await h.page.locator('#file-list img, #file-list svg:not(.nb-i), #file-list script').count(), 0, 'no element was injected');
  assert.equal(await h.page.locator('#file-list .nb-chip-x').first().getAttribute('aria-label'), `Remove ${hostile[0]}`);
  assert.notEqual(await h.page.title(), 'pwned');
  // Up to the limit, then refused as a whole.
  await h.page.setInputFiles('#file', Array.from({ length: 95 }, (_, i) => ({ name: `f${i}`, mimeType: 'text/plain', buffer: Buffer.from('') })));
  assert.equal(await h.page.locator('#file-list li').count(), 100);
  await h.page.setInputFiles('#file', { name: 'one-too-many', mimeType: 'text/plain', buffer: Buffer.from('') });
  assert.equal(await h.page.locator('#file-list li').count(), 100, 'the 101st file is refused');
  assert.match((await h.page.textContent('#error-banner')) ?? '', /up to 100 files/);
  await h.check();
  await h.context.close();
});

test('several files travel as one verified zip with clean names', async () => {
  const big = Buffer.alloc(200_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 13 + 5) & 0xff;
  const files = [
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    { name: 'data.bin', mimeType: 'application/octet-stream', buffer: big },
    { name: String.raw`..\..\evil.sh`, mimeType: 'text/plain', buffer: Buffer.from('#!/bin/sh') },
  ];
  const { share } = await createPaste({ text: 'three files', files });

  const h = await open({ noFileSystemAccess: true });
  await goto(h, share);
  await h.page.waitForSelector('#view-file-card', { state: 'visible', timeout: 60_000 });
  assert.equal(await h.page.textContent('#view-filename'), '3 files.zip');
  assert.equal(await h.page.textContent('#view-mime'), 'application/zip');
  const [download] = await Promise.all([h.page.waitForEvent('download'), h.page.click('#save-file')]);
  assert.equal(download.suggestedFilename(), '3 files.zip');
  const zip = await readFile(await download.path());
  // Read the central directory independently of the code that wrote it.
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  const entries: { name: string; data: Buffer }[] = [];
  for (let i = 0, p = zip.readUInt32LE(eocd + 16); i < zip.readUInt16LE(eocd + 10); i++) {
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + zip.readUInt16LE(local + 26);
    entries.push({ name, data: zip.subarray(start, start + size) });
    p += 46 + nameLen;
  }
  assert.deepEqual(entries.map((e) => e.name), ['notes.txt', 'data.bin', '_.._evil.sh']);
  for (const [i, e] of entries.entries()) assert.ok(e.data.equals(files[i]!.buffer), `${e.name} matches`);
  await h.check();
  await h.context.close();
});

test('password + file paste: wrong password, retry, verified download', async () => {
  const content = Buffer.alloc(300_000);
  for (let i = 0; i < content.length; i++) content[i] = (i * 31 + 7) & 0xff;
  const { share } = await createPaste({
    text: 'see attachment',
    password: 'hunter2 correct',
    file: { name: 'report.pdf', mimeType: 'application/pdf', buffer: content },
  });

  const h = await open({ noFileSystemAccess: true });
  await goto(h, share);
  await unlock(h.page, 'wrong password');
  await h.page.waitForSelector('#view-password.is-invalid', { timeout: 60_000 });
  await h.page.fill('#view-password', 'hunter2 correct');
  await h.page.click('#gate-password button[type=submit]');
  await h.page.waitForSelector('#view-file-card', { state: 'visible', timeout: 60_000 });
  assert.equal(await viewerText(h.page), 'see attachment');
  assert.equal(await h.page.textContent('#view-filename'), 'report.pdf');
  assert.equal(await h.page.textContent('#view-mime'), 'application/pdf');
  assert.equal(h.apiCalls.length, 1, 'a wrong password does not download the paste again');

  const [download] = await Promise.all([h.page.waitForEvent('download'), h.page.click('#save-file')]);
  assert.equal(download.suggestedFilename(), 'report.pdf');
  const saved = await readFile(await download.path());
  assert.ok(saved.equals(content), 'downloaded file matches the original');
  await h.page.waitForSelector('#file-saved', { state: 'visible' });
  await h.page.click('#view-clone');
  await h.page.waitForSelector('#create:not([hidden])');
  assert.equal(await h.page.inputValue('#text'), 'see attachment');
  assert.equal(await h.page.textContent('#file-list .nb-file-chip-name'), 'report.pdf');
  assert.equal(await h.page.isChecked('#password-switch'), false, 'clones do not reuse the original password');
  await h.page.fill('#text', '');
  await h.page.click('#create-submit');
  await h.page.waitForSelector('#result:not([hidden])');
  const clone = `${await h.page.textContent('#share-server')}${await h.page.textContent('#share-key')}`;
  await goto(h, clone);
  await h.page.waitForSelector('#view-file-card:not([hidden])');
  assert.ok(await h.page.isDisabled('#view-raw'), 'file-only pastes have no raw text');
  assert.ok(await h.page.isDisabled('#text-download'), 'file-only pastes use Save file');
  const [clonedDownload] = await Promise.all([h.page.waitForEvent('download'), h.page.click('#save-file')]);
  assert.deepEqual(await readFile(await clonedDownload.path()), content);
  await h.check();
  await h.context.close();
});

test('burn after reading: warning before fetching, then gone', async () => {
  const { share } = await createPaste({ text: 'read me once', burn: true });
  assert.match(share, new RegExp(`#${KEY}\\.b$`));

  const h = await open();
  await goto(h, share);
  await h.page.waitForSelector('#gate-burn', { state: 'visible' });
  assert.deepEqual(h.apiCalls, [], 'nothing is fetched before the reader confirms');
  await h.page.click('#burn-open');
  await h.page.waitForSelector('#view-text-card', { state: 'visible' });
  assert.equal(await viewerText(h.page), 'read me once');
  assert.equal(await h.page.getAttribute('#view-email', 'href'), null, 'exhausted links cannot be emailed');
  assert.ok(await h.page.isDisabled('#view-qr'));
  assert.ok(await h.page.isVisible('#burned-note'), 'the reader is told the paste is gone');
  await h.check();
  await h.context.close();

  const again = await open();
  await goto(again, share);
  await again.page.click('#burn-open');
  await again.page.waitForSelector('#problem', { state: 'visible' });
  assert.match((await again.page.textContent('#problem-title')) ?? '', /doesn’t exist/);
  await again.check(/status of 404/);
  await again.context.close();
});

test('custom burn limit allows three password-authorized opens and then deletes the paste', async (t) => {
  // Isolate this extra read-heavy scenario's budget; production rate limits
  // stay enabled, and the original tests keep their own request budget.
  await restartAPI();
  t.after(() => restartAPI());
  const { share } = await createPaste({ text: 'three authorized opens', burn: true, maxReads: 3, password: 'custom burn password' });
  for (const remaining of [2, 1, 0]) {
    const h = await open();
    await goto(h, share);
    await h.page.waitForSelector('#gate-burn:not([hidden])');
    assert.deepEqual(h.apiCalls, [], 'viewing the confirmation does not use an open');
    await h.page.click('#burn-open');
    if (remaining === 2) {
      await unlock(h.page, 'incorrect password');
      await h.page.waitForSelector('#view-password.is-invalid', { timeout: 60_000 });
      await h.page.fill('#view-password', 'custom burn password');
      await h.page.click('#gate-password button[type=submit]');
    } else {
      await unlock(h.page, 'custom burn password');
    }
    await h.page.waitForSelector('#view-text-card:not([hidden])', { timeout: 60_000 });
    assert.equal(await viewerText(h.page), 'three authorized opens');
    assert.equal(await h.page.isVisible('#burned-note'), remaining === 0, 'deletion is announced only after the final open');
    assert.match(await h.page.textContent('#view-chips') ?? '', remaining === 0 ? /Burned/ : new RegExp(`${remaining} opens? left`));
    await h.check(remaining === 2 ? /status of 404/ : undefined);
    await h.context.close();
  }
  const gone = await open();
  await goto(gone, share);
  await gone.page.click('#burn-open');
  await gone.page.waitForSelector('#problem:not([hidden])');
  await gone.check(/status of 404/);
  await gone.context.close();
});

test('delete link removes the paste', async () => {
  const { share, del } = await createPaste({ text: 'delete me' });
  const h = await open();
  await goto(h, del);
  assert.ok(await h.page.isVisible('#delete-ask a[href="/"]'), 'deletion has a cancel action');
  const endpoint = `${apiOrigin}/api/v1/pastes/${new URL(del).pathname.split('/').pop()}`;
  await h.page.route(endpoint, (route) => route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origin }, body: '{"error":"temporarily unavailable"}' }));
  await h.page.click('#delete-confirm');
  await h.page.waitForSelector('#delete-error:not([hidden])');
  assert.ok(await h.page.isEnabled('#delete-confirm'));
  assert.equal(await h.page.textContent('#delete-confirm span'), 'Delete paste');
  await h.page.unroute(endpoint);
  await h.page.click('#delete-confirm');
  await h.page.waitForSelector('#delete-done', { state: 'visible' });
  assert.ok(!h.page.url().includes('#'), 'token removed from the address bar');
  await h.check(/status of 503/);
  await h.context.close();

  const v = await open();
  await goto(v, share);
  await v.page.waitForSelector('#problem', { state: 'visible' });
  assert.match((await v.page.textContent('#problem-title')) ?? '', /doesn’t exist/);
  await v.check(/status of 404/);
  await v.context.close();
});

test('create form: a discussion requires a password and rules out burning', async () => {
  const h = await open();
  await goto(h, `${origin}/`);
  await h.page.check('#password-switch');
  assert.ok(await h.page.isEnabled('#discussion'), 'a password is compatible with discussion');
  assert.ok(await h.page.isEnabled('#burn'), 'a password is compatible with burn after reading');
  assert.equal(await h.page.locator('.nb-option-notes, .nb-option-note').count(), 0, 'settings do not add inline notices');
  await h.page.uncheck('#password-switch');
  await h.page.check('#discussion');
  assert.ok(await h.page.isChecked('#password-switch'), 'password switched on');
  assert.ok(await h.page.isDisabled('#password-switch'), 'password cannot be switched off');
  assert.ok(await h.page.isDisabled('#burn'), 'burn after reading unavailable');
  assert.equal(await h.page.locator('label:has(#burn)').getAttribute('title'), 'Turn off Discussion to enable burn after reading.');
  assert.equal(await h.page.locator('label:has(#password-switch)').getAttribute('title'), 'A password is required while Discussion is enabled.');
  assert.equal(await h.page.textContent('#burn-help'), 'Turn off Discussion to enable burn after reading.');
  await h.page.fill('#text', 'x');
  await h.page.fill('#password', 'short');
  await h.page.click('#create-submit');
  await h.page.waitForSelector('#password.is-invalid');
  assert.equal(await h.page.getAttribute('#password', 'aria-invalid'), 'true');
  assert.deepEqual(h.apiCalls, [], 'nothing is uploaded with a too-short password');
  await h.page.uncheck('#discussion');
  assert.ok(await h.page.isEnabled('#password-switch'));
  await h.page.check('#burn');
  assert.ok(await h.page.isDisabled('#discussion'), 'no discussion on a burn paste');
  assert.ok(await h.page.isVisible('#burn-reads'));
  assert.equal(await h.page.inputValue('#burn-reads'), '1');
  assert.equal(await h.page.textContent('#burn-label'), 'Burn after');
  assert.equal(await h.page.textContent('#burn-reads-unit'), 'open');
  await h.page.fill('#password', 'valid password');
  for (const invalid of ['', '0', '1.5', '1001']) {
    await h.page.fill('#burn-reads', invalid);
    await h.page.click('#create-submit');
    assert.deepEqual(h.apiCalls, [], 'invalid open limits are not uploaded');
  }
  await h.page.fill('#burn-reads', '3');
  assert.equal(await h.page.textContent('#burn-reads-unit'), 'opens');
  assert.equal(await h.page.locator('label:has(#discussion)').getAttribute('title'), 'Disable burning to enable a discussion.');
  await h.page.uncheck('#burn');
  assert.ok(await h.page.isHidden('#burn-reads'));
  assert.ok(await h.page.isDisabled('#burn-reads'));
  assert.ok(await h.page.isEnabled('#discussion'));
  assert.equal(await h.page.locator('label:has(#discussion)').getAttribute('title'), 'Allow encrypted comments. Requires a password.');
  await h.check();
  await h.context.close();
});

test('discussion: encrypted comments and replies, readable only with the password', async () => {
  const { share } = await createPaste({ text: 'Review this, please.', discussion: true, password: 'team password 1' });

  const a = await open();
  await goto(a, share);
  await unlock(a.page, 'team password 1');
  await a.page.waitForSelector('#comments', { state: 'visible', timeout: 60_000 });
  await a.page.waitForSelector('#comments-empty', { state: 'visible' });
  await a.page.click('#comment-submit');
  await a.page.waitForSelector('#comment-error:not([hidden])');
  assert.equal(await a.page.getAttribute('#comment-text', 'aria-invalid'), 'true');
  await a.page.fill('#comment-name', 'Ada');
  await a.page.fill('#comment-text', 'First comment: looks right.');
  assert.equal(await a.page.getAttribute('#comment-text', 'aria-invalid'), 'false');
  assert.ok(await a.page.isHidden('#comment-error'));
  await a.page.click('#comment-submit');
  await a.page.waitForSelector('#comment-list > .nb-comment');
  await a.page.click('#comment-list > .nb-comment .nb-link-btn');
  assert.match((await a.page.textContent('#reply-name')) ?? '', /Ada/);
  await a.page.fill('#comment-text', 'A reply <b>not bold</b>.');
  await a.page.click('#comment-submit');
  await a.page.waitForSelector('.nb-replies .nb-comment');

  // What went over the wire: a token header, never the comment text.
  const posts = a.sent.filter((s) => s.method === 'POST' && s.path.endsWith('/comments'));
  assert.equal(posts.length, 2);
  for (const p of posts) {
    assert.match(p.headers['nullbin-comment-token'] ?? '', new RegExp(`^${KEY}$`));
    const body = p.body?.toString('latin1') ?? '';
    assert.ok(!body.includes('First comment') && !body.includes('not bold') && !body.includes('Ada'), 'comment sent in plaintext');
  }
  const commentsEndpoint = `${apiOrigin}/api/v1/pastes/${new URL(share).pathname.split('/').pop()}/comments`;
  await a.page.route(commentsEndpoint, (route) => route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origin }, body: '{"error":"temporarily unavailable"}' }));
  await a.page.click('#comments-refresh');
  await a.page.waitForSelector('#comments-error:not([hidden])');
  assert.equal(await a.page.textContent('#comment-count'), '2', 'failed refresh preserves the thread');
  await a.page.fill('#comment-text', 'Keep my comment draft');
  await a.page.click('#comment-submit');
  await a.page.waitForSelector('#comment-error:not([hidden])');
  assert.equal(await a.page.inputValue('#comment-text'), 'Keep my comment draft');
  assert.equal(await a.page.inputValue('#comment-name'), 'Ada');
  assert.ok(await a.page.isEnabled('#comment-submit'));
  assert.equal(await a.page.textContent('#comment-submit span'), 'Post comment');
  await a.page.unroute(commentsEndpoint);
  await a.page.click('#comments-refresh');
  await a.page.waitForSelector('#comments-error', { state: 'hidden' });
  assert.ok(await a.page.isHidden('#comments-empty'));
  await a.check(/status of 503/);
  await a.context.close();

  // Another reader sees the thread, rendered as text.
  const b = await open({ colorScheme: 'dark' });
  await goto(b, share);
  await unlock(b.page, 'team password 1');
  await b.page.waitForSelector('.nb-replies .nb-comment', { timeout: 60_000 });
  assert.equal(await b.page.textContent('#comment-list > .nb-comment .nb-comment-name'), 'Ada');
  assert.equal(await b.page.textContent('.nb-replies .nb-comment-text'), 'A reply <b>not bold</b>.');
  assert.equal(await b.page.locator('#comment-list b').count(), 0, 'comment HTML is not interpreted');
  assert.equal(await b.page.textContent('#comment-count'), '2');
  await b.check();
  await b.context.close();
});

test('theme toggle and copy buttons work under the CSP', async () => {
  const h = await open({ colorScheme: 'light' });
  await h.context.grantPermissions(['clipboard-write'], { origin });
  // Clipboard reads are deliberately blocked by Permissions-Policy. Observe
  // successful real writes without weakening that policy for this test.
  await h.page.addInitScript(() => {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    Object.defineProperty(navigator.clipboard, 'writeText', { value: async (text: string) => {
      await write(text);
      (window as Window & { __copiedText?: string }).__copiedText = text;
    } });
  });
  await goto(h, `${origin}/`);
  await h.page.click('#theme-toggle');
  assert.equal(await h.page.getAttribute('html', 'data-bs-theme'), 'dark');
  assert.equal(await h.page.getAttribute('#theme-toggle', 'aria-pressed'), 'true');
  await h.page.fill('#text', 'copy test');
  await h.page.keyboard.press('Control+Enter');
  await h.page.waitForSelector('#result', { state: 'visible' });
  await h.page.waitForSelector('#result-copy-status.nb-tone-ok:not([hidden])');
  assert.equal(await h.page.textContent('#result-copy-status'), 'Share link automatically copied to clipboard.');
  const share = `${await h.page.textContent('#share-server')}${await h.page.textContent('#share-key')}`;
  assert.equal(await h.page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText), share);
  await h.page.waitForFunction(() => document.querySelector('#copy-share span')?.textContent === 'Copy link');
  await h.page.click('#copy-share');
  await h.page.waitForSelector('#toast.show');
  assert.equal(await h.page.textContent('#toast-text'), 'Link copied');
  assert.equal(await h.page.textContent('#copy-share span'), 'Copied');
  assert.equal(await h.page.getAttribute('#copy-share use', 'href'), '#i-check');
  assert.ok(await h.page.locator('#copy-share').evaluate((button) => button === document.activeElement));
  await h.page.click('.nb-details summary');
  await h.page.click('#copy-delete');
  await h.page.waitForSelector('#copy-delete.nb-copied');
  assert.equal(await h.page.textContent('#copy-delete span'), 'Copied');
  assert.equal(await h.page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText), await h.page.inputValue('#delete-link'));
  await goto(h, share);
  await h.page.waitForSelector('#view-text-card:not([hidden])');
  await h.page.click('#text-copy');
  await h.page.waitForSelector('#text-copy.nb-copied');
  assert.equal(await h.page.textContent('#text-copy span'), 'Copied');
  assert.equal(await h.page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText), 'copy test');
  // The theme choice survives a reload.
  await h.page.reload();
  await h.page.waitForSelector('#loading', { state: 'hidden' });
  assert.equal(await h.page.getAttribute('html', 'data-bs-theme'), 'dark');
  await h.check();
  await h.context.close();
});

test('clipboard denial preserves the created paste and offers manual copying', async () => {
  const h = await open();
  await h.page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async () => { throw new DOMException('Clipboard denied', 'NotAllowedError'); },
    } });
  });
  await goto(h, `${origin}/`);
  await h.page.fill('#text', 'clipboard fallback');
  await h.page.click('#create-submit');
  await h.page.waitForSelector('#result-copy-status:not([hidden])');
  assert.ok(!(await h.page.getAttribute('#result-copy-status', 'class'))?.includes('nb-tone-ok'));
  assert.equal(await h.page.inputValue('#text'), '');
  assert.equal(await h.page.textContent('#copy-share span'), 'Copy link');
  const share = `${await h.page.textContent('#share-server')}${await h.page.textContent('#share-key')}`;
  await h.page.click('#copy-share');
  await h.page.waitForSelector('#toast.nb-tone-warn.show');
  assert.equal(await h.page.evaluate(() => window.getSelection()?.toString()), share);
  assert.equal(await h.page.getAttribute('#toast use', 'href'), '#i-alert');
  assert.equal(await h.page.textContent('#copy-share span'), 'Copy link');
  await goto(h, share);
  await h.page.waitForSelector('#view-text-card:not([hidden])');
  assert.equal(await viewerText(h.page), 'clipboard fallback');
  await h.page.click('#text-copy');
  await h.page.waitForSelector('#toast.nb-tone-warn.show');
  assert.match(await h.page.textContent('#toast-text') ?? '', /Save document/);
  await h.check();
  await h.context.close();
});

test('creation shows progress, blocks repeat submits, and retains a draft after failure', async () => {
  const h = await open();
  await goto(h, `${origin}/`);
  await h.page.fill('#text', 'keep this draft');
  let posts = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await h.page.route(`${apiOrigin}/api/v1/pastes`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++;
    await pending;
    await route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origin }, body: '{"error":"temporarily unavailable"}' });
  });
  try {
    await h.page.click('#create-submit');
    await h.page.waitForSelector('#create-form[aria-busy="true"]');
    assert.equal(await h.page.textContent('#create-submit span'), 'Creating…');
    assert.ok(await h.page.isDisabled('#create-submit'));
    await h.page.evaluate(() => (document.getElementById('create-form') as HTMLFormElement).requestSubmit());
    assert.equal(await h.page.inputValue('#text'), 'keep this draft');
  } finally {
    release();
  }
  await h.page.waitForSelector('#error-banner:not([hidden])');
  assert.equal(posts, 1);
  assert.equal(await h.page.inputValue('#text'), 'keep this draft');
  assert.ok(await h.page.isEnabled('#create-submit'));
  assert.equal(await h.page.textContent('#create-submit span'), 'Create');
  assert.equal(await h.page.getAttribute('#create-form', 'aria-busy'), null);
  await h.check(/status of 503/);
  await h.context.close();
});


test('password-protected burn paste survives ID-only access and wrong passwords', async () => {
  const { share } = await createPaste({ text: 'protected once', burn: true, password: 'correct burn password' });
  const id = new URL(share).pathname.split('/').pop()!;
  const stolen = await fetch(`${apiOrigin}/api/v1/pastes/${id}`);
  assert.equal(stolen.status, 404);
  await stolen.body?.cancel();
  const h = await open();
  await goto(h, share);
  await h.page.click('#burn-open');
  await unlock(h.page, 'wrong password');
  await h.page.waitForSelector('#view-password.is-invalid', { timeout: 60_000 });
  await h.page.fill('#view-password', 'correct burn password');
  await h.page.click('#gate-password button[type=submit]');
  await h.page.waitForSelector('#view-text-card', { state: 'visible', timeout: 60_000 });
  assert.equal(await viewerText(h.page), 'protected once');
  const reads = h.sent.filter((r) => r.path.endsWith('/read'));
  assert.equal(reads.length, 2);
  assert.ok(reads.every((r) => r.method === 'POST' && /^[A-Za-z0-9_-]{43}$/.test(r.headers['nullbin-burn-token'] ?? '')));
  assert.notEqual(reads[0]!.headers['nullbin-burn-token'], reads[1]!.headers['nullbin-burn-token']);
  assert.ok(!JSON.stringify(h.sent).includes('correct burn password'));
  await h.check(/status of 404/);
  await h.context.close();
});


test('settings keep logical rows across viewport sizes, option states, and input methods', async () => {
  for (const hasTouch of [false, true]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      const h = await open({ colorScheme, hasTouch });
      await goto(h, `${origin}/`);
      for (const width of [320, 360, 390, 414, 479, 480, 600, 767, 768, 844, 1024, 1199, 1200, 1400, 1920]) {
        await h.page.setViewportSize({ width, height: 844 });
        const checkLayout = async (state: string) => {
          const layout = await h.page.evaluate(() => {
            const rect = (selector: string) => {
              const box = document.querySelector(selector)!.getBoundingClientRect();
              return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
            };
            const controls = [...document.querySelectorAll<HTMLElement>('.btn, input.form-control, select.form-select, .nb-check')]
              .filter((element) => element.getBoundingClientRect().height > 0)
              .map((element) => ({ id: element.id || element.textContent!.trim(), height: element.getBoundingClientRect().height, clipped: element.scrollWidth > element.clientWidth + 1 }));
            return {
              overflow: document.documentElement.scrollWidth > innerWidth,
              toolbar: rect('.nb-toolbar'), expiry: rect('#expiry'), burn: rect('.nb-burn-setting'),
              discussion: rect('label:has(#discussion)'), password: rect('label:has(#password-switch)'),
              passwordField: rect('#password-row'), attach: rect('#attach'), submit: rect('#create-submit'), controls,
            };
          });
          const label = `${width}px ${colorScheme} ${hasTouch ? 'touch' : 'mouse'}, ${state}`;
          assert.equal(layout.overflow, false, `${label}: page overflows`);
          for (const control of layout.controls) {
            assert.equal(control.clipped, false, `${label}: ${control.id} clips`);
            assert.equal(control.height, width < 768 || hasTouch ? 44 : 36, `${label}: ${control.id} height`);
          }
          if (width < 768) {
            assert.ok(layout.discussion.y >= layout.burn.bottom + 7, `${label}: discussion needs its own row`);
            assert.ok(layout.password.y >= layout.discussion.bottom + 7, `${label}: password needs its own row`);
            if (layout.passwordField.height) assert.ok(layout.passwordField.y >= layout.password.bottom + 7, `${label}: password field follows its checkbox`);
            assert.ok(layout.submit.y >= layout.attach.bottom + 11, `${label}: Create follows Attach`);
            for (const action of [layout.attach, layout.submit]) assert.ok(Math.abs(action.width - layout.toolbar.width) < 1, `${label}: standalone actions fill their row`);
          } else if (width < 1200) {
            assert.equal(layout.expiry.y, layout.burn.y, `${label}: first settings row aligns`);
            assert.equal(layout.discussion.y, layout.password.y, `${label}: second settings row aligns`);
            assert.equal(layout.attach.y, layout.submit.y, `${label}: action row aligns`);
          }
        };
        await checkLayout('default');
        await h.page.check('#burn');
        await h.page.fill('#burn-reads', '1000');
        await h.page.check('#password-switch');
        await checkLayout('burn limit and password');
        await h.page.uncheck('#burn');
        await h.page.check('#discussion');
        await checkLayout('discussion and required password');
        await h.page.uncheck('#discussion');
        await h.page.uncheck('#password-switch');
      }
      await h.check();
      await h.context.close();
    }
  }
});

test('paste controls stay reachable at phone and desktop widths in both themes', async () => {
  for (const width of [320, 390, 768, 1280, 1920]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      const h = await open({ colorScheme });
      await h.page.setViewportSize({ width, height: 844 });
      await goto(h, `${origin}/`);
      const checkWidth = async () => assert.ok(await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `horizontal overflow at ${width}px (${colorScheme})`);
      await checkWidth();
      assert.ok(await h.page.isVisible('#create-submit'));
      assert.ok(await h.page.isVisible('#expiry'));
      assert.ok(await h.page.isVisible('#attach'));
      const submit = await h.page.locator('#create-submit').boundingBox();
      const toolbar = await h.page.locator('.nb-toolbar').boundingBox();
      assert.ok(submit && toolbar && Math.abs(submit.x + submit.width - toolbar.x - toolbar.width) < 2, 'create action aligns to the right');
      if (width < 768) assert.ok(submit && toolbar && Math.abs(submit.width - toolbar.width) < 2, 'mobile create action fills its row');
      await h.page.waitForFunction(() => document.fonts.check('30px "Damion"', 'Nullbin') && [...document.fonts].some((font) => font.family === 'Damion' && font.status === 'loaded'));
      assert.equal(await h.page.locator('.nb-brand svg, .nb-brand-description').count(), 0);
      await h.page.check('#discussion');
      assert.ok(await h.page.isVisible('#password'));
      assert.ok(await h.page.isDisabled('#burn'));
      const heights = await h.page.locator('#create-submit, #expiry, #password, #password-reveal, #attach, #theme-toggle, .nb-check').evaluateAll((controls) => controls.map((control) => control.getBoundingClientRect().height));
      assert.ok(heights.every((height) => Math.abs(height - heights[0]!) < 1), `controls must share one height at ${width}px (${colorScheme})`);
      if (width < 768) assert.ok(heights[0]! >= 44, 'mobile controls retain touch-friendly sizing');
      await checkWidth();
      await h.page.selectOption('#expiry', '300');
      assert.equal(await h.page.inputValue('#expiry'), '300');
      await h.page.setInputFiles('#file', { name: `${'long-'.repeat(40)}file.txt`, mimeType: 'text/plain', buffer: Buffer.from('file') });
      assert.equal(await h.page.textContent('#attach-label'), 'Add files');
      await checkWidth();
      await h.page.click('#file-list .nb-chip-x');
      assert.equal(await h.page.textContent('#attach-label'), 'Attach files');
      await h.page.uncheck('#discussion');
      await h.page.uncheck('#password-switch');
      await h.page.fill('#text', 'Responsive action layout');
      await h.page.click('#create-submit');
      await h.page.waitForSelector('#result-copy-status:not([hidden])');
      await checkWidth();
      await h.page.click('.nb-details summary');
      const joined = await h.page.locator('#delete-link, #copy-delete').evaluateAll((controls) => controls.map((control) => control.getBoundingClientRect().height));
      assert.ok(joined.every((height) => Math.abs(height - heights[0]!) < 1), 'joined copy controls match the shared control height');
      const copy = await h.page.locator('#copy-share').boundingBox();
      const shareRow = await h.page.locator('.nb-share-row').boundingBox();
      const shareActions = await h.page.locator('.nb-share-actions').boundingBox();
      assert.ok(shareActions && shareRow && Math.abs(shareActions.x + shareActions.width - shareRow.x - shareRow.width) < 2, 'sharing actions align to the right');
      if (width < 768) {
        assert.ok(copy && shareRow && Math.abs(copy.width - shareRow.width) < 2, 'mobile share action fills its row');
        const email = await h.page.locator('#result-email').boundingBox();
        const qr = await h.page.locator('#result-qr').boundingBox();
        assert.ok(email && qr && copy && email.y > copy.y && email.y === qr.y && Math.abs(email.width - qr.width) < 1, 'mobile Email and QR share an equal-width row');
        const next = await h.page.locator('#result > .btn').boundingBox();
        const result = await h.page.locator('#result').boundingBox();
        assert.ok(next && result && Math.abs(next.width - result.width) < 2, 'mobile new-paste action fills its row');
      }
      await h.check();
      await h.context.close();
    }
  }
});

test('paste actions and QR dialog keep consistent rows across viewports and input methods', async () => {
  const { share } = await createPaste({ text: 'Reader toolbar layout' });
  for (const hasTouch of [false, true]) for (const colorScheme of ['light', 'dark'] as const) {
    const h = await open({ hasTouch, colorScheme });
    await goto(h, share);
    await h.page.waitForSelector('#view-content:not([hidden])');
    for (const width of [320, 360, 390, 414, 479, 480, 600, 767, 768, 844, 1024, 1199, 1200, 1400, 1920]) {
      await h.page.setViewportSize({ width, height: hasTouch && width === 844 ? 390 : 844 });
      const buttons = await h.page.locator('.nb-paste-actions > .btn').evaluateAll((items) => items.map((item) => {
        const rect = item.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, clipped: item.scrollWidth > item.clientWidth + 1 };
      }));
      const columns = width < 768 ? 2 : width < 1200 ? 3 : 6;
      for (let index = 0; index < buttons.length; index++) {
        const button = buttons[index]!;
        assert.equal(button.clipped, false, `${width}px: action ${index} clips`);
        assert.equal(button.height, width < 768 || hasTouch ? 44 : 36);
        if (index % columns) assert.equal(button.y, buttons[index - 1]!.y, `${width}px: incomplete action row`);
        if (width < 1200) assert.ok(Math.abs(button.width - buttons[0]!.width) < 1);
      }
      assert.ok(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await h.page.click('#view-qr');
      const dialog = await h.page.locator('#qr-dialog').boundingBox();
      assert.ok(dialog && dialog.x >= 0 && dialog.x + dialog.width <= width, `${width}px: QR fits the viewport`);
      assert.equal(await h.page.textContent('#qr-link'), share);
      await h.page.keyboard.press('Escape');
      await h.page.waitForSelector('#qr-dialog', { state: 'hidden' });
    }
    await h.check();
    await h.context.close();
  }
});

test('large text previews are bounded and downloads preserve the complete text', async () => {
  const text = 'line\n'.repeat(6000);
  // Seed attacker-controlled encrypted content directly. This regression
  // measures the recipient's renderer, independently of textarea input.
  const sodium = await loadSodium();
  const prepared = preparePaste(sodium, { text, file: null, filename: null, mime: null, password: '', discussion: false });
  const created = await fetch(`${apiOrigin}/api/v1/pastes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expires_in: 300, burn_after_reading: false, total_size: prepared.totalSize }),
  });
  assert.equal(created.status, 201);
  const { id, upload_token: token } = await created.json() as { id: string; upload_token: string };
  let n = 0;
  for await (const chunk of rechunk(prepared.chunks(), UPLOAD_CHUNK)) { // as the real page does
    const uploaded = await fetch(`${apiOrigin}/api/v1/pastes/${id}/chunks/${n++}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Nullbin-Upload-Token': token },
      body: chunk as Uint8Array<ArrayBuffer>,
    });
    assert.equal(uploaded.status, 204);
  }
  const finalized = await fetch(`${apiOrigin}/api/v1/pastes/${id}/finalize`, { method: 'POST', headers: { 'Nullbin-Upload-Token': token } });
  assert.equal(finalized.status, 200);
  const share = `${origin}/p/${id}#${encodeKeyFragment(sodium, prepared.fragmentKey, false)}`;
  sodium.memzero(prepared.fragmentKey);
  const h = await open();
  await goto(h, share);
  await h.page.waitForSelector('#view-text-card', { state: 'visible' });
  assert.equal(await h.page.locator('#view-text .nb-row').count(), 5000);
  assert.equal(await h.page.locator('#view-text-truncated').isVisible(), true);
  assert.match(await h.page.textContent('#view-text-meta') ?? '', /6[,.]?000 lines/);
  const saved = h.page.waitForEvent('download');
  await h.page.click('#text-download');
  const download = await saved;
  assert.equal(download.suggestedFilename(), 'paste.txt');
  const file = await download.path();
  assert.ok(file);
  assert.equal(await readFile(file, 'utf8'), text);
  await h.check();
  await h.context.close();
});
