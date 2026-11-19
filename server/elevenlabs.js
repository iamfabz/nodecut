// ElevenLabs audio: a voice-over, a music bed, or a single sound effect, written into a film's audio folder.
//
// This is the only place NodeCut asks for sound rather than pictures, and it exists because a film with no audio is half a
// film. Three endpoints, three different response shapes, all normalised into one WAV or MP3 on disk so the rest of the
// studio does not need to know which one produced it:
//
//   voiceover   POST /v1/text-to-speech/{voice_id}          -> audio bytes directly
//   music       POST /v1/music                              -> audio bytes directly
//   sfx         POST /v1/sound-generation                   -> audio bytes directly
//
// Nothing here runs on its own. Every call is made because the person pressed something, the key stays on this machine,
// and the result is a file next to the film — never uploaded anywhere else.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { isInside, run, TOOLS } from './util.js';

export const API = 'https://api.elevenlabs.io';
export const keyOf = () => process.env.ELEVENLABS_API_KEY || (config().generation?.keys || {}).ELEVENLABS_API_KEY || '';
export const hasKey = () => !!keyOf();

// A film's audio lives beside it, in audio/. Anything else is refused: a path from a request must never decide where a
// file lands.
export const audioDirOf = (project) => path.join(project.path, 'audio');

// safeName(text) -> a file name that cannot escape the folder on any platform
export function safeName(text, fallback = 'take') {
  const s = String(text == null ? '' : text)
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')   // separators and characters Windows/macOS refuse
    .replace(/\s+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

// The output format is deliberately NOT pinned. ElevenLabs only allows some formats on some plans — mp3_44100_192 is
// Creator tier and above, and asking for it on a smaller plan fails with a 403 that reads like a broken key. Omitting the
// query parameter gets whatever the account is entitled to, which is always something that works.
//
// The three requests, as data. Kept as pure functions so the body that goes on the wire can be asserted without a network
// call — the same approach the generation tests already use.
export function voiceoverRequest({ text, voiceId, modelId = 'eleven_multilingual_v2', stability = 0.5, similarity = 0.75 }) {
  if (!text || !String(text).trim()) throw Object.assign(new Error('There is no text to speak.'), { code: 400 });
  if (!voiceId) throw Object.assign(new Error('Pick a voice first.'), { code: 400 });
  return {
    url: `${API}/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    body: { text: String(text), model_id: modelId, voice_settings: { stability, similarity_boost: similarity } },
  };
}

export function musicRequest({ prompt, lengthMs = 30000 }) {
  if (!prompt || !String(prompt).trim()) throw Object.assign(new Error('Describe the music you want.'), { code: 400 });
  return {
    url: `${API}/v1/music`,
    body: { prompt: String(prompt), music_length_ms: Math.max(3000, Math.min(300000, Math.round(+lengthMs || 30000))) },
  };
}

export function sfxRequest({ prompt, durationSec = null }) {
  if (!prompt || !String(prompt).trim()) throw Object.assign(new Error('Describe the sound you want.'), { code: 400 });
  const body = { text: String(prompt), prompt_influence: 0.3 };
  if (durationSec) { body.duration_seconds = Math.max(0.5, Math.min(22, +durationSec)); }
  return { url: `${API}/v1/sound-generation`, body };
}

// request(kind, opts) -> the wire request for one of the three kinds, or a clear error naming the kind.
export function request(kind, opts) {
  if (kind === 'voiceover') return voiceoverRequest(opts);
  if (kind === 'music') return musicRequest(opts);
  if (kind === 'sfx') return sfxRequest(opts);
  throw Object.assign(new Error(`Unknown audio kind "${kind}".`), { code: 400 });
}

// The extension the API returns. ElevenLabs sends MP3 by default for speech and MP3 for music/sfx; the render mux takes
// whatever ffmpeg can read, so the exact container matters less than being honest about it.
export const extFor = (contentType = '') => /mpeg|mp3/i.test(contentType) ? 'mp3' : /wav/i.test(contentType) ? 'wav' : 'mp3';

// make(project, kind, opts) -> { file, rel, bytes }. Writes the audio into the film and returns where it landed.
// The hub only calls this after the person pressed the button; there is no background spending here.
export async function make(project, kind, opts = {}) {
  const key = keyOf();
  if (!key) throw Object.assign(new Error('No ElevenLabs key is saved. Add one in Settings → Generation.'), { code: 400 });
  const req = request(kind, opts);

  const res = await fetch(req.url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify(req.body),
    // enough for a long voice-over; the point is not to hang forever on a dead connection
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    // ElevenLabs explains refusals well (bad key, quota, an empty voice list). Pass its words through rather than
    // replacing them with a status number the user cannot act on.
    let detail = '';
    try { const j = await res.json(); detail = j?.detail?.message || j?.detail || j?.message || ''; } catch { }
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
    const msg = res.status === 401 ? 'ElevenLabs refused the key. Check it in Settings → Generation.'
      : res.status === 429 ? 'ElevenLabs is rate limiting or the account is out of credits.'
        : detail || `ElevenLabs returned ${res.status}.`;
    throw Object.assign(new Error(msg), { code: res.status === 401 ? 400 : 502 });
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw Object.assign(new Error('ElevenLabs returned an empty file.'), { code: 502 });

  const dir = audioDirOf(project);
  fs.mkdirSync(dir, { recursive: true });
  const base = safeName(opts.name || `${kind}-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`);
  const ext = extFor(res.headers.get('content-type') || '');
  let file = path.join(dir, `${base}.${ext}`);
  // never overwrite a take: a second recording of the same name gets a number, so a good take cannot be lost
  for (let n = 2; fs.existsSync(file) && n < 100; n++) file = path.join(dir, `${base}-${n}.${ext}`);
  if (!isInside(file, dir)) throw Object.assign(new Error('That name cannot be used for a file.'), { code: 400 });
  fs.writeFileSync(file, buf);
  return { file, rel: path.relative(project.path, file).split(path.sep).join('/'), bytes: buf.length, kind };
}

// toWav(file) -> a WAV next to the file, via ffmpeg. The film mix is a WAV, so anything that is going to be mixed in has
// to become one; converting here keeps the eleven different audio sources out of the render path.
export async function toWav(file) {
  if (/\.wav$/i.test(file)) return file;
  const out = file.replace(/\.[^.]+$/, '') + '.wav';
  const r = await run(TOOLS.ffmpeg, ['-y', '-i', file, '-ar', '44100', '-ac', '2', out]);
  if (r && r.code) throw Object.assign(new Error('Could not convert the audio to WAV: ' + String(r.stderr || '').slice(-300)), { code: 500 });
  return out;
}

// ---- the HTTP surface ---------------------------------------------------------------------------------------
// Kept in the same shape as the other modules: routes(route, project, readBody).
export function routes(route, project, readBody) {
  const need = (id) => { const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 }); return p; };

  // what the tab needs before offering a button: whether a key is saved, and what is already in the film's audio folder
  route('GET', '/api/project/:id/audio', (req, url, { id }) => {
    const p = need(id);
    const dir = audioDirOf(p);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter(f => /\.(mp3|wav|m4a|ogg)$/i.test(f))
        .map(f => ({ name: f, rel: 'audio/' + f, bytes: fs.statSync(path.join(dir, f)).size }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { }
    return { hasKey: hasKey(), files };
  });

  // make one piece of audio. kind is voiceover | music | sfx; everything else in the body is passed through.
  route('POST', '/api/project/:id/audio/:kind', async (req, url, { id, kind }) => {
    const p = need(id);
    const body = await readBody(req);
    const out = await make(p, kind, body || {});
    // the film's mix is a WAV, so a generated mp3 is converted here rather than making every later step deal with it.
    let wav = null;
    try { wav = await toWav(out.file); } catch { /* keep the original: better a playable mp3 than nothing */ }
    return { ok: true, ...out, wav: wav ? path.relative(p.path, wav).split(path.sep).join('/') : null };
  });

  // the voices this key can use, so the panel offers a real list instead of asking for a voice id
  route('GET', '/api/audio/voices', async () => {
    const key = keyOf();
    if (!key) return { voices: [], hasKey: false };
    try {
      const res = await fetch(`${API}/v1/voices`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) return { voices: [], hasKey: true, error: res.status === 401 ? 'The key was refused.' : `ElevenLabs returned ${res.status}.` };
      const j = await res.json();
      return { hasKey: true, voices: (j.voices || []).map(v => ({ id: v.voice_id, name: v.name, category: v.category || '' })) };
    } catch (e) {
      return { voices: [], hasKey: true, error: 'Could not reach ElevenLabs: ' + e.message };
    }
  });
}
