// Google Fonts' Damion, subset to "Nullbin"; see web/fonts/OFL.txt.
// Load bundled bytes directly so the wordmark needs no extra request or CSP exception.
import bytes from '../fonts/Damion-Nullbin.ttf';

export function initWordmark(): void {
  const font = new FontFace('Damion', bytes);
  void font.load().then((loaded) => document.fonts.add(loaded)).catch(() => {
    // Keep the readable cursive fallback if the browser cannot load the font.
  });
}
