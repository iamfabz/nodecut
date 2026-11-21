// editor-v1-bridge.js — Editor V1's own scripts, but fed by the tools this machine already pays for.
//
// The skill is built to be free: it renders locally, its pictures come from public archives, and its sounds are
// synthesised in code. That is a good default and it stays. What it cannot make on its own is a voice, and what it can
// only make generically is moving b-roll. Both already exist in NodeCut — the ElevenLabs key saved in Settings >
// Generation, and the DeepInfra/Pruna video models — so an edit can use them instead of going without.
//
// Nothing here re-implements the skill. The bridge produces ASSETS in the shapes the skill reads (a 48 kHz mono vo.wav
// in the video folder, clips under assets/clips), then hands back to the skill's own build. If a paid tool is off, the
// bridge says so and the skill carries on with its own free path: an edit is never blocked by a missing key.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export function skillDir() { return path.join(os.homedir(), '.claude', 'skills', 'editor-v1'); }
export const VO_SAMPLE_RATE = 48000;

// ---- the rights flag a person sees before anything is built ------------------------------------------------
// Editor V1 pulls material from the open web. That is fine when a source is public domain or a free licence, and a
// liability when it is not. This is not a legal opinion and does not pretend to be one: it records where each asset came
// from and what its source says about reuse, so the person decides with the facts in front of them.

export const SOURCE_RIGHTS = {
  nasa: { safe: true, label: 'NASA — public domain' },
  commons: { safe: true, label: 'Wikimedia Commons — free licence (check the file page)' },
  archive: { safe: true, label: 'Internet Archive — public domain (check the item)' },
  mixkit: { safe: true, label: 'Mixkit — free stock, free commercial use' },
  yt: { safe: false, label: 'YouTube — check the channel: not free by default' },
  own: { safe: true, label: 'Your own recording or generated asset' },
};

export function rightsFor(src) {
  return SOURCE_RIGHTS[src] || { safe: false, label: `${src} — provenance unknown, check before publishing` };
}

// rightsSummary(assets) -> the lines shown in the plan-first screen.
export function rightsSummary(assets = []) {
  const bySrc = new Map();
  for (const a of assets) {
    const k = a.src || 'own';
    bySrc.set(k, (bySrc.get(k) || 0) + 1);
  }
  if (!bySrc.size) return { safe: true, lines: ['No outside material: this edit uses only your recording.'], unsafe: [] };
  const lines = [...bySrc].map(([src, n]) => `${n} × ${rightsFor(src).label}`);
  const unsafe = [...bySrc].filter(([src]) => !rightsFor(src).safe).map(([src, n]) => `${n} × ${rightsFor(src).label}`);
  return { safe: unsafe.length === 0, lines, unsafe };
}

// ---- voice: ElevenLabs when it is configured, the skill's silence when it is not ------------------------------------
//
// A talking-head edit already HAS a voice: the speaker's. This is for the other two cases the skill cannot serve —
// a voice-over written from a script, and a script read by a chosen voice with no recording at all. It writes the file
// the skill reads, at the sample rate it expects, so nothing downstream knows the difference.
export async function writeVoice(folder, { wav, name = 'vo.wav' } = {}) {
  if (!wav || !Buffer.isBuffer(wav) || !wav.length) return { ok: false, error: 'No audio to write.' };
  const out = path.join(folder, 'assets', 'media', name);
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, wav);
    // 48 kHz mono is what the skill's mix assumes; convert only when it is not already there, using the system ffmpeg
    const probe = await ffprobeRate(out);
    if (probe && probe !== VO_SAMPLE_RATE) {
      const tmp = out + '.48k.wav';
      const r = await ff(['-y', '-i', out, '-ar', String(VO_SAMPLE_RATE), '-ac', '1', tmp]);
      if (r.ok) fs.renameSync(tmp, out); else try { fs.unlinkSync(tmp); } catch { }
    }
    return { ok: true, file: out, rate: await ffprobeRate(out) };
  } catch (e) { return { ok: false, error: e.message }; }
}

function ffprobeRate(file) {
  return new Promise((resolve) => {
    const c = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let s = '';
    c.stdout.on('data', (d) => { s += d; });
    c.on('close', () => resolve(parseInt(String(s).trim(), 10) || null));
    c.on('error', () => resolve(null));
  });
}

function ff(args) {
  return new Promise((resolve) => {
    const c = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ ok: code === 0, stderr: err }));
    c.on('error', (e) => resolve({ ok: false, stderr: e.message }));
  });
}

// ---- b-roll: a generated clip lands where the skill already looks for clips ----------------------------------
//
// The skill draws whatever is in assets/clips. A generated clip is chosen by the edit plan like any other picture, so it
// is placed there with a name that sorts by beat, and a small manifest records that it was generated rather than found —
// which is what lets the rights line say "generated" instead of guessing.
export async function placeClip(folder, { beat, file, prompt = '', model = '' }) {
  const dir = path.join(folder, 'assets', 'clips');
  const dest = path.join(dir, `gen-${String(beat || 'b').padStart(3, '0')}.mp4`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (file && fs.existsSync(file)) fs.copyFileSync(file, dest);
    else return { ok: false, error: 'The generated clip was not found on disk.' };
    const man = path.join(dir, 'generated.json');
    let all = {};
    try { all = JSON.parse(fs.readFileSync(man, 'utf8')); } catch { }
    all[path.basename(dest)] = { beat, prompt, model, at: Date.now() };
    fs.writeFileSync(man, JSON.stringify(all, null, 2));
    return { ok: true, file: dest };
  } catch (e) { return { ok: false, error: e.message }; }
}
