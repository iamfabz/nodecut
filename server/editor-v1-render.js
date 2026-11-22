// editor-v1-render.js — render an Editor V1 film from NodeCut's own Render button.
//
// An Editor V1 film has no render.js. Its page (index.html) is the film, and the HyperFrames tool renders that page;
// then finish.sh lays the sound under the picture. Without this module NodeCut could only say "ask the agent", so a
// finished edit could be watched but not re-rendered from the app — which is most of the point of an editor.
//
// The sequence is the skill's own, in the order its build.py documents:
//
//     hf lint .                              -> catches a page the renderer will refuse
//     hf render . -q high -f 30 -o <file>    -> picture only (hasAudio: false)
//     bash scripts/finish.sh .                -> picture + mix + sfx into out/final.mp4
//
// Nothing here re-implements the skill. It starts the skill's own tools and reports what they said. Two things it does
// add, both learning from real failures:
//
//   1. lint before render. A page the renderer refuses fail-closes to a black film that still looks like a success.
//   2. check the picture after render. A black film is a failed render, not a quiet one.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { skillDir } from './editor-v1.js';

const HF_VERSION = process.env.HF_VERSION || '0.8.181';

// An Editor V1 film is one whose page defines the live hook and that has a build.py: that pair is what makes it an
// Editor V1 film rather than any other page-based project.
export function isEditorV1Film(folder) {
  try {
    const html = fs.readFileSync(path.join(folder, 'index.html'), 'utf8');
    return html.includes('window.renderOut') && fs.existsSync(path.join(folder, 'build.py'));
  } catch { return false; }
}

// Mean luma of a video, sampled across it: a black or empty render is a failure, and it used to be reported as done.
// Returns null when it cannot be measured, so the caller can say "unchecked" rather than guess.
export async function pictureLuma(file, ffmpeg = 'ffmpeg') {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vf', 'fps=0.2,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return resolve(null); }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const vals = [...out.matchAll(/YAVG=([\d.]+)/g)].map((m) => +m[1]);
      if (!vals.length) return resolve(null);
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const max = Math.max(...vals);
      resolve({ avg: +avg.toFixed(1), max: +max.toFixed(1), samples: vals.length });
    });
  });
}

// A film that never rises above this is black. Real footage of any kind has bright frames somewhere.
const BLACK_MAX = 30;

// Run one skill command with the skill's environment sourced. `hf` is a shell function defined by env.sh, so it only
// exists inside a shell that sourced it: calling `npx hyperframes` directly is what makes it work from here.
function runShell(folder, cmd, { timeoutMs = 60 * 60 * 1000, onLine } = {}) {
  return new Promise((resolve) => {
    const env = path.join(skillDir(), 'scripts', 'env.sh');
    const full = `source "${env}" 2>/dev/null; cd "${folder}"; ${cmd}`;
    let child;
    try { child = spawn('bash', ['-c', full], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, code: -1, out: '', err: e.message }); }
    let out = '', err = '', settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { } finish({ ok: false, code: -1, out, err: err + '\nTimed out.' }); }, timeoutMs);
    const feed = (chunk, isErr) => {
      const s = chunk.toString();
      if (isErr) err += s; else out += s;
      if (onLine) for (const line of s.split('\n')) if (line.trim()) try { onLine(line.trim()); } catch { }
    };
    child.stdout.on('data', (d) => feed(d, false));
    child.stderr.on('data', (d) => feed(d, true));
    child.on('error', (e) => finish({ ok: false, code: -1, out, err: err + e.message }));
    child.on('close', (code) => finish({ ok: code === 0, code, out, err }));
  });
}

// The last meaningful line a tool printed: its own words read better than an exit code.
function lastLine(s) {
  const lines = String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
  // skip progress bars and box-drawing noise
  const good = lines.filter((l) => !/^[█▌▏⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏▸▹›»·\s-]+$/.test(l) && !/^\s*[█▌]+\s*\d+%/.test(l));
  return (good[good.length - 1] || lines[lines.length - 1] || '').slice(0, 300);
}

// render(folder, { output, fps, quality, onLine }) -> { ok, output, error?, picture? }
//
// `output` is relative to the film folder. The film's own finish.sh turns the picture into out/final.mp4, which is the
// file NodeCut shows as the film, so the finished result is reported separately from the raw picture.
export async function render(folder, { output = 'out/render.mp4', fps = 30, quality = 'high', onLine = null } = {}) {
  if (!isEditorV1Film(folder)) return { ok: false, error: 'This is not an Editor V1 film (no index.html with a live hook and no build.py).' };
  if (!fs.existsSync(path.join(folder, 'index.html'))) return { ok: false, error: 'The film has no page to render: run its build first.' };

  const say = (s) => { try { onLine?.(s); } catch { } };

  // 1. lint: a page the renderer refuses is caught here, cheaply, instead of becoming a black film
  say('Checking the page');
  const lint = await runShell(folder, `npx -y hyperframes@${HF_VERSION} lint . 2>&1`, { timeoutMs: 5 * 60 * 1000 });
  const lintText = (lint.out + lint.err);
  const errCount = /(\d+)\s+error\(s\)/.exec(lintText);
  if (errCount && +errCount[1] > 0) {
    const first = lintText.split('\n').find((l) => /error/i.test(l) && !/error\(s\)/.test(l)) || '';
    return { ok: false, error: `The page has ${errCount[1]} error(s) the renderer will refuse; fix them before rendering. ${first.trim().slice(0, 200)}` };
  }

  // 2. picture
  say(`Rendering (${fps} fps)`);
  fs.mkdirSync(path.join(folder, path.dirname(output)), { recursive: true });
  const pic = await runShell(folder, `npx -y hyperframes@${HF_VERSION} render . -q ${quality} -f ${fps} -o ${JSON.stringify(output)} 2>&1`, {
    timeoutMs: 90 * 60 * 1000,
    onLine: (l) => { if (/%|Rendering|frame/i.test(l)) say(l.slice(0, 160)); },
  });
  const dest = path.join(folder, output);
  if (!pic.ok || !fs.existsSync(dest)) {
    return { ok: false, error: `The renderer failed: ${lastLine(pic.err || pic.out) || `exit ${pic.code}`}`, log: (pic.out + pic.err).slice(-4000) };
  }

  // 3. is there a picture at all? A black film is a failed render that still exits 0.
  say('Checking the picture');
  const luma = await pictureLuma(dest, process.env.FFMPEG || 'ffmpeg');
  if (luma && luma.max < BLACK_MAX) {
    return { ok: false, error: `The render came out black (brightest frame ${luma.max}), so it is not a usable film.`, output, picture: luma };
  }

  // 4. sound: finish.sh writes out/final.mp4 and leaves audio/mix.wav for the live preview
  say('Adding the sound');
  const fin = await runShell(folder, 'bash "$HOME/.claude/skills/editor-v1/scripts/finish.sh" . 2>&1', { timeoutMs: 30 * 60 * 1000 });
  const finalFile = path.join(folder, 'out', 'final.mp4');
  if (!fin.ok || !fs.existsSync(finalFile)) {
    // the picture is real and on disk: say so, rather than reporting the whole render as a failure
    return {
      ok: true, output, final: null, picture: luma,
      warning: `The picture rendered, but the sound step failed: ${lastLine(fin.err || fin.out) || 'no output'}`,
    };
  }
  const st = fs.statSync(finalFile);
  return { ok: true, output, final: 'out/final.mp4', finalBytes: st.size, picture: luma };
}
