// editor-v1.js — Editor V1 inside NodeCut, as a new-film option that only exists when there is a recording to edit.
//
// Editor V1 is a separate skill installed outside this repo (~/.claude/skills/editor-v1). It edits a talking-head
// recording into a fast documentary-style film. The skill has one hard input and no other: a source video. That is not a
// preference of ours, it is what the skill is — so the option is offered when a recording is supplied and is absent
// otherwise. A blank film cannot be "edited", and a toggle that would do nothing is worse than no toggle.
//
// Everything here is deliberately small and honest about failure:
//
//   detect()            is the skill actually installed and usable on this machine?
//   prepareVideo(...)   copy the recording into the film and make the Editor V1 project from it (new-video.sh)
//   runTool(...)        call one of the skill's own scripts, so the agent can drive it without guessing flags
//
// The skill's scripts are the source of truth for how an edit is built. This module never re-implements them; it starts
// them and reports what they said.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Where the skill lives. ~/.claude/skills is the one place both Claude Code and OpenCode read, so the install the setup
// instructions describe is the one found here without configuration.
export function skillDir() {
  return path.join(os.homedir(), '.claude', 'skills', 'editor-v1');
}

// The working root the skill writes videos into. Overridable so tests never touch a real person's edits.
export function editorRoot() {
  return process.env.NODECUT_EDITOR_V1_ROOT || path.join(os.homedir(), 'editor-v1');
}

const VIDEO_RE = /\.(mp4|mov|mkv|m4v|webm|avi)$/i;
export const isSourceVideo = (name) => VIDEO_RE.test(String(name || ''));

// detect() -> everything the UI needs to decide whether to offer the option, and what to say when it cannot be used.
//
// `usable` is the one field the gate keys on. It is false when the skill is missing, when its setup has not finished, or
// on a machine that cannot install the cut-out: the option must not appear to work and then fail after a film is created.
export function detect() {
  const dir = skillDir();
  const skill = path.join(dir, 'SKILL.md');
  const doctor = path.join(dir, 'scripts', 'doctor.sh');
  const venvPy = path.join(os.homedir(), '.cache', 'editor-v1', 'venv', 'bin', 'python');
  const installed = fs.existsSync(skill) && fs.existsSync(doctor);
  // The speech model and the renderer are only known to be ready by having been set up; doctor.sh is what proves it, and
  // running it from here would cost seconds on every page load. The presence of the Python environment is the cheap,
  // honest signal: the setup instructions create it, and nothing else does.
  const setup = installed && fs.existsSync(venvPy);
  const matte = setup && (() => {
    // PyTorch is only published for Apple Silicon on macOS, so on an Intel Mac the cut-out cannot exist at all. Saying so
    // once, here, is better than letting the agent try to install it on every run.
    try {
      const out = spawnSyncQuiet(venvPy, ['-c', 'import torch;print(torch.__version__)']);
      return out ? { available: true, version: out } : { available: false, reason: 'not installed' };
    } catch { return { available: false, reason: 'not installed' }; }
  })();
  return {
    id: 'editor-v1',
    name: 'Editor V1',
    installed,
    setup,
    usable: setup,
    dir,
    reason: !installed ? 'Editor V1 is not installed on this computer.'
      : !setup ? 'Editor V1 is installed but its setup has not finished (run its doctor.sh).'
        : null,
    matte,
    // The option needs a source video. Stated here so the UI and the server share one sentence and cannot disagree.
    requires: 'source video',
  };
}

// spawnSyncQuiet: a one-line answer from a program, or null. Used for version probes where a stack trace would be noise.
function spawnSyncQuiet(cmd, args, timeout = 15000) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.error || r.status !== 0) return null;
    const s = String(r.stdout || '').trim();
    return s || null;
  } catch { return null; }
}

// runScript(script, args, { cwd, timeoutMs }) -> { ok, code, stdout, stderr }
//
// Runs one of the skill's scripts under `bash` with its own environment sourced first, because the scripts expect
// EV1_PY and the PATH that env.sh sets up. Never throws: a script that fails is a result the caller reports.
export function runScript(script, args = [], { cwd = null, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const env = path.join(skillDir(), 'scripts', 'env.sh');
    const file = path.join(skillDir(), 'scripts', script);
    if (!fs.existsSync(file)) return resolve({ ok: false, code: -1, stdout: '', stderr: `No such script: ${script}` });
    const cmd = `source "${env}" && exec bash "${file}" ${args.map(shellQuote).join(' ')}`;
    let child;
    try {
      child = spawn('bash', ['-c', cmd], { cwd: cwd || skillDir(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ ok: false, code: -1, stdout: '', stderr: e.message }); }
    let out = '', errTxt = '', settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { } finish({ ok: false, code: -1, stdout: out, stderr: errTxt + '\nTimed out.' }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errTxt += d; });
    child.on('error', (e) => finish({ ok: false, code: -1, stdout: out, stderr: errTxt + e.message }));
    child.on('close', (code) => finish({ ok: code === 0, code, stdout: out, stderr: errTxt }));
  });
}

function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// prepareVideo(folder, { name, data }) -> { ok, dest, error? }
//
// Puts the recording in the film folder and builds the Editor V1 project around it. `data` is a data: URL, the same
// shape the sound upload uses, so a dropped file and a picked file take one path.
export async function prepareVideo(folder, { name, data } = {}) {
  const d = detect();
  if (!d.installed) return { ok: false, error: d.reason };
  if (!isSourceVideo(name)) return { ok: false, error: 'Editor V1 needs a video: MP4, MOV, MKV, M4V, WEBM or AVI.' };
  const m = /^data:[\w.+-]+\/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
  if (!m) return { ok: false, error: 'That file did not arrive. Try picking it again.' };
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length) return { ok: false, error: 'The video file is empty.' };
  const MAX = 4 * 1024 * 1024 * 1024;
  if (buf.length > MAX) return { ok: false, error: 'That video is larger than 4 GB. Trim it first.' };
  const src = path.join(folder, 'source', path.basename(String(name)).replace(/[\\/:*?"<>|]/g, '_'));
  try {
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, buf);
  } catch (e) { return { ok: false, error: 'Could not save the video into the film: ' + e.message }; }
  return { ok: true, dest: src };
}

// makeProject(src, name) -> runs the skill's new-video.sh, which is the only supported way to lay out an Editor V1 film.
export async function makeProject(src, name, { dir = null } = {}) {
  const args = [src, name];
  if (dir) args.push('--dir', dir);
  const r = await runScript('new-video.sh', args, { timeoutMs: 10 * 60 * 1000 });
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
}
