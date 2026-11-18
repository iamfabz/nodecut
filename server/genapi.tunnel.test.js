// The paid path has two things that must never be guessed at: what a job costs, and what the tunnel exposes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NODECUT_BASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-genapi-base-'));
const { oneShotFile, tunnelServe, checkBudget, spentToday, addSpend, genSettings, hasKey } = await import('./genapi.js');

const film = () => ({ path: fs.mkdtempSync(path.join(os.tmpdir(), 'vh-gen-film-')), id: 'f1' });

// a tiny fake res so tunnelServe can be driven without a server
const res = () => {
  const r = { code: 0, headers: {}, killed: false, ended: 0 };
  r.writeHead = (c, h) => { r.code = c; r.headers = h || {}; };
  r.end = () => { r.ended++; };
  r.destroy = () => { r.killed = true; };
  return r;
};

test('genapi: the tunnel exposes one file, by an unguessable path, and forgets it on close', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-tun-'));
  const file = path.join(dir, 'still.png');
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const shot = oneShotFile(file);
  assert.match(shot.urlPath, /^\/__gen\/[a-z0-9]+$/);
  assert.ok(shot.urlPath.length > 20, 'the token is long enough not to be guessed');
  const r = res();
  assert.equal(tunnelServe({ method: 'HEAD', url: shot.urlPath }, r), true, 'the registered path is handled');
  assert.equal(r.code, 200);
  assert.equal(r.headers['Content-Type'], 'image/png');
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal(r.headers['Content-Length'], 4);
  // anything else on the tunnel is not routed at all
  assert.equal(tunnelServe({ method: 'GET', url: '/api/projects' }, res()), false, 'the normal API is untouched');
  const wrong = res();
  assert.equal(tunnelServe({ method: 'GET', url: '/__gen/not-the-token' }, wrong), true, 'the prefix is ours, so we answer it');
  assert.equal(wrong.code, 404, 'with a 404: no other path in the hub is reachable through a tunnel');
  // a token that was never registered is a 404, and so is one after it was forgotten
  const gone = res(); tunnelServe({ method: 'GET', url: '/__gen/nope' }, gone); assert.equal(gone.code, 404);
  shot.forget();
  const after = res(); assert.equal(tunnelServe({ method: 'GET', url: shot.urlPath }, after), true); assert.equal(after.code, 404);
});

test('genapi: the tunnel refuses writes even on a live token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-tun2-'));
  const file = path.join(dir, 's.png'); fs.writeFileSync(file, 'x');
  const shot = oneShotFile(file);
  const r = res();
  tunnelServe({ method: 'POST', url: shot.urlPath }, r);
  assert.equal(r.code, 405, 'a public URL that only ever reads stills');
  shot.forget();
});

test('genapi: the daily cap is a sum over recorded spend and refuses rather than warns', () => {
  const p = film();
  assert.equal(spentToday(p), 0, 'a fresh film has spent nothing');
  assert.deepEqual(checkBudget(p, 0.1), { spent: 0, cost: 0.1, cap: 2 });
  addSpend(p, 0.1);
  addSpend(p, 0.5);
  assert.equal(spentToday(p), 0.6, 'spend accumulates');
  // 1.5 more reaches the 2.00 cap exactly: allowed, because the cap is a limit not a buffer
  assert.doesNotThrow(() => checkBudget(p, 1.4));
  assert.throws(() => checkBudget(p, 1.5), /today's total is already \$0.60/);
  const err = (() => { try { checkBudget(p, 99); } catch (e) { return e; } })();
  assert.equal(err.code, 402, 'payment required, not a generic 400');
});

test('genapi: generation is off unless the user switched it on, and a key is never assumed', () => {
  const s = genSettings();
  assert.equal(s.enabled, false, 'the default spends nothing');
  assert.equal(s.dailyCapUsd, 2);
  assert.equal(s.resolution, '480p', 'the cheap tier is the default');
  assert.equal(s.i2vModel, 'heygen/heygen-video-1');
  // with no key configured the tool path says so instead of calling and failing with a 401
  assert.equal(typeof hasKey('DEEPINFRA_API_KEY'), 'boolean');
});
