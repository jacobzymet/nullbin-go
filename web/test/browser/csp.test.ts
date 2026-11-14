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
import { crc32, deflateSync } from 'node:zlib';
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

  // The whole context: requests from workers count too.
  context.on('request', (req) => {
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
    await h.page.check('#password-switch');
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
  const workerRefused = await h.page.evaluate(() => {
    const url = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }));
    try { new Worker(url); return false; } catch { return true; } finally { URL.revokeObjectURL(url); }
  });
  assert.equal(workerRefused, true, 'the page can start no workers: none are needed');
  assert.equal(await h.page.evaluate(() => crossOriginIsolated), true, 'COOP + COEP isolate the page');
  await h.context.close();
});

test('reloading an opened paste explains why the key is gone', async () => {
  const { share } = await createPaste({ text: 'reload me' });
  const h = await open();
  await goto(h, share);
  await h.page.waitForSelector('#view-content:not([hidden])', { timeout: 60_000 });
  assert.equal(new URL(h.page.url()).hash, '', 'the key left the address bar');
  await h.page.reload();
  await h.page.waitForSelector('#problem', { state: 'visible' });
  assert.match(await h.page.textContent('#problem-text') ?? '', /reloading the page or copying the address loses it\. Open the original link again/);
  await h.page.goto('about:blank');
  await goto(h, share.replace(/#.*/, '#damaged'));
  await h.page.waitForSelector('#problem', { state: 'visible' });
  assert.match(await h.page.textContent('#problem-text') ?? '', /after the #, and it’s damaged\. Ask the sender/);
  await h.check();
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
  const left = await h.page.evaluate(() => ({
    view: document.getElementById('view')!.textContent!,
    email: document.getElementById('view-email')!.getAttribute('href'),
  }));
  assert.ok(!left.view.includes(text), 'the opened text leaves the page when cloning');
  assert.equal(left.email, null, 'the secret link leaves the page when cloning');
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

/** A real, decodable PNG with a red pixel in its first row. */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(4 + body.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 4 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (1 + width * 4));
  raw.set([255, 0, 0, 255], 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Pastes into the focused element (or the page), as the browser would. */
async function pasteInto(page: Page, selector: string | null, files: { name: string; type: string; bytes: number[] }[], text = '') {
  return page.evaluate(({ selector, files, text }) => {
    const data = new DataTransfer();
    for (const f of files) data.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
    if (text) data.setData('text/plain', text);
    const target = selector ? document.querySelector(selector)! : document.body;
    if (target instanceof HTMLElement) target.focus();
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, { selector, files, text });
}

test('a pasted image becomes an attachment, and is shown only when the reader asks', async () => {
  const png = makePng(40, 30);
  const h = await open();
  await goto(h, `${origin}/`);
  await h.page.fill('#text', 'screenshot attached');
  const image = { name: 'image.png', type: 'image/png', bytes: [...png] };
  // Text on the clipboard pastes as text, and the password field never attaches.
  assert.equal(await pasteInto(h.page, '#text', [image], 'some text'), false);
  await h.page.check('#password-switch');
  assert.equal(await pasteInto(h.page, '#password', [image]), false);
  await h.page.uncheck('#password-switch');
  assert.equal(await h.page.locator('#file-list .nb-file-chip').count(), 0);
  assert.equal(await pasteInto(h.page, '#text', [image]), true);
  assert.equal(await pasteInto(h.page, null, [{ ...image, name: '' }]), true, 'pasting with nothing focused works too');
  assert.deepEqual(await h.page.locator('#file-list .nb-file-chip-name').allTextContents(), ['image.png', 'pasted-image.png']);
  await h.page.click('#file-list .nb-file-chip:nth-child(2) .nb-chip-x');
  await h.page.click('#create-submit');
  await h.page.waitForSelector('#result', { state: 'visible', timeout: 60_000 });
  const share = `${await h.page.textContent('#share-server')}${await h.page.textContent('#share-key')}`;
  await h.check();
  await h.context.close();

  const r = await open({ noFileSystemAccess: true });
  await goto(r, share);
  await r.page.waitForSelector('#view-file-card', { state: 'visible', timeout: 60_000 });
  const calls = r.apiCalls.length;
  assert.equal(await r.page.getAttribute('#image-show', 'aria-expanded'), 'false');
  assert.equal(await r.page.locator('#image-preview img').count(), 0, 'nothing is decoded before the reader asks');
  await r.page.click('#image-show');
  await r.page.waitForFunction(() => (document.querySelector('#image-preview img') as HTMLImageElement | null)?.complete);
  const shown = await r.page.evaluate(async () => {
    const img = document.querySelector('#image-preview img') as HTMLImageElement;
    // Once shown, its address is revoked: loading it again fails.
    const still = await new Promise<boolean>((resolve) => {
      const again = new Image();
      again.onload = () => resolve(true);
      again.onerror = () => resolve(false);
      again.src = img.src;
    });
    return { width: img.naturalWidth, height: img.naturalHeight, src: img.src.slice(0, 5), still, alt: img.alt };
  });
  assert.deepEqual(shown, { width: 40, height: 30, src: 'blob:', still: false, alt: 'Preview of image.png' });
  assert.equal(r.apiCalls.length, calls, 'showing the image fetches nothing');
  assert.equal(await r.page.getAttribute('#image-show', 'aria-expanded'), 'true');
  await r.page.click('#image-show');
  assert.equal(await r.page.locator('#image-preview img').count(), 0, 'hiding removes the image');
  await r.page.click('#image-show');
  await r.page.waitForSelector('#image-preview img');
  const [download] = await Promise.all([r.page.waitForEvent('download'), r.page.click('#save-file')]);
  assert.ok((await readFile(await download.path())).equals(png), 'the saved file is the original image');
  await r.page.click('#view-clone');
  await r.page.waitForSelector('#create:not([hidden])');
  assert.equal(await r.page.locator('#image-preview img').count(), 0, 'cloning removes the image from the page');
  assert.deepEqual(await r.page.locator('#file-list .nb-file-chip-name').allTextContents(), ['image.png']);
  await r.check(/^console error: Failed to load resource: net::ERR_FILE_NOT_FOUND$/); // the revoked-address probe above
  await r.context.close();
});

test('files that only claim to be images are never shown', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>');
  const huge = makePng(1, 1);
  huge.writeUInt32BE(20_000, 16); // the header claims 20000 x 1 pixels
  const cases = [
    { name: 'disguised.png', mimeType: 'image/png', buffer: svg, offered: true },
    { name: 'html.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('<!doctype html><script>alert(1)</script>'), offered: true },
    { name: 'huge.png', mimeType: 'image/png', buffer: huge, offered: true },
    { name: 'drawing.svg', mimeType: 'image/svg+xml', buffer: svg, offered: false },
    { name: 'real.png', mimeType: 'application/octet-stream', buffer: makePng(2, 2), offered: false },
  ];
  for (const c of cases) {
    const { share } = await createPaste({ text: c.name, file: { name: c.name, mimeType: c.mimeType, buffer: c.buffer } });
    const r = await open({ noFileSystemAccess: true });
    await goto(r, share);
    await r.page.waitForSelector('#view-file-card', { state: 'visible', timeout: 60_000 });
    assert.equal(await r.page.isVisible('#image-show'), c.offered, `${c.name}: offered`);
    if (c.offered) {
      await r.page.click('#image-show');
      await r.page.waitForSelector('#image-note', { state: 'visible' });
      assert.match(await r.page.textContent('#image-note') ?? '', /can’t be shown as an image/, c.name);
      assert.equal(await r.page.isVisible('#image-show'), false, `${c.name}: no second try`);
    }
    assert.equal(await r.page.locator('#image-preview img').count(), 0, `${c.name}: never shown`);
    const [download] = await Promise.all([r.page.waitForEvent('download'), r.page.click('#save-file')]);
    assert.ok((await readFile(await download.path())).equals(c.buffer), `${c.name}: still saves`);
    await r.check();
    await r.context.close();
  }
});

test('text attachment previews are explicit, inert, bounded, hideable and cleared on clone', async (t) => {
  // Read-heavy: its own rate-limit budget, like the other extra scenarios.
  await restartAPI();
  t.after(() => restartAPI());
  const text = '<img src="https://example.com/never" onerror="alert(1)">\n<script>alert(2)</script>\n[link](javascript:alert(3))\n![image](https://example.com/image)\n{"__proto__":{"polluted":true}}\nHidden: \u202E';
  for (const name of ['notes.txt', 'notes.md', 'data.json', 'data.csv']) {
    const content = Buffer.from(text);
    const { share } = await createPaste({ file: { name, mimeType: 'application/octet-stream', buffer: content } });
    const h = await open({ noFileSystemAccess: true });
    let dialogs = 0; h.page.on('dialog', (dialog) => { dialogs++; void dialog.dismiss(); });
    await goto(h, share);
    await h.page.waitForSelector('#view-file-card:not([hidden])');
    assert.equal(await h.page.locator('#document-preview').textContent(), '');
    assert.equal(await h.page.isVisible('#document-preview'), false);
    assert.equal(await h.page.textContent('#image-show span'), 'Show preview');
    await h.page.click('#image-show');
    await h.page.waitForSelector('#document-preview:not([hidden])');
    assert.equal(await h.page.textContent('#document-preview pre'), text);
    assert.match(await h.page.textContent('#document-preview') ?? '', /invisible or direction-changing/);
    assert.equal(await h.page.locator('#document-preview *').evaluateAll((items) => items.filter((e) => !['P', 'PRE'].includes(e.tagName)).length), 0, 'only a caption, a warning and plain text');
    assert.equal(dialogs, 0);
    await h.page.click('#image-show');
    assert.equal(await h.page.textContent('#document-preview'), '');
    await h.page.click('#image-show');
    await h.page.waitForSelector('#document-preview:not([hidden])');
    await h.page.click('#view-clone');
    await h.page.waitForSelector('#create:not([hidden])');
    assert.equal(await h.page.textContent('#document-preview'), '', 'no plaintext preview remains when cloning');
    await h.check(); await h.context.close();
  }
  const { share } = await createPaste({ file: { name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.from('x'.repeat(110_000)) } });
  const h = await open(); await goto(h, share);
  await h.page.waitForSelector('#view-file-card:not([hidden])'); await h.page.click('#image-show');
  await h.page.waitForSelector('#document-preview pre');
  assert.equal((await h.page.textContent('#document-preview pre'))!.length, 100_000);
  assert.match(await h.page.textContent('#document-preview') ?? '', /limited/);
  await h.check(); await h.context.close();
});

test('text that is not clean UTF-8, or too large, is not previewed and still saves', async (t) => {
  // Read-heavy: its own rate-limit budget, like the other extra scenarios.
  await restartAPI();
  t.after(() => restartAPI());
  const cases = [
    { name: 'binary.txt', mimeType: 'text/plain', buffer: Buffer.from([0, 255, 1]), offered: true },
    { name: 'escape.txt', mimeType: 'text/plain', buffer: Buffer.from([0x61, 0x1b, 0x5b, 0x33, 0x31, 0x6d]), offered: true },
    { name: 'latin1.txt', mimeType: 'text/plain', buffer: Buffer.from([0x63, 0x61, 0x66, 0xe9]), offered: true },
    { name: 'oversize.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1024 * 1024 + 1, 65), offered: false },
    { name: 'document.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n'), offered: false },
    { name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<script>alert(1)</script>'), offered: false },
  ];
  for (const item of cases) {
    const { share } = await createPaste({ file: { name: item.name, mimeType: item.mimeType, buffer: item.buffer } });
    const h = await open({ noFileSystemAccess: true });
    await goto(h, share); await h.page.waitForSelector('#view-file-card:not([hidden])');
    assert.equal(await h.page.isVisible('#image-show'), item.offered, `${item.name}: offered`);
    if (item.offered) {
      await h.page.click('#image-show');
      await h.page.waitForSelector('#image-note:not([hidden])');
      assert.match(await h.page.textContent('#image-note') ?? '', /shown as text/, item.name);
    }
    assert.equal(await h.page.locator('#document-preview pre').count(), 0, `${item.name}: nothing shown`);
    const [download] = await Promise.all([h.page.waitForEvent('download'), h.page.click('#save-file')]);
    assert.deepEqual(await readFile(await download.path()), item.buffer, `${item.name}: still saves`);
    await h.check(); await h.context.close();
  }
});

test('tampered attachment data never reaches the text preview', async (t) => {
  // Read-heavy: its own rate-limit budget, like the other extra scenarios.
  await restartAPI();
  t.after(() => restartAPI());
  // Five encrypted frames; only the last is altered, so the first four would
  // decrypt fine. Nothing may be shown until the whole attachment verifies:
  // a paste of up to 64 MiB is verified completely before anything appears.
  const { share } = await createPaste({ file: { name: 'data.txt', mimeType: 'text/plain', buffer: Buffer.from('verified line\n'.repeat(22_000)) } });
  const h = await open();
  await h.page.route('**/api/v1/pastes/*', async (route) => {
    const response = await route.fetch(); const body = await response.body(); body[body.length - 1]! ^= 1;
    await route.fulfill({ response, body });
  });
  await goto(h, share); await h.page.waitForSelector('#problem', { state: 'visible' });
  assert.equal(await h.page.textContent('#problem-title'), 'This paste is damaged');
  assert.equal(await h.page.isVisible('#view-content'), false);
  assert.equal(await h.page.isVisible('#view-file-card'), false);
  assert.equal(await h.page.textContent('#document-preview'), '');
  await h.check(); await h.context.close();
});

test('previews read the verified copy in memory, never a saved file that changed on disk', async (t) => {
  // Read-heavy: its own rate-limit budget, like the other extra scenarios.
  await restartAPI();
  t.after(() => restartAPI());
  const original = 'verified content\n';
  const { share } = await createPaste({ file: { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(original) } });
  const h = await open();
  // A save location whose file is different when read back, as if another
  // program changed it after saving.
  await h.page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      value: async () => ({
        createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }),
        getFile: async () => new File(['CHANGED ON DISK'], 'notes.txt', { type: 'text/plain' }),
      }),
    });
  });
  await goto(h, share); await h.page.waitForSelector('#view-file-card:not([hidden])');
  await h.page.click('#save-file');
  await h.page.waitForSelector('#file-saved:not([hidden])');
  await h.page.click('#image-show');
  await h.page.waitForSelector('#document-preview pre');
  assert.equal(await h.page.textContent('#document-preview pre'), original);
  await h.check(); await h.context.close();
});

test('a preview still loading when the page clears it never appears afterwards', async (t) => {
  // Read-heavy: its own rate-limit budget, like the other extra scenarios.
  await restartAPI();
  t.after(() => restartAPI());
  for (const [name, mimeType, buffer] of [['notes.txt', 'text/plain', Buffer.from('late text')], ['pixel.png', 'image/png', makePng(2, 2)]] as const) {
    const { share } = await createPaste({ file: { name, mimeType, buffer } });
    const h = await open();
    // Hold the attachment's bytes until the test lets them through.
    await h.page.addInitScript(() => {
      const original = Blob.prototype.arrayBuffer;
      const w = window as unknown as { __release: () => void; __held: number };
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      w.__held = 0;
      w.__release = release;
      Blob.prototype.arrayBuffer = async function (this: Blob) { w.__held++; await gate; return original.call(this); };
    });
    await goto(h, share); await h.page.waitForSelector('#view-file-card:not([hidden])');
    await h.page.click('#image-show');
    await h.page.waitForFunction(() => (window as unknown as { __held: number }).__held > 0);
    await h.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await h.page.evaluate(() => (window as unknown as { __release: () => void }).__release());
    await h.page.waitForSelector('#image-show:enabled');
    assert.equal(await h.page.locator('#document-preview pre, #image-preview img').count(), 0, `${name}: nothing reappears`);
    assert.equal(await h.page.textContent('#document-preview'), '');
    assert.equal(await h.page.getAttribute('#image-show', 'aria-expanded'), 'false');
    await h.check(); await h.context.close();
  }
});

test('a page restored after leaving keeps its text but says the wiped attachment is gone', async (t) => {
  // Read-heavy: its own rate-limit budget, like the other extra scenarios.
  await restartAPI();
  t.after(() => restartAPI());
  const { share } = await createPaste({ text: 'still here', file: { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('secret file') } });
  const h = await open();
  await goto(h, share); await h.page.waitForSelector('#view-file-card:not([hidden])');
  assert.ok(await h.page.isEnabled('#view-clone'));
  // What the browser does when the page goes into, then comes back from, its back/forward cache.
  await h.page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await h.page.waitForSelector('#file-error:not([hidden])');
  assert.match((await h.page.textContent('#file-error')) ?? '', /cleared from memory/);
  assert.equal(await h.page.isVisible('#save-file'), false);
  assert.equal(await h.page.isVisible('#image-show'), false);
  assert.ok(await h.page.isDisabled('#view-clone'));
  assert.equal(await viewerText(h.page), 'still here');
  await h.check(); await h.context.close();
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
  assert.equal(await h.page.textContent('#view-filename'), '', 'the opened file details leave the page when cloning');
  assert.equal(await h.page.textContent('#view-mime'), '');
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

test('the password generator fills a strong password that opens the paste', async () => {
  const h = await open();
  await goto(h, `${origin}/`);
  await h.page.fill('#text', 'generated password paste');
  await h.page.check('#password-switch');
  await h.page.click('#password-generate');
  const password = await h.page.inputValue('#password');
  assert.match(password, /^[A-HJ-NP-Za-km-np-z2-9]{20}$/);
  assert.equal(await h.page.getAttribute('#password', 'type'), 'text', 'a generated password is shown so it can be copied');
  await h.page.click('#password-generate');
  assert.notEqual(await h.page.inputValue('#password'), password, 'each click makes a new one');
  const generated = await h.page.inputValue('#password');
  await h.page.click('#create-submit');
  await h.page.waitForSelector('#result', { state: 'visible', timeout: 60_000 });
  assert.equal(await h.page.inputValue('#password'), '', 'the password is cleared once the paste is created');
  const share = `${await h.page.textContent('#share-server')}${await h.page.textContent('#share-key')}`;
  for (const s of h.sent) assert.ok(!(s.body?.toString('latin1') ?? '').includes(generated), 'the password reached the server');
  await h.check();
  await h.context.close();
  const v = await open();
  await goto(v, share);
  await unlock(v.page, generated);
  await v.page.waitForSelector('#view-content:not([hidden])', { timeout: 60_000 });
  assert.equal(await viewerText(v.page), 'generated password paste');
  await v.check();
  await v.context.close();
});

test('the time until deletion counts down on the result and the paste', async () => {
  const h = await open();
  await goto(h, `${origin}/`);
  await h.page.fill('#text', 'countdown');
  await h.page.selectOption('#expiry', '3600');
  await h.page.click('#create-submit');
  await h.page.waitForSelector('#result', { state: 'visible', timeout: 60_000 });
  const first = (await h.page.textContent('#result-expires')) ?? '';
  assert.match(first, / · deleted in (59m [0-5]\d|1h 00m 00)s$/);
  await h.page.waitForFunction((t) => document.getElementById('result-expires')!.textContent !== t, first, { timeout: 5000 });
  const share = `${await h.page.textContent('#share-server')}${await h.page.textContent('#share-key')}`;
  await h.check();
  await h.context.close();
  const v = await open();
  await goto(v, share);
  await v.page.waitForSelector('#view-expires:not([hidden])', { timeout: 60_000 });
  const shown = (await v.page.textContent('#view-expires-text')) ?? '';
  assert.match(shown, /^Deleted from the server in (59m [0-5]\d|1h 00m 00)s$/);
  await v.page.waitForFunction((t) => document.getElementById('view-expires-text')!.textContent !== t, shown, { timeout: 5000 });
  await v.check();
  await v.context.close();
});

test('separate links: one per person, each with its own opens, revocable one by one', async (t) => {
  // Read-heavy: its own rate-limit budget, like the other extra scenarios.
  await restartAPI();
  t.after(() => restartAPI());
  const c = await open();
  await goto(c, `${origin}/`);
  await c.page.fill('#text', 'for three people');
  await c.page.check('#recipients');
  assert.ok(await c.page.isDisabled('#discussion'), 'separate links rule out a discussion');
  await c.page.fill('#recipients-count', '3');
  await c.page.check('#burn');
  await c.page.fill('#burn-reads', '2');
  await c.page.check('#password-switch');
  await c.page.fill('#password', 'three people pw');
  await c.page.click('#create-submit');
  await c.page.waitForSelector('#recipient-links:not([hidden])', { timeout: 60_000 });
  assert.equal(await c.page.isVisible('#share-single'), false, 'no single shared link');
  const links = await c.page.$$eval('#recipient-list .nb-link', (ps) => ps.map((p) => p.textContent ?? ''));
  assert.equal(links.length, 3);
  assert.equal(new Set(links).size, 3);
  const base = links[0]!.split('#')[0]!;
  for (const l of links) assert.match(l, new RegExp(`^${base}#${KEY}\\.b\\.r[A-Za-z0-9_-]{22}$`));
  assert.equal(new Set(links.map((l) => l.split('.r')[0])).size, 1, 'the same key in every link');
  const create = c.sent.find((s) => s.method === 'POST' && s.path === '/api/v1/pastes')!;
  const body = JSON.parse(create.body!.toString('utf8')) as { recipients: { token: string; max_reads: number }[]; burn_token?: string; comment_token?: string };
  assert.equal(body.recipients.length, 3);
  assert.ok(body.recipients.every((r) => /^[A-Za-z0-9_-]{43}$/.test(r.token) && r.max_reads === 2));
  assert.equal(body.burn_token, undefined);
  assert.equal(body.comment_token, undefined);
  for (const l of links) {
    const [key, secret] = l.split('#')[1]!.split('.b.r');
    for (const s of c.sent) {
      const seen = `${s.path} ${JSON.stringify(s.headers)} ${s.body?.toString('latin1') ?? ''}`;
      assert.ok(!seen.includes(key!) && !seen.includes(secret!), 'a link secret reached the server');
    }
  }
  const del = await c.page.inputValue('#delete-link');
  assert.match(del, new RegExp(`/d/${ID}#d\\.${KEY}\\.r$`), 'the delete link says the paste has separate links');
  await c.check();
  await c.context.close();

  const openLink = async (link: string) => {
    const h = await open();
    await goto(h, link);
    await h.page.waitForSelector('#gate-burn', { state: 'visible' });
    assert.equal(await h.page.textContent('#burn-title'), 'This link has a limited number of opens');
    await h.page.click('#burn-open');
    await unlock(h.page, 'three people pw');
    await h.page.waitForSelector('#view-content:not([hidden]), #problem:not([hidden])', { timeout: 60_000 });
    return h;
  };
  // Link 1: its own count.
  const a = await openLink(links[0]!);
  assert.equal(await viewerText(a.page), 'for three people');
  const chips = (await a.page.textContent('#view-chips')) ?? '';
  assert.match(chips, /Your own link/);
  assert.match(chips, /1 open left/);
  assert.ok(await a.page.isVisible('#view-expires'), 'the countdown shows');
  const read = a.sent.find((s) => s.path.endsWith('/read'))!;
  assert.match(read.headers['nullbin-burn-token'] ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.ok(body.recipients.some((r) => r.token === read.headers['nullbin-burn-token']), 'link 1 sends its own token');
  await a.check();
  await a.context.close();
  // Link 2, once.
  const b = await openLink(links[1]!);
  assert.match((await b.page.textContent('#view-chips')) ?? '', /1 open left/, 'link 2 does not share link 1’s count');
  await b.check();
  await b.context.close();

  // The owner sees each link and revokes link 1.
  const o = await open();
  await goto(o, del);
  await o.page.waitForSelector('#recipients-manage:not([hidden])');
  const states = async () => o.page.$$eval('#recipient-status li', (lis) => lis.map((li) => li.textContent ?? ''));
  assert.deepEqual(await states(), ['Link 1Opened 1 of 2 timesRevoke', 'Link 2Opened 1 of 2 timesRevoke', 'Link 3Opened 0 of 2 timesRevoke']);
  await o.page.click('[aria-label="Revoke link 1"]');
  await o.page.waitForFunction(() => document.querySelector('#recipient-status li')?.textContent?.startsWith('Link 1Revoked'));
  assert.equal(await o.page.locator('[aria-label="Revoke link 1"]').count(), 0);
  await o.check();
  await o.context.close();

  // Link 1 is closed, and its holder is told so (not asked for the
  // password again); link 2 still has its last open.
  const a2 = await openLink(links[0]!);
  assert.equal(await a2.page.textContent('#problem-title'), 'This link no longer works');
  await a2.check(/status of 410/);
  await a2.context.close();
  const b2 = await openLink(links[1]!);
  assert.equal(await viewerText(b2.page), 'for three people');
  assert.match(await b2.page.textContent('#burned-note') ?? '', /This link has now used all its opens/);
  await b2.check();
  await b2.context.close();

  // Without its own secret, the key and password alone open nothing.
  const bare = await open();
  await goto(bare, links[2]!.split('.r')[0]!);
  await bare.page.click('#burn-open');
  await unlock(bare.page, 'three people pw');
  await bare.page.waitForSelector('#view-password-error', { state: 'visible', timeout: 60_000 });
  assert.equal(await bare.page.isVisible('#view-content'), false);
  await bare.check(/status of 404/);
  await bare.context.close();

  // Revoking the last open link deletes the paste.
  const o2 = await open();
  await goto(o2, del);
  await o2.page.waitForSelector('#recipients-manage:not([hidden])');
  assert.deepEqual(await o2.page.$$eval('#recipient-status li', (lis) => lis.map((li) => li.textContent ?? '')), ['Link 1Revoked · opened 1 time', 'Link 2Used up · opened 2 times', 'Link 3Opened 0 of 2 timesRevoke']);
  await o2.page.click('[aria-label="Revoke link 3"]');
  await o2.page.waitForSelector('#delete-done:not([hidden])');
  await o2.check(/status of 404/);
  await o2.context.close();
});

test('separate links without an open limit open any number of times', async (t) => {
  await restartAPI();
  t.after(() => restartAPI());
  const c = await open();
  await goto(c, `${origin}/`);
  await c.page.fill('#text', 'unlimited links');
  await c.page.check('#recipients');
  await c.page.click('#create-submit');
  await c.page.waitForSelector('#recipient-links:not([hidden])', { timeout: 60_000 });
  const links = await c.page.$$eval('#recipient-list .nb-link', (ps) => ps.map((p) => p.textContent ?? ''));
  assert.equal(links.length, 2);
  for (const l of links) assert.match(l, new RegExp(`#${KEY}\\.r[A-Za-z0-9_-]{22}$`));
  await c.check();
  await c.context.close();
  for (let i = 0; i < 3; i++) {
    const h = await open();
    await goto(h, links[i % 2]!);
    await h.page.waitForSelector('#view-content:not([hidden])', { timeout: 60_000 });
    assert.equal(await h.page.isVisible('#gate-burn'), false, 'no burn warning');
    assert.equal(await viewerText(h.page), 'unlimited links');
    const chips = (await h.page.textContent('#view-chips')) ?? '';
    assert.match(chips, /Your own link/);
    assert.doesNotMatch(chips, /left|Burned/);
    assert.equal(await h.page.isVisible('#burned-note'), false);
    await h.check();
    await h.context.close();
  }
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

test('create form: a discussion rules out burning, and the open count is validated', async () => {
  const h = await open();
  await goto(h, `${origin}/`);
  await h.page.check('#password-switch');
  assert.ok(await h.page.isEnabled('#discussion'), 'a password is compatible with discussion');
  assert.ok(await h.page.isEnabled('#burn'), 'a password is compatible with burn after reading');
  assert.equal(await h.page.locator('.nb-option-notes, .nb-option-note').count(), 0, 'settings do not add inline notices');
  await h.page.uncheck('#password-switch');
  await h.page.check('#discussion');
  assert.equal(await h.page.isChecked('#password-switch'), false, 'a discussion does not need a password');
  assert.ok(await h.page.isEnabled('#password-switch'), 'a password stays optional');
  assert.ok(await h.page.isDisabled('#burn'), 'burn after reading unavailable');
  assert.equal(await h.page.locator('label:has(#burn)').getAttribute('title'), 'Turn off Discussion to enable burn after reading.');
  assert.equal(await h.page.textContent('#burn-help'), 'Turn off Discussion to enable burn after reading.');
  await h.page.check('#password-switch');
  await h.page.fill('#text', 'x');
  await h.page.fill('#password', 'short');
  await h.page.click('#create-submit');
  await h.page.waitForSelector('#password.is-invalid');
  assert.equal(await h.page.getAttribute('#password', 'aria-invalid'), 'true');
  assert.deepEqual(h.apiCalls, [], 'nothing is uploaded with a too-short password');
  await h.page.uncheck('#discussion');
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
  assert.equal(await h.page.locator('label:has(#discussion)').getAttribute('title'), 'Allow encrypted comments from everyone who can open the paste.');
  await h.check();
  await h.context.close();
});

test('discussion without a password: anyone with the link reads and comments, nothing is asked', async () => {
  const { share } = await createPaste({ text: 'Open thread.', discussion: true });
  const h = await open();
  await goto(h, share);
  await h.page.waitForSelector('#view-content:not([hidden])', { timeout: 60_000 });
  assert.ok(await h.page.isHidden('#gate-password'), 'no password prompt');
  await h.page.waitForSelector('#comments:not([hidden])');
  await h.page.fill('#comment-name', 'Sam');
  await h.page.fill('#comment-text', 'Hello from the link alone.');
  await h.page.click('#comment-submit');
  await h.page.waitForSelector('.nb-comment');
  assert.equal(await h.page.textContent('.nb-comment .nb-comment-text'), 'Hello from the link alone.');
  // A second reader with the same link sees the comment after decrypting it.
  const h2 = await open();
  await goto(h2, share);
  await h2.page.waitForSelector('.nb-comment', { timeout: 60_000 });
  assert.equal(await h2.page.textContent('.nb-comment .nb-comment-name'), 'Sam');
  // Only the derived comment token reaches the server, never the link key or
  // the comment's plaintext.
  const key = share.split('#')[1]!;
  for (const r of [...h.sent, ...h2.sent]) {
    const seen = `${r.path} ${JSON.stringify(r.headers)} ${r.body ? r.body.toString('latin1') : ''}`;
    assert.ok(!seen.includes(key), `the link key was sent in ${r.method} ${r.path}`);
    assert.ok(!seen.includes('Hello from the link alone.'), `plaintext was sent in ${r.method} ${r.path}`);
  }
  assert.ok(h.sent.some((r) => /^[A-Za-z0-9_-]{43}$/.test(r.headers['nullbin-comment-token'] ?? '')), 'comments use the derived token');
  await h.check();
  await h2.check();
  await h.context.close();
  await h2.context.close();
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
  // The toggle applies to this page only: a reload follows the system again.
  await h.page.reload();
  await h.page.waitForSelector('#loading', { state: 'hidden' });
  assert.equal(await h.page.getAttribute('html', 'data-bs-theme'), 'light');
  assert.equal(await h.page.evaluate(() => localStorage.getItem('nullbin-theme')), null, 'no theme choice is stored');
  // A change of the system setting is followed while the page is open.
  await h.page.emulateMedia({ colorScheme: 'dark' });
  await h.page.waitForFunction(() => document.documentElement.getAttribute('data-bs-theme') === 'dark');
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
              toolbar: rect('.nb-toolbar'), expiry: rect('#expiry'), burn: rect('.nb-burn-setting'), recipients: rect('.nb-recipients-setting'),
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
            assert.ok(layout.recipients.y >= layout.burn.bottom + 7, `${label}: separate links need their own row`);
            assert.ok(layout.discussion.y >= layout.recipients.bottom + 7, `${label}: discussion needs its own row`);
            assert.ok(layout.password.y >= layout.discussion.bottom + 7, `${label}: password needs its own row`);
            if (layout.passwordField.height) assert.ok(layout.passwordField.y >= layout.password.bottom + 7, `${label}: password field follows its checkbox`);
            assert.ok(layout.submit.y >= layout.attach.bottom + 11, `${label}: Create follows Attach`);
            for (const action of [layout.attach, layout.submit]) assert.ok(Math.abs(action.width - layout.toolbar.width) < 1, `${label}: standalone actions fill their row`);
          } else if (width < 1200) {
            assert.equal(layout.expiry.y, layout.burn.y, `${label}: first settings row aligns`);
            assert.equal(layout.recipients.y, layout.discussion.y, `${label}: second settings row aligns`);
            assert.ok(layout.password.y >= layout.discussion.bottom + 7, `${label}: password has the third row`);
            assert.equal(layout.attach.y, layout.submit.y, `${label}: action row aligns`);
          }
        };
        await checkLayout('default');
        await h.page.check('#burn');
        await h.page.fill('#burn-reads', '1000');
        await h.page.check('#password-switch');
        await checkLayout('burn limit and password');
        await h.page.check('#recipients');
        await h.page.fill('#recipients-count', '20');
        await checkLayout('separate links, burn limit and password');
        await h.page.uncheck('#recipients');
        await h.page.uncheck('#burn');
        await h.page.check('#discussion');
        await checkLayout('discussion and password');
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
      await h.page.check('#password-switch');
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
