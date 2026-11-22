// Editor V1 rendering from NodeCut's own Render button.
//
// An Editor V1 film has no render.js: its page is the film and the HyperFrames tool renders that page. Two things are
// tested here, both learned from real failures rather than imagined:
//
//   1. recognising an Editor V1 film, so the button is offered at all;
//   2. refusing a black render. The film that prompted this rendered 67 seconds of black and reported success, because
//      the renderer exits 0 with a file when its page is refused. A render nobody can watch is a failed render.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEditorV1Film, pictureLuma } from './editor-v1-render.js';

function film({ hook = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ev1-render-'));
  fs.writeFileSync(path.join(dir, 'index.html'), hook
    ? '<script>window.renderOut=function(){};window.READY=true;</script>'
    : '<script>// a page with no live hook</script>');
  fs.writeFileSync(path.join(dir, 'build.py'), '# the film is built from this\n');
  return dir;
}

test('an Editor V1 film is recognised by its hook and its build', () => {
  const dir = film();
  try { assert.equal(isEditorV1Film(dir), true); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a page without the live hook is not an Editor V1 film, so nothing offers to render it', () => {
  const dir = film({ hook: false });
  try { assert.equal(isEditorV1Film(dir), false); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a folder that is not a film at all is not one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ev1-plain-'));
  try { assert.equal(isEditorV1Film(dir), false); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- a black render is a failure, not a quiet success -----------------------------------------------
// The exact bug: the agent reported "Render done" over 67 s of black, because the renderer had written a file. Measuring
// the picture is what separates "a file exists" from "the film is watchable".
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const hasFfmpeg = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;

test('a black render measures as black', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ev1-black-'));
  const file = path.join(dir, 'black.mp4');
  try {
    const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-nostats', '-f', 'lavfi', '-i', 'color=black:s=160x90:d=3:r=15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
    if (made.status !== 0) return;                     // this ffmpeg has no libx264: nothing to measure
    const luma = await pictureLuma(file, ffmpeg);
    assert.ok(luma, 'a measurable picture');
    assert.ok(luma.max < 30, `black must measure black (max ${luma.max})`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real footage does not measure as black', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ev1-grey-'));
  const file = path.join(dir, 'grey.mp4');
  try {
    const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-nostats', '-f', 'lavfi', '-i', 'color=#808080:s=160x90:d=3:r=15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
    if (made.status !== 0) return;
    const luma = await pictureLuma(file, ffmpeg);
    assert.ok(luma && luma.max > 60, `a mid-grey frame is a picture (max ${luma && luma.max})`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file that cannot be measured says so instead of guessing', async () => {
  assert.equal(await pictureLuma('/definitely/not/a/video.mp4', ffmpeg), null);
});
