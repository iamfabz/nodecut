import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VHCRAFT } from './vhcraft.js';

test('vhcraft: math helpers clamp, interpolate and remap', () => {
  const { clamp, lerp, invLerp, remap, smoothstep } = VHCRAFT;
  assert.equal(clamp(5), 1); assert.equal(clamp(-5), 0); assert.equal(clamp(0.25), 0.25);
  assert.equal(clamp(7, 2, 5), 5); assert.equal(clamp(0, 2, 5), 2);
  assert.equal(clamp(NaN), 0, 'a missing value falls to the low end instead of NaN');
  assert.equal(lerp(10, 20, 0.5), 15);
  assert.equal(invLerp(10, 20, 15), 0.5);
  assert.equal(invLerp(5, 5, 9), 0, 'a zero-length span does not divide by zero');
  assert.equal(remap(0.5, 0, 1, 100, 200), 150);
  assert.equal(remap(2, 0, 1, 100, 200), 200, 'out of range is clamped');
  assert.equal(smoothstep(0), 0); assert.equal(smoothstep(1), 1); assert.equal(smoothstep(0.5), 0.5);
});

test('vhcraft: every easing curve starts at 0, ends at 1 and stays finite in between', () => {
  const { EASE, ease } = VHCRAFT;
  const names = Object.keys(EASE);
  assert.ok(names.length >= 20, 'the curve set is not empty');
  for (const name of names) {
    assert.ok(Math.abs(EASE[name](0)) < 1e-9, `${name}(0) must be 0`);
    assert.ok(Math.abs(EASE[name](1) - 1) < 1e-9, `${name}(1) must be 1`);
    for (let i = 0; i <= 100; i++) {
      const v = EASE[name](i / 100);
      assert.ok(Number.isFinite(v), `${name}(${i / 100}) must be finite`);
    }
  }
  assert.equal(ease('nope', 0.5), 0.5, 'an unknown name falls back to linear');
  assert.equal(ease('outCubic', 2), 1, 'progress is clamped before the curve runs');
});

test('vhcraft: track interpolates numbers and arrays, honours easing and holds at the ends', () => {
  const { track } = VHCRAFT;
  const keys = [{ t: 0, v: 0 }, { t: 1, v: 10 }];
  assert.equal(track(keys, -1), 0, 'before the first key it holds');
  assert.equal(track(keys, 2), 10, 'after the last key it holds');
  assert.equal(track(keys, 0.5), 5);
  const eased = track([{ t: 0, v: 0 }, { t: 1, v: 10, ease: 'inQuad' }], 0.5);
  assert.equal(eased, 2.5, 'the incoming key shapes the way into it');
  assert.deepEqual(track([{ t: 0, v: [0, 100] }, { t: 1, v: [10, 0] }], 0.5), [5, 50], 'array values interpolate element by element');
  assert.equal(track([], 0.5, { fallback: 7 }), 7);
  // unsorted keys must still work: the track is sorted, not trusted
  assert.equal(track([{ t: 1, v: 10 }, { t: 0, v: 0 }], 0.5), 5);
});

test('vhcraft: pulse peaks on the beat and repeats, stagger offsets items', () => {
  const { pulse, stagger } = VHCRAFT;
  const p = 60 / 120;   // 120 bpm = half a second per beat
  assert.equal(pulse(0, 120), 1);
  assert.ok(pulse(p, 120) > 0.99, 'the next beat peaks again');
  assert.ok(pulse(p / 2, 120) < pulse(0, 120), 'it decays between beats');
  assert.ok(Math.abs(pulse(-p, 120) - 1) < 1e-9, 'negative time is still on the grid');
  const a = stagger(0, 4, { k: 0.5, step: 0.1, dur: 0.6 });
  const b = stagger(3, 4, { k: 0.5, step: 0.1, dur: 0.6 });
  assert.ok(a > b, 'the first item leads the last one');
  assert.equal(stagger(0, 4, { k: 0 }), 0, 'nothing has started yet at k=0');
});

test('vhcraft: prng is seeded and repeatable, so an effect is still a pure function of its inputs', () => {
  const { prng } = VHCRAFT;
  const a = prng(42), b = prng(42), c = prng(43);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  assert.deepEqual(seqA, seqB, 'the same seed gives the same sequence');
  assert.notDeepEqual(seqA, Array.from({ length: 20 }, () => c()), 'a different seed differs');
  for (const v of seqA) assert.ok(v >= 0 && v < 1, 'values stay in [0,1)');
});

test('vhcraft: timecode is frame accurate', () => {
  const { tc } = VHCRAFT;
  assert.equal(tc(0, 30), '0:00:00');
  assert.equal(tc(1.5, 30), '0:01:15');
  assert.equal(tc(65, 30), '1:05:00');
  assert.equal(tc(3661, 25), '1:01:01:00');
});

test('vhcraft: the template copy is the same file, so a new film and a render never disagree', () => {
  // engine-hooks/vhcraft.js is the master; templates/new-film/vhcraft.js is the copy a new film gets (render.js opens
  // the page over file://, where nothing outside the film's own folder exists). Copy again with:
  //   cp engine-hooks/vhcraft.js templates/new-film/vhcraft.js
  const master = fs.readFileSync(new URL('./vhcraft.js', import.meta.url), 'utf8');
  const copy = fs.readFileSync(new URL('../templates/new-film/vhcraft.js', import.meta.url), 'utf8');
  assert.equal(copy === master, true, 'templates/new-film/vhcraft.js has drifted from engine-hooks/vhcraft.js');
});

test('vhcraft: the library never reaches for a clock or an unseeded random', () => {
  const raw = fs.readFileSync(new URL('./vhcraft.js', import.meta.url), 'utf8');
  // Comments may name these; only real code matters. Strip /* */ and // before looking.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // The film contract (§2) makes the picture a pure function of t. These three are the usual ways that breaks.
  for (const bad of ['Math.random(', 'Date.now(', 'new Date(']) {
    assert.equal(source.includes(bad), false, `${bad} would make a frame depend on more than t`);
  }
});

test('vhatlas: the template copy is the same file as the hook a live page loads', () => {
  // Same rule as vhcraft.js: engine-hooks/ is the master. render.js opens the page over file://, where nothing outside
  // the film's folder exists, so a new film carries its own copy. Copy again with:
  //   cp engine-hooks/vhatlas.js templates/new-film/vhatlas.js
  const master = fs.readFileSync(new URL('./vhatlas.js', import.meta.url), 'utf8');
  const copy = fs.readFileSync(new URL('../templates/new-film/vhatlas.js', import.meta.url), 'utf8');
  assert.equal(copy === master, true, 'templates/new-film/vhatlas.js has drifted from engine-hooks/vhatlas.js');
});
