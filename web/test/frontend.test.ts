import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAPIOrigin, contentSecurityPolicy, frontendHeaders } from '../frontend.mjs';

test('static frontend API origin is explicit and rejects unsafe or ambiguous URLs', () => {
  assert.equal(parseAPIOrigin(''), '');
  assert.equal(parseAPIOrigin('https://api.example.com/'), 'https://api.example.com');
  assert.equal(parseAPIOrigin('https://api.example.com:8443'), 'https://api.example.com:8443');
  assert.equal(parseAPIOrigin('http://127.0.0.1:8000'), 'http://127.0.0.1:8000');
  for (const value of ['*', '//api.example.com', 'http://api.example.com', 'https://u:p@api.example.com', 'https://api.example.com/api', 'https://api.example.com?x', 'https://api.example.com#x', 'https://api.example.com\n', 'https://API.example.com', 'https://api.example.com:443']) {
    assert.throws(() => parseAPIOrigin(value), Error, value);
  }
});

test('static frontend CSP grants only its own assets and its fixed API connection', () => {
  const api = parseAPIOrigin('https://api.example.com');
  const csp = contentSecurityPolicy(api);
  assert.ok(csp.includes("connect-src 'self' https://api.example.com;"));
  assert.ok(csp.includes("script-src 'self' 'wasm-unsafe-eval';"));
  assert.ok(!csp.includes("script-src 'self' https://api.example.com"));
  const h = frontendHeaders(api);
  assert.equal(h['Content-Security-Policy'], csp);
  assert.equal(h['Referrer-Policy'], 'no-referrer');
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['Cross-Origin-Resource-Policy'], 'same-origin');
});
