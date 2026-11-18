// Generated-clip atlases: draw one cell of a sprite sheet as the picture for a moment of the film.
//
// A clip a model made is not a function of t (it is a baked MP4), so it cannot be drawn the way the rest of a film is.
// The bake in server/gen.js turns it into sprite sheets instead, and this module reads the sheets and draws exactly one
// cell for a given local time. That is a pure function of t again: the same t always gives the same cell, so frame
// stepping, jumping anywhere in the preview and a partial re-render of one chunk all match.
//
// Use it from a film's async bootstrap, before window.READY (the sheets must be decoded first):
//
//   const { VIHATLAS } = await import('./vhatlas.js')
//   const GEN = await VIHATLAS.load('./gen/atlas')       // every baked atlas in the film
//   const fly = GEN.get('20261116-ab12cd')               // one of them, by the id in gen/gen.json
//
// and in renderOut(t):
//
//   fly.draw(g, t - 4.0, 0, 0, W, H)                     // the clip's own second is (film time - where it starts)
//
// The page must be served (or opened) so that ./gen/atlas/*.json and *.png are readable next to it. A clip with no atlas
// is simply absent from the map, so a film can check `if (fly)` and fall back to its own drawing.
'use strict';

const loadImage = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('cannot load ' + src)); i.src = src; });
const join = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : +x || a);

// One atlas: the index (rows, cols, fps, total) plus its decoded sheets.
class Atlas {
  constructor(dir, index, sheets) { Object.assign(this, index); this.sheets = sheets; this.dir = dir; }
  get dur() { return this.total / this.fps; }
  // the cell for local second `t`, as { sheet, sx, sy, sw, sh }; null when t is outside the clip
  cellAt(t) {
    if (!(t >= 0) || t >= this.dur) return null;
    const n = Math.min(this.total - 1, Math.floor(t * this.fps));
    const page = Math.floor(n / (this.cols * this.rows)), i = n % (this.cols * this.rows);
    const sheet = this.sheets[page];
    if (!sheet) return null;
    // Sheets hold exactly cols x rows cells (ffmpeg tiles a full grid); the last page may have filler cells to the
    // right, which is fine: they are never picked because n is capped at total - 1.
    return { sheet, sx: (i % this.cols) * this.cellW, sy: Math.floor(i / this.cols) * this.cellH, sw: this.cellW, sh: this.cellH };
  }
  // draw the clip's local second t into a box. `round` off keeps the motion smooth between cells when a film runs
  // faster than the atlas (a blend of two cells is not needed: the nearest cell is what the bake actually recorded).
  draw(g, t, x, y, w = this.cellW, h = this.cellH) {
    const c = this.cellAt(t);
    if (!c) return false;
    g.drawImage(c.sheet, c.sx, c.sy, c.sw, c.sh, x, y, w ?? c.sw, h ?? c.sh);
    return true;
  }
  // `cover`: fill the box, cropping the overflow like object-fit: cover. `contain`: whole cell, letterboxed.
  drawFit(g, t, x, y, w, h, fit = 'cover') {
    const c = this.cellAt(t);
    if (!c) return false;
    const s = fit === 'cover' ? Math.max(w / c.sw, h / c.sh) : Math.min(w / c.sw, h / c.sh);
    const sw = c.sw * s, sh = c.sh * s;
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    g.drawImage(c.sheet, c.sx, c.sy, c.sw, c.sh, x + (w - sw) / 2, y + (h - sh) / 2, sw, sh);
    g.restore();
    return true;
  }
}

// Read every <id>.json in `dir` and decode the sheets it names. A broken or half-written atlas is skipped, never fatal:
// a film must still open when one generated clip failed to bake.
async function load(dir = './gen/atlas') {
  const map = new Map();
  for (const f of await listDir(dir)) {
    try {
      const index = await (await fetch(join(dir, f))).json();
      const sheets = await Promise.all((index.sheets || []).map(s => loadImage(join(dir, s.split('/').pop()))));
      if (sheets.length) map.set(index.id, new Atlas(dir, index, sheets));
    } catch { }
  }
  return map;
}

// An atlas directory cannot be listed from a browser. NodeCut serves /gen/atlas/<id>.json for a baked clip; the hub
// writes gen/atlas/index.json (just the ids) for exactly this reason, and it is the only listing a page needs.
async function listDir(dir) {
  try {
    const r = await fetch(join(dir, 'index.json'));
    if (!r.ok) return [];
    const j = await r.json();
    return (j.ids || []).map(id => id + '.json');
  } catch { return []; }
}

// Load exactly the ids named (works without a directory listing, and is what a film should do once it knows them).
async function loadIds(dir, ids) {
  const map = new Map();
  for (const id of ids || []) {
    try {
      const index = await (await fetch(join(dir, id + '.json'))).json();
      const sheets = await Promise.all((index.sheets || []).map(s => loadImage(join(dir, s.split('/').pop()))));
      if (sheets.length) map.set(index.id, new Atlas(dir, index, sheets));
    } catch { }
  }
  return map;
}

export const VIHATLAS = { Atlas, load, loadIds, loadWithPlacements };
export default VIHATLAS;

// ---- placements: the timeline is the truth --------------------------------------------------------------------
// tweaks.json "gen" says where a clip plays (t0, t1, opacity, fit). The film calls this once per frame instead of
// hard-coding times, so dragging a bar on the timeline changes the film with no code change at all.
//
//   const GEN = await VIHATLAS.load('./gen/atlas', { placements: './tweaks.json' });
//   ... inside renderOut(t):   GEN.drawAt(g, t, W, H)
//
// `placements` is the raw list from tweaks.json (or a url to read it from). Entries whose atlas is missing are skipped,
// so a placement never breaks a film whose files moved.
async function readPlacements(src) {
  try {
    const j = typeof src === 'string' ? await (await fetch(src)).json() : src;
    return Array.isArray(j?.gen) ? j.gen : [];
  } catch { return []; }
}

// Attach the drawing helper to a map returned by load(). Kept as a function on the map so existing code that only uses
// GEN.get(id) is untouched.
export async function loadWithPlacements(dir = './gen/atlas', placementsSrc = './tweaks.json') {
  const [GEN, list] = await Promise.all([load(dir), readPlacements(placementsSrc)]);
  return attachDraw(GEN, list);
}

function attachDraw(GEN, list) {
  // The placements themselves, so a beat can ask whether a clip is covering a moment and skip its own background.
  GEN.placed = () => (list || []).slice();
  // Draw every placement that is playing at film second t, in order. Returns the number drawn.
  GEN.drawAt = function (g, t, w, h, opts = {}) {
    let n = 0;
    for (const e of list || []) {
      if (e.hide || !(t >= e.t0 && t < e.t1)) continue;
      const at = this.get(e.id);
      if (!at) continue;
      const before = g.globalAlpha;
      if (Number.isFinite(e.op)) g.globalAlpha = before * Math.max(0, Math.min(1, e.op));
      // `fit` needs a destination box; a full-frame placement uses the frame size it was given
      const box = opts.box ? opts.box(e) : { x: 0, y: 0, w, h };
      const k = (t - e.t0);
      if (e.fit === 'contain') at.drawFit(g, k, box.x, box.y, box.w, box.h, 'contain');
      else at.drawFit(g, k, box.x, box.y, box.w, box.h, 'cover');
      g.globalAlpha = before;
      n++;
    }
    return n;
  };
  return GEN;
}

export const VIHATLAS_WITH_PLACEMENTS = { loadWithPlacements };
