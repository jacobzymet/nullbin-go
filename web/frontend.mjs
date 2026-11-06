// Build-time settings for static hosting. Nothing here is supplied by the
// storage server. Keep the same baseline headers as internal/server.
export function parseAPIOrigin(value = '') {
  if (value === '') return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('NULLBIN_API_ORIGIN must be an HTTPS origin, such as https://api.example.com'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      ![url.origin, `${url.origin}/`].includes(value)) {
    throw new Error('NULLBIN_API_ORIGIN must be a canonical HTTPS origin without a path, credentials, query or fragment (HTTP is local-test only)');
  }
  return url.origin;
}

export function contentSecurityPolicy(apiOrigin = '') {
  apiOrigin = parseAPIOrigin(apiOrigin);
  return "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
    `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ''}; ` +
    "img-src 'self' blob: data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
}

export function frontendHeaders(apiOrigin = '') {
  return {
    'Content-Security-Policy': contentSecurityPolicy(apiOrigin),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'accelerometer=(), autoplay=(), browsing-topics=(), camera=(), clipboard-read=(), clipboard-write=(self), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-create=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), sync-xhr=(), usb=(), web-share=(), xr-spatial-tracking=()',
    'Strict-Transport-Security': 'max-age=31536000',
  };
}
