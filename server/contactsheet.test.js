import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTimes } from './contactsheet.js';

test('contact sheet: sampling is evenly spaced, inside the film and never on its last frame', () => {
  const t = defaultTimes(10, 12);
  assert.equal(t.length, 12);
  assert.deepEqual(t, [0.417, 1.25, 2.083, 2.917, 3.75, 4.583, 5.417, 6.25, 7.083, 7.917, 8.75, 9.583]);
  assert.ok(t.every(x => x > 0 && x < 10), 't = dur is one past the last frame, so it is never sampled');
  // the gaps are all the same: the sheet reads as a timeline, not as a random selection
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  assert.ok(gaps.every(g => Math.abs(g - gaps[0]) < 0.002), 'even spacing');
});

test('contact sheet: odd inputs still give a usable grid', () => {
  assert.equal(defaultTimes(10, 1).length, 1);
  assert.equal(defaultTimes(10, 0).length, 12, 'a missing count falls back to the default');
  assert.equal(defaultTimes(10, -5).length, 12, 'a negative count is not a grid');
  assert.equal(defaultTimes(10, 500).length, 48, 'the grid is capped so the PNG stays readable');
  assert.equal(defaultTimes(0, 4).length, 4, 'an unknown length still samples something');
  assert.ok(defaultTimes(0, 4).every(x => x >= 0 && Number.isFinite(x)));
  assert.ok(defaultTimes(NaN, 3).every(x => Number.isFinite(x)), 'a broken DUR does not produce NaN times');
});
