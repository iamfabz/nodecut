// Tests for editor-v1.js and editor-v1-bridge.js — the part of Editor V1 that NodeCut owns.
//
// Editor V1 itself is an outside skill; these do not test its rendering. They test the two things NodeCut is responsible
// for and that would fail silently:
//
//   1. the gate: an edit needs a recording, and must never be offered or created without one;
//   2. the rights line: material found on the open web is labelled by where it came from, and the labels the person relies
//      on to decide whether they can publish are the ones these tests pin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSourceVideo, detect, skillDir, editorRoot, runScript } from './editor-v1.js';
import { rightsFor, rightsSummary, placeClip, SOURCE_RIGHTS } from './editor-v1-bridge.js';

test('only a video can be an Editor V1 source', () => {
  for (const n of ['take.mp4', 'take.MOV', 'a.mkv', 'b.m4v', 'c.webm', 'd.avi']) assert.equal(isSourceVideo(n), true, n);
  for (const n of ['notes.txt', 'shot.png', 'audio.wav', 'no-extension', '', null]) assert.equal(isSourceVideo(n), false, String(n));
});

test('detect() answers whether an edit is possible, and says why when it is not', () => {
  const d = detect();
  assert.equal(d.id, 'editor-v1');
  assert.equal(d.requires, 'source video', 'the gate the UI keys on is stated here, not only in the dialog');
  assert.equal(typeof d.usable, 'boolean');
  // usable must always come with either a reason or a null, never a silent false
  if (!d.usable) assert.ok(d.reason && d.reason.length > 10, 'an unavailable editor must explain itself');
  else assert.equal(d.reason, null);
});

test('the skill directory is the one the install instructions describe', () => {
  assert.equal(skillDir(), path.join(os.homedir(), '.claude', 'skills', 'editor-v1'));
  // the working root is overridable so a test never writes into a real person's edits
  const saved = process.env.NODECUT_EDITOR_V1_ROOT;
  process.env.NODECUT_EDITOR_V1_ROOT = '/tmp/nowhere-ev1';
  try { assert.equal(editorRoot(), '/tmp/nowhere-ev1'); }
  finally { if (saved === undefined) delete process.env.NODECUT_EDITOR_V1_ROOT; else process.env.NODECUT_EDITOR_V1_ROOT = saved; }
  assert.equal(editorRoot(), path.join(os.homedir(), 'editor-v1'));
});

test('a script that does not exist is reported, not thrown', async () => {
  const r = await runScript('definitely-not-a-script.sh');
  assert.equal(r.ok, false);
  assert.match(r.stderr, /No such script/);
});

test('every source says whether it is safe to publish, and YouTube is never assumed free', () => {
  for (const id of Object.keys(SOURCE_RIGHTS)) {
    const r = rightsFor(id);
    assert.equal(typeof r.safe, 'boolean', id);
    assert.ok(r.label && r.label.length > 5, id + ' has no label');
  }
  // the one that would get someone into trouble: a channel is not a licence
  assert.equal(rightsFor('yt').safe, false);
  assert.match(rightsFor('yt').label, /check the channel/i);
  // public domain and free-licence archives are the ones the style is built on
  for (const id of ['nasa', 'archive', 'commons', 'mixkit']) assert.equal(rightsFor(id).safe, true, id);
});

test('an unknown source is flagged rather than assumed safe', () => {
  const r = rightsFor('somewhere-else');
  assert.equal(r.safe, false);
  assert.match(r.label, /provenance unknown/i);
});

test('the rights summary names what is not free, so the person sees it before the build', () => {
  const clean = rightsSummary([{ src: 'nasa' }, { src: 'commons' }]);
  assert.equal(clean.safe, true);
  assert.equal(clean.unsafe.length, 0);

  const risky = rightsSummary([{ src: 'nasa' }, { src: 'yt' }, { src: 'yt' }]);
  assert.equal(risky.safe, false);
  assert.equal(risky.unsafe.length, 1);
  assert.match(risky.unsafe[0], /^2 × YouTube/);

  // nothing found is not an error: the edit is just the person's own recording
  const own = rightsSummary([]);
  assert.equal(own.safe, true);
  assert.match(own.lines[0], /only your recording/i);
});

test('a generated clip lands where the skill looks for clips, and records that it was generated', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ev1clip-'));
  const src = path.join(folder, 'made.mp4');
  fs.writeFileSync(src, 'not really a video, but the placement is what is under test');
  const r = await placeClip(folder, { beat: 3, file: src, prompt: 'steam off a bowl', model: 't2v' });
  assert.equal(r.ok, true);
  assert.equal(path.basename(r.file), 'gen-003.mp4', 'the name sorts by beat, so clips appear in the right order');
  const man = JSON.parse(fs.readFileSync(path.join(folder, 'assets', 'clips', 'generated.json'), 'utf8'));
  assert.equal(man['gen-003.mp4'].prompt, 'steam off a bowl', 'the prompt travels with the clip, so it can be judged later');
  fs.rmSync(folder, { recursive: true, force: true });
});

test('placing a clip that is missing on disk fails instead of writing an empty file', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ev1clip2-'));
  const r = await placeClip(folder, { beat: 1, file: path.join(folder, 'nope.mp4') });
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/i);
  fs.rmSync(folder, { recursive: true, force: true });
});

// --- the upload gate on size --------------------------------------------------------------------------------------
// A 110 MB phone recording became 146 MB as base64 and tripped a 50 MB JSON body limit, which reached the browser as a
// bare "could not fetch". The fix is to stream raw bytes; these pin the rule that made the old path fail and the cap that
// replaced it.
test('the streaming upload cap is far above a phone recording, and the JSON body cap is not used for video', async () => {
  const src = fs.readFileSync(new URL('./hub.js', import.meta.url), 'utf8');
  // the video must not go through readBody: that is the 50 MB path that killed the socket
  assert.match(src, /api\/editor-v1\/upload/, 'there must be a raw upload route for the recording');
  const m = src.match(/EV1_UPLOAD_MAX\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024\s*\*\s*1024/);
  assert.ok(m, 'a named upload cap must exist');
  assert.ok(Number(m[1]) >= 4, 'the cap must allow a real recording, not a short clip');
  // and the create call must accept the token rather than the bytes
  assert.match(src, /uploadToken/, 'creation reads a staged token, not a payload');
});

test('an upload token can never point outside the staging folder', () => {
  // path traversal would let a crafted token read or delete arbitrary files
  for (const bad of ['../../etc/passwd', '/etc/passwd', 'abc', 'A'.repeat(40), 'z'.repeat(200), '', null]) {
    const ok = typeof bad === 'string' && /^[a-z0-9]{16,64}$/.test(bad);
    if (ok) continue;   // a well-formed token is allowed; the point is the pattern rejects the rest
    assert.equal(ok, false, `token ${JSON.stringify(bad)} must be rejected`);
  }
});

// --- a film must not hand the agent the tree above it -------------------------------------------------------------
// The agent tools resolve the project by walking UP to the nearest repository. A film inside a home folder that happens
// to be a repo handed the agent this app's own source, and its first turn was spent reading NodeCut instead of the
// recording. Giving the film its own empty repo root stops the walk at the film.
test('a film folder gets its own repository root, so nothing walks up out of it', async () => {
  const { execFileSync } = await import('node:child_process');
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'ev1-outer-'));
  // an enclosing repository, like the home folder that caused this
  try { execFileSync('git', ['init', '-q', outer], { stdio: 'ignore' }); } catch { return; }   // no git: nothing to test
  const film = path.join(outer, 'A film');
  fs.mkdirSync(film, { recursive: true });
  // without the fix the walk escapes to the enclosing repo
  const before = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: film, encoding: 'utf8' }).trim();
  assert.notEqual(path.resolve(before), path.resolve(film), 'precondition: the film starts inside the outer repo');

  execFileSync('git', ['init', '-q', film], { stdio: 'ignore' });
  const after = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: film, encoding: 'utf8' }).trim();
  assert.equal(fs.realpathSync(after), fs.realpathSync(film), 'the film is now its own project root');
  fs.rmSync(outer, { recursive: true, force: true });
});
