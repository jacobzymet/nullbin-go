// Small DOM helpers. Text is only ever set with textContent: nothing in
// Nullbin uses innerHTML or inline styles. Icons come from the SVG sprite
// in index.html.

export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e as T;
}

export function show(e: HTMLElement, visible = true): void {
  e.hidden = !visible;
}

/** Shows an element with a short entrance animation (skipped for reduced motion in CSS). */
export function reveal(e: HTMLElement): void {
  e.hidden = false;
  e.classList.remove('nb-enter');
  void e.offsetWidth; // restart the animation
  e.classList.add('nb-enter');
}

const SECTIONS = ['create', 'result', 'view', 'delete', 'problem'];

/** Shows one top-level section and hides the others. */
export function showSection(id: string): HTMLElement {
  for (const s of SECTIONS) if (s !== id) show(el(s), false);
  const section = el(id);
  reveal(section);
  return section;
}

/** Replaces the page with a problem state: what happened and what to do. */
export function showProblem(title: string, text: string): void {
  el('problem-title').textContent = title;
  el('problem-text').textContent = text;
  showSection('problem');
  el('problem-title').focus();
}

export function showError(message: string): void {
  const e = el('error-banner');
  e.textContent = message;
  reveal(e);
  e.focus();
}

export function clearError(): void {
  const e = el('error-banner');
  e.textContent = '';
  e.hidden = true;
}

/** Announces a short message to screen readers. */
export function announce(message: string): void {
  const e = el('announce');
  e.textContent = '';
  // A separate task, so the same message twice is announced twice.
  setTimeout(() => {
    e.textContent = message;
  }, 50);
}

let toastTimer = 0;

/** Shows a brief confirmation at the bottom of the screen. */
export function toast(message: string, tone: 'ok' | 'warn' | 'danger' = 'ok'): void {
  const t = el('toast');
  el('toast-text').textContent = message;
  t.classList.remove('nb-tone-ok', 'nb-tone-warn', 'nb-tone-danger');
  t.classList.add(`nb-tone-${tone}`);
  setIcon(t, tone === 'ok' ? 'check' : 'alert');
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), tone === 'ok' ? 2400 : 6000);
}

/** Labels and announces work in progress, and restores the original button. */
export function busy(button: HTMLButtonElement, text: string): () => void {
  const label = button.querySelector('span') ?? button;
  const original = label.textContent;
  const disabled = button.disabled;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  label.textContent = text;
  return () => {
    button.disabled = disabled;
    button.removeAttribute('aria-busy');
    label.textContent = original;
  };
}

/** Clipboard permissions vary by browser; failure must never undo a completed task. */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

const copiedButtons = new WeakMap<HTMLButtonElement, { text: string; icon: string | null; timer: number }>();

function resetCopied(button: HTMLButtonElement): void {
  const state = copiedButtons.get(button);
  if (!state) return;
  window.clearTimeout(state.timer);
  (button.querySelector('span') ?? button).textContent = state.text;
  if (state.icon) button.querySelector('use')?.setAttribute('href', state.icon);
  button.classList.remove('nb-copied');
  copiedButtons.delete(button);
}

/** Confirm on the control itself without moving it or losing keyboard focus. */
export function showCopied(button: HTMLButtonElement): void {
  const label = button.querySelector('span') ?? button;
  const state = copiedButtons.get(button) ?? { text: label.textContent ?? '', icon: button.querySelector('use')?.getAttribute('href') ?? null, timer: 0 };
  window.clearTimeout(state.timer);
  label.textContent = 'Copied';
  setIcon(button, 'check');
  button.classList.add('nb-copied');
  state.timer = window.setTimeout(() => resetCopied(button), 2400);
  copiedButtons.set(button, state);
}

/** An inline icon from the sprite, e.g. icon('lock'). */
export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'nb-i');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Swaps the icon inside a button or other element. */
export function setIcon(container: Element, name: string): void {
  container.querySelector('use')?.setAttribute('href', `#i-${name}`);
}

/** A status chip, e.g. chip('Password', 'lock'). */
export function chip(label: string, iconName?: string, tone?: 'warn' | 'accent' | 'file'): HTMLLIElement {
  const li = document.createElement('li');
  li.className = tone ? `nb-chip nb-chip-${tone}` : 'nb-chip';
  if (iconName) li.append(icon(iconName));
  const span = document.createElement('span');
  span.textContent = label;
  li.append(span);
  return li;
}

/** Copies with local feedback and an actionable fallback if permission is denied. */
export function bindCopy(button: HTMLButtonElement, value: () => string, done: string, select?: HTMLElement, selected = 'The link is selected'): void {
  let copying = false;
  button.addEventListener('click', async () => {
    if (copying) return;
    copying = true;
    resetCopied(button);
    const copied = await copyText(value());
    copying = false;
    if (copied) {
      showCopied(button);
      toast(done);
    } else if (select) {
      select.focus();
      if (select instanceof HTMLInputElement) select.select();
      else {
        const range = document.createRange();
        range.selectNodeContents(select);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      toast(`Could not copy automatically. ${selected}; use your device’s Copy command.`, 'warn');
    } else {
      toast('Could not copy. Use Save document to save the text instead.', 'warn');
    }
  });
}

/** Wires a show/hide button to a password input. */
export function bindReveal(button: HTMLButtonElement, input: HTMLInputElement): void {
  button.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    button.setAttribute('aria-pressed', String(!showing));
    button.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    setIcon(button, showing ? 'eye' : 'eye-off');
    input.focus();
  });
}

/** A Bootstrap progress bar driven by width classes (nb-w-0 ... nb-w-100). */
export class Progress {
  private readonly bar: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly status: HTMLElement;
  private pct = 0;

  constructor(prefix: string) {
    this.bar = el(`${prefix}-bar`);
    this.fill = el(`${prefix}-bar-fill`);
    this.status = el(`${prefix}-status`);
  }

  set(fraction: number, label?: string): void {
    const pct = Math.max(0, Math.min(100, Math.floor(fraction * 100)));
    if (pct !== this.pct) {
      this.fill.classList.replace(`nb-w-${this.pct}`, `nb-w-${pct}`);
      this.bar.setAttribute('aria-valuenow', String(pct));
      this.pct = pct;
    }
    if (label !== undefined && this.status.textContent !== label) this.status.textContent = label;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", or a date. */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 30 * 86400) {
    const d = Math.round(s / 86400);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }
  return new Date(ms).toLocaleDateString();
}

/** "in 1 day" style distance to a future date. */
export function timeUntil(date: Date, now: number = Date.now()): string {
  const min = Math.round((date.getTime() - now) / 60000);
  if (min < 60) return `in ${Math.max(1, min)} min`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? 'in 1 hour' : `in ${h} hours`;
  const d = Math.round(h / 24);
  return d === 1 ? 'in 1 day' : `in ${d} days`;
}

/** Time left as "2d 4h 05m", "4h 05m 09s", "5m 09s" or "9s". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${h}h ${two(m)}m`;
  if (h > 0) return `${h}h ${two(m)}m ${two(s)}s`;
  if (m > 0) return `${m}m ${two(s)}s`;
  return `${s}s`;
}

/**
 * Re-renders node every second until the deadline, a performance.now()
 * time (so changing the computer's clock does not change it). Returns a
 * function that stops it.
 */
export function startCountdown(node: HTMLElement, deadline: number, render: (left: number) => string): () => void {
  let timer = 0;
  const stop = () => clearInterval(timer);
  const tick = () => {
    const left = deadline - performance.now();
    node.textContent = render(left);
    if (left <= 0) stop();
  };
  timer = window.setInterval(tick, 1000);
  tick();
  return stop;
}

/** Yields to the browser so status text paints before blocking work. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}
