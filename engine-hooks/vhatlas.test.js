// The atlas loader is page code (it runs in the film, next to vhcraft.js), so it is tested here with a fake window
// and a fake fetch: what matters is that a given t always picks the same cell, and that a bad atlas never breaks a film.
import test from 'node:test';
import assert from 'node:assert/strict';

// The module is an ES module that expects `Image` and `fetch`; give it the smallest versions that behave.
class FakeImage { set src(v) { this._src = v; queueMicrotask(() => (v.includes('missing') ? this.onerror?.() : this.onload?.())); } }
globalThis.Image = FakeImage;

const atlases = {
  'gen/atlas/index.json': { v: 1, ids: ['20261116-ab12cd'] },
  'gen/atlas/20261116-ab12cd.json': { id: '20261116-ab12cd', cellW: 160, cellH: 90, cols: 4, rows: 2, fps: 10, total: 14, pages: 2, sheets: ['gen/atlas/20261116-ab12cd-00.png', 'gen/atlas/20261116-ab12cd-01.png'] },
  'gen/atlas/20261116-broken.json': { id: '20261116-broken', cellW: 0, cellH: 0, cols: 4, rows: 2, fps: 10, total: 4, pages: 1, sheets: ['gen/atlas/missing-00.png'] },
};
globalThis.fetch = async (url) => {
  const key = String(url).replace(/^\.\//, '').replace(/^https?:\/\/[^/]+\//, '');
  if (!(key in atlases)) return { ok: false, json: async () => ({}) };
  return { ok: true, json: async () => atlases[key] };
};

const { VIHATLAS } = await import('./vhatlas.js');

test('vhatlas: the same local second always picks the same cell', async () => {
  const GEN = await VIHATLAS.load('./gen/atlas');
  const a = GEN.get('20261116-ab12cd');
  assert.ok(a, 'the atlas in index.json is loaded');
  assert.equal(a.fps, 10);
  assert.equal(a.dur, 1.4, '14 cells at 10 fps');
  // cell n is chosen by floor(t * fps), capped at the last frame: a pure function of t
  assert.deepEqual(a.cellAt(0), { sheet: a.sheets[0], sx: 0, sy: 0, sw: 160, sh: 90 });
  assert.deepEqual(a.cellAt(0.05), { sheet: a.sheets[0], sx: 0, sy: 0, sw: 160, sh: 90 }, 'still cell 0');
  assert.deepEqual(a.cellAt(0.1), { sheet: a.sheets[0], sx: 160, sy: 0, sw: 160, sh: 90 }, 'cell 1 wraps into the next column');
  assert.deepEqual(a.cellAt(0.4), { sheet: a.sheets[0], sx: 0, sy: 90, sw: 160, sh: 90 }, 'cell 4 starts the second row');
  const c12 = a.cellAt(1.20);
  assert.deepEqual({ sx: c12.sx, sy: c12.sy, page: a.sheets.indexOf(c12.sheet) }, { sx: 0, sy: 90, page: 1 }, 'cell 12 is cell 4 of the second sheet: first column, second row');
  // outside the clip there is no cell, so the film can fall back to its own drawing
  assert.equal(a.cellAt(-0.1), null);
  assert.equal(a.cellAt(1.4), null, 'the end of the clip is one past the last frame');
  assert.equal(a.cellAt(NaN), null);
});

test('vhatlas: a broken or missing atlas is skipped, never fatal', async () => {
  const GEN = await VIHATLAS.loadIds('./gen/atlas', ['20261116-broken', '20261116-nope']);
  assert.equal(GEN.size, 0, 'a sheet that will not decode leaves the map empty instead of throwing');
  const good = await VIHATLAS.loadIds('./gen/atlas', ['20261116-ab12cd']);
  assert.equal(good.size, 1);
});

test('vhatlas: draw and drawFit call through to drawImage with the right cell and box', async () => {
  const GEN = await VIHATLAS.loadIds('./gen/atlas', ['20261116-ab12cd']);
  const a = GEN.get('20261116-ab12cd');
  const calls = [];
  const g = { drawImage: (...args) => calls.push(args), save() {}, restore() {}, beginPath() {}, rect() {}, clip() {} };
  assert.equal(a.draw(g, 0.15, 10, 20, 320, 180), true);
  assert.deepEqual(calls.pop(), [a.sheets[0], 160, 0, 160, 90, 10, 20, 320, 180]);
  assert.equal(a.draw(g, 5, 0, 0), false, 'past the end nothing is drawn');
  assert.equal(calls.length, 0);
  assert.equal(a.drawFit(g, 0.15, 0, 0, 640, 360, 'cover'), true);
  const whole = calls.pop();
  assert.equal(whole[0], a.sheets[0]);
  assert.equal(whole.length, 9, 'source rect + destination rect');
});

test('vhatlas: loadWithPlacements is reachable on VIHATLAS, and draws only what tweaks.json places', async () => {
  // This is the shape the film calls. It was exported as a bare function and not on the object once, so the film's
  // import silently came back undefined and the clip never drew — a test that only checked the function would miss it.
  assert.equal(typeof VIHATLAS.loadWithPlacements, 'function', 'the film calls VIHATLAS.loadWithPlacements');

  atlases['tweaks.json'] = { v: 1, gen: [{ id: '20261116-ab12cd', t0: 1, t1: 2, op: 0.5 }] };
  const GEN = await VIHATLAS.loadWithPlacements('./gen/atlas', './tweaks.json');
  assert.equal(typeof GEN.drawAt, 'function');

  const calls = [];
  const g = { globe: 1, globalAlpha: 1, drawImage: (...a) => calls.push(a), save() {}, restore() {}, beginPath() {}, rect() {}, clip() {} };
  assert.equal(GEN.drawAt(g, 1.5, 10, 10), 1, 'inside the placement it draws');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], GEN.get('20261116-ab12cd').sheets[0], 'the atlas is what gets drawn');

  calls.length = 0;
  assert.equal(GEN.drawAt(g, 5.0, 10, 10), 0, 'outside the placement nothing is drawn');
  assert.equal(calls.length, 0, 'and nothing reached the canvas');

  // opacity is applied and put back, so one placement cannot dim the rest of the film
  const g2 = { globalAlpha: 1, drawImage() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {} };
  GEN.drawAt(g2, 1.5, 10, 10);
  assert.equal(g2.globalAlpha, 1, 'globalAlpha is restored after drawing');
});
