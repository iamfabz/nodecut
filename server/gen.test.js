import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ID_RE, newId, atlasPlan, fileOf, add, list, get, CLIP_DIR } from './gen.js';
import { run, TOOLS } from './util.js';

const tmpFilm = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhgen-'));
  return { path: dir, id: 'p1', title: 'test' };
};

test('gen: an asset id has one shape, so a stray file in gen/ can be told apart from one the hub made', () => {
  const id = newId(new Date('2026-11-16T10:00:00Z'));
  assert.match(id, ID_RE);
  assert.ok(id.startsWith('20261116-'));
  assert.equal(id.slice(9).length, 6);
  for (const bad of ['gen-1', '20261116-abc', '20261116-abcdefg', '../20261116-abcdef', '']) assert.equal(ID_RE.test(bad), false, bad);
});

test('gen: the atlas plan paginates cells across sheets without losing the last frame', () => {
  // 5 s at 15 fps = 75 cells; 8x8 = 64 per sheet, so two sheets and the last cell is the 11th of the second
  const a = atlasPlan({ dur: 5, fps: 15, cols: 8, rows: 8 });
  assert.equal(a.total, 75);
  assert.equal(a.pages, 2);
  assert.equal(a.lastCell, 10);
  assert.equal(a.lastRow, 1);
  // an exact multiple of a sheet is one sheet, not a second empty one
  assert.equal(atlasPlan({ dur: 64 / 15, fps: 15 }).pages, 1);
  // a zero-length clip still gets one frame rather than a division by zero
  assert.equal(atlasPlan({ dur: 0, fps: 15 }).total, 1);
  // a long clip is capped so a single film cannot fill the disk silently
  assert.equal(atlasPlan({ dur: 600, fps: 15, maxFrames: 600 }).total, 600);
});

test('gen: a generated file can only ever resolve inside gen/', () => {
  const p = tmpFilm();
  const ok = fileOf(p, 'gen/plates/20261116-abc123.png');
  assert.ok(ok.startsWith(path.join(p.path, 'gen') + path.sep));
  // a manifest in a downloaded film must not be able to point the hub at any file on the PC
  for (const bad of ['../../etc/passwd', '/etc/passwd', 'gen/../film.js', 'film.js', '', null]) {
    assert.throws(() => fileOf(p, bad), /no file|must live in gen/, String(bad));
  }
});

test('gen: the manifest is append-only and refuses a duplicate id', () => {
  const p = tmpFilm();
  add(p, { id: '20261116-abc123', kind: 'plate', file: 'gen/plates/20261116-abc123.png' });
  assert.throws(() => add(p, { id: '20261116-abc123', kind: 'plate' }), /already in gen.json/);
  add(p, { id: '20261116-abc124', kind: 'clip', file: 'gen/clips/20261116-abc124.mp4' });
  assert.equal(list(p).length, 2);
  assert.equal(get(p, '20261116-abc124').kind, 'clip');
  // a record that is not shaped like an id is refused rather than written
  assert.throws(() => add(p, { id: 'nope', kind: 'plate' }), /id like/);
});

test('gen: bakeClip turns a real clip into atlas sheets and the index names every page', { skip: !fs.existsSync(TOOLS.ffmpeg) }, async () => {
  const { bakeClip, readAtlas, add } = await import('./gen.js');
  const p = tmpFilm();
  fs.mkdirSync(path.join(p.path, CLIP_DIR), { recursive: true });
  const clip = path.join(p.path, CLIP_DIR, '20261116-feed01.mp4');
  // a 1.2 s clip with a moving red bar: 18 frames at 15 fps, one 8x8 sheet, a real change between cells
  const r = await run(TOOLS.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=1.2',
    '-vf', "drawbox=x='t*200':y=40:w=40:h=40:color=red:t=fill", '-pix_fmt', 'yuv420p', clip]);
  assert.equal(r.code, 0, r.stderr);
  add(p, { id: '20261116-feed01', kind: 'clip', file: 'gen/clips/20261116-feed01.mp4' });
  const at = await bakeClip(p, '20261116-feed01', { fps: 15, cell: 160 });
  assert.equal(at.total, 18, '1.2 s at 15 fps');
  assert.equal(at.pages, 1, '18 cells fit one 8x8 sheet');
  assert.equal(at.cellW, 160);
  assert.equal(at.cellH, 90, 'the cell keeps the clip aspect ratio');
  assert.equal(at.sheets.length, 1);
  for (const s of at.sheets) assert.ok(fs.existsSync(path.join(p.path, s)), s);
  assert.equal(readAtlas(p, '20261116-feed01').total, 18);
  // the page-side index the film reads is written too
  const idx = JSON.parse(fs.readFileSync(path.join(p.path, 'gen', 'atlas', 'index.json'), 'utf8'));
  assert.deepEqual(idx.ids, ['20261116-feed01']);
  // the sheet is a real sprite sheet: one 8x8 grid of 160x90 cells
  const st = fs.statSync(path.join(p.path, at.sheets[0]));
  assert.ok(st.size > 1000);
});

test('gen: a clip with no video stream fails with a sentence, not a stack', { skip: !fs.existsSync(TOOLS.ffmpeg) }, async () => {
  const { bakeClip, add } = await import('./gen.js');
  const p = tmpFilm();
  fs.mkdirSync(path.join(p.path, CLIP_DIR), { recursive: true });
  const junk = path.join(p.path, CLIP_DIR, '20261116-feed02.mp4');
  fs.writeFileSync(junk, 'not a video');
  add(p, { id: '20261116-feed02', kind: 'clip', file: 'gen/clips/20261116-feed02.mp4' });
  await assert.rejects(() => bakeClip(p, '20261116-feed02', {}), /no video stream/);
});
