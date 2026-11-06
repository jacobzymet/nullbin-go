import { bindCopy, el } from './dom.ts';
import { qrcodegen } from '../vendor/qrcodegen.js';

export function emailHref(url: string): string {
  return `mailto:?subject=${encodeURIComponent('Encrypted note on Nullbin')}&body=${encodeURIComponent(`Open this encrypted paste:\n\n${url}\n\nIf a password is required, send it separately.`)}`;
}

/** Encode the secret link entirely locally, with a four-module quiet zone. */
export function qrSvg(value: string): SVGSVGElement {
  const code = qrcodegen.QrCode.encodeText(value, qrcodegen.QrCode.Ecc.MEDIUM);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const size = code.size + 8;
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code containing the full secret share link');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const background = document.createElementNS(svg.namespaceURI, 'rect');
  background.setAttribute('width', String(size));
  background.setAttribute('height', String(size));
  background.setAttribute('fill', '#fff');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  const modules: string[] = [];
  for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) {
    if (code.getModule(x, y)) modules.push(`M${x + 4},${y + 4}h1v1h-1z`);
  }
  path.setAttribute('d', modules.join(''));
  path.setAttribute('fill', '#000');
  svg.append(background, path);
  return svg;
}

let dialogReady = false;
let activeLink = '';

export function initShareActions(scope: 'result' | 'view', url: string, available = true): void {
  const email = el<HTMLAnchorElement>(`${scope}-email`);
  const qr = el<HTMLButtonElement>(`${scope}-qr`);
  const reason = 'All allowed opens have been used. This link can no longer be opened.';
  email.setAttribute('aria-disabled', String(!available));
  email.classList.toggle('nb-unavailable', !available);
  if (available) email.href = emailHref(url);
  else { email.removeAttribute('href'); email.tabIndex = 0; }
  email.title = available ? 'Open your email app with the full share link. No paste text or password is included.' : reason;
  qr.disabled = !available;
  qr.title = available ? 'Generate a QR code locally for the full share link.' : reason;
  qr.addEventListener('click', () => {
    activeLink = url;
    el('qr-image').replaceChildren(qrSvg(url));
    el('qr-link').textContent = url;
    el<HTMLDialogElement>('qr-dialog').showModal();
  });
  if (dialogReady) return;
  dialogReady = true;
  const dialog = el<HTMLDialogElement>('qr-dialog');
  el('qr-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    activeLink = '';
    el('qr-image').replaceChildren();
    el('qr-link').textContent = '';
  });
  bindCopy(el<HTMLButtonElement>('qr-copy'), () => activeLink, 'Link copied', el('qr-link'));
}
