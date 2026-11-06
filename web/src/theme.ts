// Light/dark mode via Bootstrap's data-bs-theme attribute. Follows the
// system setting until the user picks one with the toggle; that choice is
// remembered in localStorage (it never leaves the browser).

import { el, setIcon } from './dom.ts';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'nullbin-theme';

function saved(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function save(t: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

export function initTheme(): void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const button = el<HTMLButtonElement>('theme-toggle');
  const apply = (t: Theme) => {
    document.documentElement.setAttribute('data-bs-theme', t);
    // A toggle button: pressed means the dark theme is on.
    button.setAttribute('aria-pressed', String(t === 'dark'));
    button.title = t === 'dark' ? 'Dark theme is on' : 'Dark theme is off';
    setIcon(button, t === 'dark' ? 'sun' : 'moon');
  };
  apply(saved() ?? (media.matches ? 'dark' : 'light'));
  media.addEventListener('change', () => {
    if (!saved()) apply(media.matches ? 'dark' : 'light');
  });
  button.addEventListener('click', () => {
    const next: Theme = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
    save(next);
    apply(next);
  });
}
