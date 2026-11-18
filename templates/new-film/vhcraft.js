// NodeCut craft library: the primitives a film should not have to invent every time.
//
// Dependency-free and page-side. A film does not have to use it, but every function here obeys the film contract's
// golden rule (docs/PROJECT-CONTRACT.md §2): the picture is a pure function of t. There is no Math.random(), no
// Date.now() and no state carried from frame to frame, so the live preview can jump anywhere, frame stepping works and
// a partial re-render of one chunk matches its neighbours exactly.
//
// How to use it from a film (film.js already loads its assets inside an async bootstrap before window.READY):
//
//   const { VHCRAFT } = await import('./vhcraft.js');       // copied next to the film, or reachable by URL
//   const { clamp, ease, track, crossfade, caption, grain } = VHCRAFT;
//
// Iteration helpers take a normalised progress k (0..1) unless noted. Anything that draws takes the 2D context and the
// frame size, so a film can draw at any resolution (the template is 1920x1080).
//
// What is here
//   math    clamp, lerp, invLerp, remap, smoothstep, mix
//   ease    ease(name, k) and every curve by name (EASE)
//   motion  track, pulse, stagger
//   looks   crossfade, wipe, slide, iris, scrim, vignette, grain, letterbox, guides
//   text    wrapLines, caption, kinetic
//   misc    prng (seeded), tc (timecode), ink (scratch canvas)
'use strict';

const clamp = (x, a = 0, b = 1) => { x = +x; return Number.isFinite(x) ? (x < a ? a : x > b ? b : x) : a; };
const lerp = (a, b, k) => a + (b - a) * k;
const invLerp = (a, b, x) => (b === a ? 0 : (x - a) / (b - a));
const mix = lerp;
const smoothstep = (k) => { k = clamp(k); return k * k * (3 - 2 * k); };
const remap = (x, a, b, c, d) => lerp(c, d, clamp(invLerp(a, b, x)));

// ---- easing -----------------------------------------------------------------------------------------------------
// Named curves, all taking a normalised progress and returning a normalised value. in*/out*/inOut* read as
// "slow at the start / slow at the end / slow at both". outBack and outElastic overshoot slightly (they can return
// values outside 0..1 on purpose: that is the point of them).
const c1 = 1.70158, c3 = c1 + 1, c4 = (2 * Math.PI) / 3;
const EASE = {
  linear: (x) => x,
  inQuad: (x) => x * x,
  outQuad: (x) => 1 - (1 - x) * (1 - x),
  inOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
  inCubic: (x) => x * x * x,
  outCubic: (x) => 1 - Math.pow(1 - x, 3),
  inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  inQuart: (x) => x * x * x * x,
  outQuart: (x) => 1 - Math.pow(1 - x, 4),
  inOutQuart: (x) => (x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2),
  inQuint: (x) => x * x * x * x * x,
  outQuint: (x) => 1 - Math.pow(1 - x, 5),
  inOutQuint: (x) => (x < 0.5 ? 16 * x * x * x * x * x : 1 - Math.pow(-2 * x + 2, 5) / 2),
  inSine: (x) => 1 - Math.cos((x * Math.PI) / 2),
  outSine: (x) => Math.sin((x * Math.PI) / 2),
  inOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  inExpo: (x) => (x <= 0 ? 0 : Math.pow(2, 10 * x - 10)),
  outExpo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  inOutExpo: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2),
  inCirc: (x) => 1 - Math.sqrt(Math.max(0, 1 - x * x)),
  outCirc: (x) => Math.sqrt(Math.max(0, 1 - Math.pow(x - 1, 2))),
  inOutCirc: (x) => (x < 0.5 ? (1 - Math.sqrt(Math.max(0, 1 - Math.pow(2 * x, 2)))) / 2 : (Math.sqrt(Math.max(0, 1 - Math.pow(-2 * x + 2, 2))) + 1) / 2),
  inBack: (x) => c3 * x * x * x - c1 * x * x,
  outBack: (x) => 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2),
  inOutBack: (x) => (x < 0.5
    ? (Math.pow(2 * x, 2) * ((c1 + 1) * 2 * x - c1)) / 2
    : (Math.pow(2 * x - 2, 2) * ((c1 + 1) * (x * 2 - 2) + c1) + 2) / 2),
  outElastic: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1),
  outBounce: (x) => {
    const n1 = 7.5625, d1 = 2.75;
    if (x < 1 / d1) return n1 * x * x;
    if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
    if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
    return n1 * (x -= 2.625 / d1) * x + 0.984375;
  },
};
const ease = (name, k) => (EASE[name] || EASE.linear)(clamp(k));

// ---- motion -----------------------------------------------------------------------------------------------------
// track(keys, t): a keyframe track. keys = [{ t, v, ease }], v a number or an array of numbers; keys sorted by t
// (not required, but the common case). The `ease` on a key shapes the way *into* it; opts.ease is the default.
// Pure: the same t always returns the same value.
function track(keys, t, opts = {}) {
  const list = (keys || []).slice().sort((a, b) => a.t - b.t);
  if (!list.length) return typeof opts.fallback === 'number' ? opts.fallback : 0;
  if (t <= list[0].t) return list[0].v;
  if (t >= list[list.length - 1].t) return list[list.length - 1].v;
  let i = 0; while (i < list.length - 1 && t >= list[i + 1].t) i++;
  const a = list[i], b = list[i + 1];
  const k = ease(b.ease || opts.ease || 'linear', invLerp(a.t, b.t, t));
  if (Array.isArray(a.v) || Array.isArray(b.v)) {
    const va = Array.isArray(a.v) ? a.v : [a.v], vb = Array.isArray(b.v) ? b.v : [b.v];
    return va.map((x, n) => lerp(x, vb[n] ?? x, k));
  }
  return lerp(a.v, b.v, k);
}

// pulse(t, bpm): 1 exactly on the beat, decaying to ~0 before the next one. Handy for cuts and scale pops that sit on
// the music without hand-timing every hit. `decay` is how fast it falls (bigger = sharper).
function pulse(t, bpm, opts = {}) {
  const p = 60 / (bpm || 120), off = opts.offset || 0, decay = opts.decay ?? 6;
  if (!isFinite(t)) return 0;
  const x = ((((t - off) % p) + p) % p) / p;
  return Math.exp(-decay * x);
}

// stagger(i, n, opts): each of n items starts a little after the previous one and takes opts.dur to arrive.
// from: 'first' | 'last' | 'center'. Returns that item's own 0..1 progress.
function stagger(i, n, opts = {}) {
  const step = opts.step ?? 0.08, dur = opts.dur ?? 0.6, from = opts.from || 'first';
  const order = from === 'last' ? n - 1 - i : from === 'center' ? Math.abs(i - (n - 1) / 2) : i;
  return clamp((clamp(opts.k ?? 1) - order * step) / dur);
}

// ---- scratch canvases -------------------------------------------------------------------------------------------
// Two reusable offscreen canvases, so transitions do not allocate one per frame (allocation in a render loop is the
// difference between a smooth preview and a stuttering one).
const scratch = new Map();
function ink(w, h, slot = 0) {
  const key = w + 'x' + h + '#' + slot;
  let c = scratch.get(key);
  if (!c) { c = document.createElement('canvas'); c.width = w; c.height = h; scratch.set(key, c); }
  const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, w, h);
  return { c, g };
}
const call = (g, a) => { if (typeof a === 'function') a(g); else if (a) g.drawImage(a, 0, 0); };

// ---- transitions ------------------------------------------------------------------------------------------------
// Each transition takes the context, an already-eased progress k (0 = all A, 1 = all B), the frame size and two draw
// callbacks (or ready images/canvases): (g) => { … } for A and B. They draw the finished composite.
function crossfade(g, k, w, h, a, b) {
  k = clamp(k);
  call(g, a);
  if (k <= 0) return;
  g.save(); g.globalAlpha = k; call(g, b); g.restore();
}

// dir: 'right' | 'left' | 'up' | 'down'. soft > 0 feathers the edge (px), which reads far more expensive than a hard cut.
function wipe(g, k, w, h, a, b, opts = {}) {
  k = clamp(k);
  if (k >= 1) return call(g, b);
  call(g, a);
  const dir = opts.dir || 'right', soft = opts.soft || 0;
  if (!soft) {
    g.save(); g.beginPath();
    if (dir === 'left') g.rect(w - w * k, 0, w * k, h);
    else if (dir === 'up') g.rect(0, h - h * k, w, h * k);
    else if (dir === 'down') g.rect(0, 0, w, h * k);
    else g.rect(0, 0, w * k, h);
    g.clip(); call(g, b); g.restore();
    return;
  }
  const s = ink(w, h, 0);
  call(s.g, b);
  const horiz = dir === 'left' || dir === 'right';
  const span = horiz ? w : h;
  // the leading edge of the reveal; the opaque side is behind it
  const edge = dir === 'right' || dir === 'down' ? span * k : span * (1 - k);
  const sign = dir === 'right' || dir === 'down' ? -1 : 1;
  const a0 = edge + sign * soft, a1 = edge - sign * soft;   // stop 1 → stop 0
  const grd = horiz ? s.g.createLinearGradient(a0, 0, a1, 0) : s.g.createLinearGradient(0, a0, 0, a1);
  grd.addColorStop(0, 'rgba(0,0,0,1)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
  s.g.globalCompositeOperation = 'destination-in'; s.g.fillStyle = grd;
  s.g.fillRect(0, 0, w, h);
  g.drawImage(s.c, 0, 0);
}

// The incoming shot slides in over the old one. dir: 'left' | 'right' | 'up' | 'down' = the direction it comes from.
function slide(g, k, w, h, a, b, opts = {}) {
  k = clamp(k);
  const dir = opts.dir || 'left';
  const dx = dir === 'left' ? -w : dir === 'right' ? w : 0;
  const dy = dir === 'up' ? -h : dir === 'down' ? h : 0;
  g.save(); g.translate(dx * k, dy * k); call(g, a); g.restore();
  g.save(); g.translate(dx * (1 - k), dy * (1 - k)); call(g, b); g.restore();
}

// Circle opens on the new shot. cx/cy default to the centre in frame pixels.
function iris(g, k, w, h, a, b, opts = {}) {
  k = clamp(k);
  if (k >= 1) return call(g, b);
  call(g, a);
  const cx = opts.cx ?? w / 2, cy = opts.cy ?? h / 2;
  const r = k * Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
  g.save(); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip(); call(g, b); g.restore();
}

// ---- looks ------------------------------------------------------------------------------------------------------
// A gradient scrim: the thing that makes text and badges readable on top of a picture.
function scrim(g, x, y, w, h, opts = {}) {
  const dir = opts.dir || 'up';
  const from = opts.from || 'rgba(0,0,0,.82)', to = opts.to || 'rgba(0,0,0,0)';
  const grd = dir === 'down' ? g.createLinearGradient(x, y, x, y + h)
    : dir === 'right' ? g.createLinearGradient(x, y, x + w, y)
      : dir === 'left' ? g.createLinearGradient(x + w, y, x, y)
        : g.createLinearGradient(x, y + h, x, y);
  grd.addColorStop(0, from); grd.addColorStop(1, to);
  g.save(); g.fillStyle = grd; g.fillRect(x, y, w, h); g.restore();
}

function vignette(g, w, h, opts = {}) {
  const amount = opts.amount ?? 0.45, rgb = opts.color || '0,0,0';
  const grd = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * (opts.inner ?? 0.35), w / 2, h / 2, Math.hypot(w, h) * 0.62);
  grd.addColorStop(0, `rgba(${rgb},0)`); grd.addColorStop(1, `rgba(${rgb},${amount})`);
  g.save(); g.fillStyle = grd; g.fillRect(0, 0, w, h); g.restore();
}

// Film grain. The noise tile is built once from the seed and re-used; the offset is a quantised function of t, so the
// grain moves frame to frame but a re-render of the same t gives the same pixels. Never calls Math.random().
const tiles = new Map();
function noiseTile(seed, size) {
  const key = seed + '@' + size;
  let c = tiles.get(key);
  if (c) return c;
  c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), img = g.createImageData(size, size), rnd = prng(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (rnd() * 255) | 0;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); tiles.set(key, c);
  return c;
}
function grain(g, w, h, opts = {}) {
  const amount = opts.amount ?? 0.08, size = opts.size || 128, seed = opts.seed || 1, t = opts.t || 0;
  const tile = noiseTile(seed, size);
  const step = Math.floor(t * (opts.fps || 30));
  const ox = (step * 37) % size, oy = (step * 61) % size;
  g.save();
  g.globalAlpha = amount;
  g.globalCompositeOperation = opts.blend || 'overlay';
  const pat = g.createPattern(tile, 'repeat');
  if (pat && pat.setTransform) { try { pat.setTransform(new DOMMatrix([1, 0, 0, 1, -ox, -oy])); } catch { } }
  g.fillStyle = pat || 'rgba(128,128,128,.5)';
  g.fillRect(0, 0, w, h);
  g.restore();
}

// Letterbox bars for a target aspect (2.39:1 by default): the cheap way to make a 16:9 frame read as cinema.
function letterbox(g, w, h, opts = {}) {
  const aspect = opts.aspect ?? 2.39, color = opts.color || '#000';
  const bar = Math.max(0, (h - w / aspect) / 2);
  if (!bar) return;
  g.save(); g.fillStyle = color; g.fillRect(0, 0, w, bar); g.fillRect(0, h - bar, w, bar); g.restore();
}

// Safe-area guides (title + action safe). Preview only: call it behind an "if (window.VH_GUIDES)" toggle so it never
// ends up in a render.
function guides(g, w, h, opts = {}) {
  const title = opts.title ?? 0.1, action = opts.action ?? 0.05, color = opts.color || 'rgba(255,90,90,.75)';
  g.save(); g.strokeStyle = color; g.lineWidth = 2; g.setLineDash([12, 10]);
  for (const m of [title, action]) g.strokeRect(w * m / 2, h * m / 2, w * (1 - m), h * (1 - m));
  g.setLineDash([]); g.beginPath();
  g.moveTo(w / 2, h / 2 - 24); g.lineTo(w / 2, h / 2 + 24); g.moveTo(w / 2 - 24, h / 2); g.lineTo(w / 2 + 24, h / 2);
  g.stroke(); g.restore();
}

// ---- text -------------------------------------------------------------------------------------------------------
// Greedy word wrap using the context's current font. Returns the lines (no drawing). measureText does not touch
// layout, so this is safe to call per frame.
function wrapLines(g, text, maxW) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = line + ' ' + words[i];
      if (g.measureText(test).width <= maxW) line = test;
      else { out.push(line); line = words[i]; }
    }
    out.push(line);
  }
  return out;
}

// A drawn caption with an optional plate behind it and a scrim under it. Set every text property from opts so it does
// not depend on whatever the film left on the context.
function caption(g, text, opts = {}) {
  const w = opts.w || 1920, h = opts.h || 1080;
  const size = opts.size || 54, font = opts.font || 'system-ui, sans-serif', weight = opts.weight || 600;
  const color = opts.color || '#fff', align = opts.align || 'center', maxW = opts.maxW || w * 0.8;
  const lh = opts.lineHeight || 1.32, y = opts.y ?? h * 0.86;
  g.save();
  g.font = `${weight} ${size}px ${font}`; g.textAlign = align; g.textBaseline = 'alphabetic';
  const lines = wrapLines(g, text, maxW);
  if (opts.scrim !== false) scrim(g, 0, y - size * (lines.length * lh + 0.9), w, size * (lines.length * lh + 1.6), { dir: 'up', ...(opts.scrim || {}) });
  const x = opts.x ?? (align === 'left' ? (w - maxW) / 2 : align === 'right' ? (w + maxW) / 2 : w / 2);
  if (opts.plate) {
    const widest = Math.max(...lines.map((l) => g.measureText(l).width));
    const left = align === 'left' ? x - size * 0.25 : align === 'right' ? x - widest - size * 0.25 : x - widest / 2 - size * 0.5;
    g.fillStyle = opts.plate;
    g.fillRect(left, y - size * (lines.length * lh) - size * 0.2, widest + size, size * (lines.length * lh + 0.4));
  }
  if (opts.stroke) { g.lineWidth = opts.strokeW || size * 0.12; g.strokeStyle = opts.stroke; g.lineJoin = 'round'; }
  lines.forEach((line, i) => {
    const ly = y - size * lh * (lines.length - 1 - i);
    if (opts.stroke) g.strokeText(line, x, ly);
    g.fillStyle = typeof color === 'function' ? color(i, line) : color;
    g.fillText(line, x, ly);
  });
  g.restore();
}

// Kinetic captions: words = [{ t0, t1, w }]. Every word is laid out in reading order and wrapped; the word playing now
// is highlighted (pop: scale + accent colour; box: a rounded plate behind it; underline: a bar under it). Words that
// have not started yet are dimmed instead of hidden, so the line does not reflow mid-sentence.
function kinetic(g, words, t, opts = {}) {
  const w = opts.w || 1920, h = opts.h || 1080;
  const size = opts.size || 58, font = opts.font || 'system-ui, sans-serif', weight = opts.weight || 800;
  const color = opts.color || '#fff', dim = opts.dim ?? 0.32, accent = opts.accent || '#ffd166';
  const maxW = opts.maxW || w * 0.82, lh = opts.lineHeight || 1.34, y = opts.y ?? h * 0.84;
  const gap = size * (opts.gap ?? 0.26);
  g.save();
  g.font = `${weight} ${size}px ${font}`; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  const list = (words || []).filter(Boolean);
  const measure = (wd) => g.measureText(wd.w ?? wd.word ?? wd.text ?? '').width;
  // lay out: greedy wrap, remembering each word's x/y
  const rows = [];
  let row = [], rowW = 0;
  for (const wd of list) {
    const wdW = measure(wd);
    if (row.length && rowW + gap + wdW > maxW) { rows.push({ items: row, width: rowW }); row = []; rowW = 0; }
    rowW += (row.length ? gap : 0) + wdW; row.push(wd);
  }
  if (row.length) rows.push({ items: row, width: rowW });
  const blockTop = y - size * lh * (rows.length - 1);
  if (opts.scrim !== false) scrim(g, 0, blockTop - size * 1.1, w, size * (lh * rows.length) + size * 1.6, { dir: 'up', ...(opts.scrim || {}) });
  rows.forEach((r, ri) => {
    const ry = blockTop + ri * size * lh;
    let x = (w - r.width) / 2;
    for (const wd of r.items) {
      const text = wd.w ?? wd.word ?? wd.text ?? '';
      const wdW = measure(wd);
      const on = t >= wd.t0 && t < wd.t1, done = t >= wd.t1;
      const k = opts.pop === false ? 1 : ease('outBack', clamp(invLerp(wd.t0, wd.t0 + (opts.popDur || 0.22), t)));
      g.save(); g.globalAlpha = on ? 1 : done ? (opts.doneAlpha ?? 0.85) : dim;
      const s = on ? lerp(1, opts.popScale ?? 1.12, k) : 1;
      g.translate(x + wdW / 2, ry); g.scale(s, s); g.translate(-wdW / 2, 0);
      if (on && opts.style === 'box') {
        const rr = size * 0.16;
        g.fillStyle = accent; g.beginPath();
        g.roundRect ? g.roundRect(-size * 0.18, -size * 0.86, wdW + size * 0.36, size * 1.12, rr) : g.rect(-size * 0.18, -size * 0.86, wdW + size * 0.36, size * 1.12);
        g.fill();
        g.fillStyle = opts.boxText || '#141414'; g.fillText(text, 0, 0);
      } else {
        g.fillStyle = on ? accent : color;
        if (opts.stroke) { g.lineWidth = opts.strokeW || size * 0.1; g.strokeStyle = opts.stroke; g.lineJoin = 'round'; g.strokeText(text, 0, 0); }
        g.fillText(text, 0, 0);
        if (on && opts.style === 'underline') { g.fillRect(0, size * 0.12, wdW, Math.max(2, size * 0.07)); }
      }
      g.restore();
      x += wdW + gap;
    }
  });
  g.restore();
}

// ---- misc -------------------------------------------------------------------------------------------------------
// mulberry32: a small seeded PRNG. Deterministic, so a "random" effect is still a pure function of its seed.
function prng(seed) {
  let a = (seed | 0) || 1;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Timecode m:ss:ff (h:mm:ss:ff from an hour), frame-accurate for a given fps.
function tc(sec, fps = 30) {
  sec = Math.max(0, +sec || 0);
  const f = Math.floor((sec - Math.floor(sec)) * fps + 1e-6);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = Math.floor(sec) % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return (h ? h + ':' + pad(m) : m) + ':' + pad(s) + ':' + pad(f);
}

export const VHCRAFT = {
  version: 1,
  // math
  clamp, lerp, mix, invLerp, remap, smoothstep,
  // easing
  EASE, ease,
  // motion
  track, pulse, stagger,
  // transitions + looks
  ink, crossfade, wipe, slide, iris, scrim, vignette, grain, letterbox, guides,
  // text
  wrapLines, caption, kinetic,
  // misc
  prng, tc,
};

// Also reachable as a global, so a classic <script> film can use it after a one-time dynamic import.
if (typeof window !== 'undefined') window.VHCRAFT = VHCRAFT;
export default VHCRAFT;
