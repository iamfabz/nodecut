// theme.js — the palette, for code that draws instead of styles.
//
// The studio's colours are CSS custom properties on :root (ui/style.css). CSS picks them up on its own; canvas code
// cannot, because a canvas pixel is painted from a string, not from a stylesheet. Rather than paste hex values into
// every drawing module — which is how a timeline ends up one shade out of step with the cards around it — this reads
// the real tokens back out of the document once and hands them over.
//
// Falls back to the same literals when there is no document (tests, node) so a drawing function never throws.

const FALLBACK = {
  canvas: '#0a0a0c',
  surface: '#131316',
  surfaceBorder: 'rgba(255,255,255,.07)',
  textMain: '#f4f4f5',
  textMuted: '#7d7d87',   // matches --text-muted in ui/style.css (WCAG AA on canvas)
  accentPrimary: '#38bdf8',
  accentGlow: 'rgba(56,189,248,.15)',
  // secondary surfaces used by the timeline's own lanes, kept next to the tokens so they cannot drift apart
  raised: '#18181c',
  lane: '#15151a',
  laneAlt: '#17181e',
  track: '#232329',
  dim: '#52525b',   // disabled/inactive only; deliberately below AA
};

let cache = null;

/** The palette. Read once per document; call theme.reset() if the tokens change at runtime. */
export function theme() {
  if (cache) return cache;
  const out = { ...FALLBACK };
  const read = (name, key) => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (v) out[key] = v;
    } catch { /* no document: keep the fallback */ }
  };
  read('--canvas', 'canvas');
  read('--surface', 'surface');
  read('--surface-border', 'surfaceBorder');
  read('--text-main', 'textMain');
  read('--text-muted', 'textMuted');
  read('--accent-primary', 'accentPrimary');
  read('--accent-glow', 'accentGlow');
  read('--card2', 'raised');
  read('--row', 'lane');
  read('--track', 'track');
  read('--dim', 'dim');
  cache = out;
  return cache;
}

/** Forget the cached palette (the tests use this; nothing in the app needs it). */
theme.reset = () => { cache = null; };
