// The scene outline: one still per beat, in a grid beside the preview.
//
// A list of scene names tells you what the film is about but not what it looks like, and the whole reason to glance
// left while editing is to find the beat you mean. So each row is the frame at that beat's midpoint, numbered in the
// corner, and nothing else: no name, no in/out times, no duration readout.
//
// Where the pictures come from, in order of preference:
//   1. a still already stored on disk for this scene and this code revision (instant, works on a reload)
//   2. a frame drawn from the live page by the editor, then uploaded so the next visit is instant
// A code change bumps the revision and every stored still is thrown away, because a picture of the old film is worse
// than an empty box.
import { sceneColor } from './timeline.js';

const mk = (tag, cls, attrs = {}) => { const e = document.createElement(tag); if (cls) e.className = cls; for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

export function createSceneOutline({ seek, api, projectId, revision, capture, thumbsMissing }) {
  // revision may be a getter: the live page's code revision is not known until the page has loaded, and the stored
  // stills are invalidated by it, so it has to be read at the moment a tile asks rather than once at construction
  const rev = () => (typeof revision === 'function' ? revision() : revision) || '';
  const head = mk('div', 'ol-head');
  const title = mk('b'); title.textContent = 'Scenes';
  const count = mk('span', 'ol-count');
  const grid = mk('div', 'ol-grid');
  head.append(title, count);
  const el = mk('div', 'rv2-outline');
  el.append(head, grid);

  let scenes = [], cur = -1, lastSig = '', destroyed = false;
  const shotOf = new Map();   // scene start time → object URL (or the tile element waiting for it)

  function tile(sc, i) {
    const btn = mk('button', 'ol-tile', { title: `${sc.name}${sc.set ? ' · ' + sc.set : ''} — click to jump` });
    btn.dataset.i = String(i);
    const art = mk('span', 'ol-art');
    art.style.background = `linear-gradient(135deg, ${sceneColor(sc, i)}33, #0000)`;
    const img = mk('img', 'ol-shot', { alt: '', decoding: 'async' });
    img.loading = 'lazy';
    const num = mk('span', 'ol-num'); num.textContent = String(i + 1);
    const spin = mk('span', 'ol-wait');
    art.append(img, num, spin);
    btn.append(art);
    btn.addEventListener('click', () => seek(sc.t0));
    loadShot(sc, i, img, spin);
    return btn;
  }

  async function loadShot(sc, i, img, spin) {
    const key = +sc.t0.toFixed(3);
    const cached = shotOf.get(key);
    if (cached) { img.src = cached; spin.remove(); return; }
    const url = `/api/project/${projectId}/scene-shot?t0=${key}&rev=${encodeURIComponent(rev())}`;
    try {
      const r = await fetch(url);
      if (destroyed) return;
      if (r.ok) {
        const blob = await r.blob();
        if (destroyed) return;
        const obj = URL.createObjectURL(blob);
        shotOf.set(key, obj);
        img.src = obj; spin.remove();
        return;
      }
    } catch { /* fall through to drawing it from the page */ }
    if (destroyed) return;
    // Nothing stored yet: draw this beat from the live page. Capture the MIDPOINT, not the start: a scene boundary
    // is usually a cut or a fade, so the opening frame of a beat is often black. The middle is what the beat is.
    let data = null;
    const mid = +(sc.t0 + (sc.t1 - sc.t0) / 2).toFixed(3);
    try { data = capture ? capture(mid) : null; } catch { data = null; }
    if (destroyed) return;
    if (data) {
      img.src = data; spin.remove();
      thumbsMissing?.add?.(key);
      // keep it, so the next visit paints from disk instead of re-rendering the whole film
      api(`/api/project/${projectId}/scene-shot`, { method: 'POST', body: { t0: key, data, revision: rev() } })
        .then(() => thumbsMissing?.delete?.(key)).catch(() => { });
    } else {
      // the live page may simply not be ready yet: leave the spinner in place and let the editor retry this tile
      // when the page reports ready, rather than burning a permanent "no picture" placeholder into the grid
      spin.dataset.waiting = 'live';
    }
  }
  // the live page finished loading, or was reloaded: any tile still waiting gets another chance
  function retryWaiting() {
    for (const t of grid.querySelectorAll('.ol-tile')) {
      const spin = t.querySelector('.ol-wait');
      const img = t.querySelector('.ol-shot');
      if (!spin || spin.dataset.waiting !== 'live' || img.src) continue;
      const sc = scenes[+t.dataset.i];
      if (sc) loadShot(sc, +t.dataset.i, img, spin);
    }
  }

  function render() {
    if (!scenes.length) {
      const empty = mk('div', 'ol-empty');
      empty.textContent = 'No scenes yet. Scenes come from the film\'s code, so they appear once the page defines them.';
      grid.replaceChildren(empty);
      count.textContent = '';
      return;
    }
    count.textContent = String(scenes.length);
    grid.replaceChildren(...scenes.map(tile));
    mark();
  }

  // highlight the beat the playhead is inside; `setCurrent` is called from the editor's frame loop
  function mark() {
    const tiles = grid.querySelectorAll('.ol-tile');
    for (const t of tiles) t.classList.toggle('on', +t.dataset.i === cur);
    tiles[cur]?.scrollIntoView({ block: 'nearest' });
  }
  function setCurrent(i) { if (i === cur) return; cur = i; mark(); }

  return {
    el,
    setScenes(next) {
      scenes = Array.isArray(next) ? next.filter(s => s && s.t1 > s.t0) : [];
      const sig = JSON.stringify(scenes.map(s => [s.name, s.set, s.t0, s.t1]));
      if (sig === lastSig) return;
      lastSig = sig; cur = -1; render();
    },
    setCurrent,
    retryWaiting,
    destroy() { destroyed = true; for (const u of shotOf.values()) if (typeof u === 'string' && u.startsWith('blob:')) URL.revokeObjectURL(u); shotOf.clear(); grid.replaceChildren(); },
  };
}
