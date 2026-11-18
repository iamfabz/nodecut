// Generated media: the folder and the manifest for anything a model made (plates, clips), plus the "bake" that turns a
// clip into frame atlases the film can draw.
//
// Why an atlas: the film contract (§2) makes the picture a pure function of t, and renderOut(t) must return with the
// frame already drawn. A <video> cannot be seeked synchronously, so a generated clip becomes a sprite sheet at bake
// time and the film draws one cell of it. Same rule as before, and chunked re-renders and parallel workers keep working.
//
// The layout inside the film folder — all of it NodeCut's, never the user's to hand-edit:
//
//   gen/gen.json          the asset records (append-only; one record per asset)
//   gen/plates/<id>.png   text→image output
//   gen/clips/<id>.mp4    image→video output, as delivered (sound kept or dropped at bake time)
//   gen/clips/<id>.json   probe of that clip (size, fps, duration, audio)
//   gen/atlas/<id>.json   atlas index: rows x cols, cell size, frame count, fps, sheet files
//   gen/atlas/<id>-<n>.png  one sprite sheet per page (8x8 cells each, so a long clip is several files)
//
// `gen/` is in the live preview's SKIP list: writing an atlas must never reload the page being edited.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, probe, TOOLS } from './util.js';
import { readTweaksStrict, writeTweaks, mergeTweaks, cleanGen } from './tweaks.js';

export const GEN_DIR = 'gen';
export const PLATE_DIR = 'gen/plates';
export const CLIP_DIR = 'gen/clips';
export const ATLAS_DIR = 'gen/atlas';
export const MANIFEST = 'gen/gen.json';
export const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
export const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
// absolute paths of the folders NodeCut owns inside a film
export const plateDir = p => path.join(p.path, PLATE_DIR);
export const clipDir = p => path.join(p.path, CLIP_DIR);
export const atlasDir = p => path.join(p.path, ATLAS_DIR);
export const rel = (...a) => a.join('/');

// ---- the manifest ------------------------------------------------------------------------------------------------
const readManifest = p => {
  try { const j = JSON.parse(fs.readFileSync(path.join(p.path, MANIFEST), 'utf8')); return Array.isArray(j) ? { v: 1, assets: j } : { v: 1, ...j, assets: Array.isArray(j?.assets) ? j.assets : [] }; }
  catch { return { v: 1, assets: [] }; }
};
const writeManifest = (p, m) => {
  const file = path.join(p.path, MANIFEST);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, assets: m.assets }, null, 1));
  fs.renameSync(tmp, file);
};

// One id shape for every generated file, so a stray name in gen/ can be told apart from a user's file
export const ID_RE = /^\d{8}-[a-z0-9]{6}$/;
export function newId(now = new Date()) {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${d}-${crypto.randomBytes(4).toString('hex').slice(0, 6)}`;
}

export function list(p) {
  const m = readManifest(p);
  return m.assets.map(a => ({ ...a, exists: fs.existsSync(path.join(p.path, a.file || '')) }));
}

export function get(p, id) {
  return readManifest(p).assets.find(a => a.id === id) || null;
}

// Adds a record. Never overwrites: an id that is already there is an error, because an asset is evidence of what was
// made and what it cost.
export function add(p, rec) {
  if (!rec || !ID_RE.test(String(rec.id || ''))) throw Object.assign(new Error('a generated asset needs an id like 20261116-ab12cd'), { code: 400 });
  const m = readManifest(p);
  if (m.assets.some(a => a.id === rec.id)) throw Object.assign(new Error(`asset ${rec.id} is already in gen.json`), { code: 409 });
  m.assets.push({ v: 1, made: new Date().toISOString(), ...rec });
  writeManifest(p, m);
  return rec;
}

// Records made by a run that ended badly are kept (they explain a spend), but their state is corrected in place:
// that is the one field an asset may see change after it was written.
export function fail(p, id, error) {
  const m = readManifest(p), a = m.assets.find(x => x.id === id);
  if (!a) return null;
  a.state = 'failed'; a.error = String(error || 'failed').slice(0, 400); a.failedAt = new Date().toISOString();
  writeManifest(p, m);
  return a;
}

// A generated file name is only ever resolved inside gen/: a manifest that arrived with a film (a downloaded project)
// must not be able to point the hub at any file on the PC.
export function fileOf(p, rel) {
  if (typeof rel !== 'string' || !rel) throw Object.assign(new Error('no file'), { code: 400 });
  const base = path.join(p.path, GEN_DIR), f = path.resolve(p.path, rel);
  if (f !== base && !f.startsWith(base + path.sep)) throw Object.assign(new Error('a generated file must live in gen/'), { code: 400 });
  return f;
}

// ---- baking a clip into atlases -----------------------------------------------------------------------------------
// A cell is the picture at one moment; the film picks the cell for its own time. 15 fps is smooth enough for a
// background plate and keeps a 5 s clip to 75 cells (~25 MB at 480p, much less at a cell size under 768 px wide).
export const BAKE_DEFAULTS = { fps: 15, cell: 480, cols: 8, rows: 8, maxFrames: 600 };

export function atlasPlan({ dur, fps = BAKE_DEFAULTS.fps, cols = BAKE_DEFAULTS.cols, rows = BAKE_DEFAULTS.rows, maxFrames = BAKE_DEFAULTS.maxFrames }) {
  const total = Math.max(1, Math.min(maxFrames, Math.round((+dur || 0) * fps)));
  const perPage = cols * rows;
  const pages = Math.ceil(total / perPage);
  return { fps, cols, rows, total, perPage, pages, lastCell: (total - 1) % perPage, lastRow: Math.floor(((total - 1) % perPage) / cols) };
}


// A page cannot list a folder, so the bake keeps a tiny index of which atlases exist: engine-hooks/vhatlas.js reads
// gen/atlas/index.json and nothing else to discover them.
function writeAtlasIndex(p) {
  const dir = path.join(p.path, ATLAS_DIR);
  let ids = [];
  try { ids = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json').map(f => f.slice(0, -5)).filter(id => ID_RE.test(id)); } catch { }
  ids.sort();
  try { fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ v: 1, ids }, null, 1)); } catch { }
}

// ffmpeg one-liner: take one frame every (in_fps / out_fps), scale to the cell width, tile cols×rows into a sheet.
// The pages are cut from one long tile stream, so a 40 s clip is several sheets, not one impossible canvas.
export async function bakeClip(p, id, opts = {}) {
  const rec = get(p, id);
  if (!rec) throw Object.assign(new Error(`no asset ${id}`), { code: 404 });
  if (rec.kind !== 'clip') throw Object.assign(new Error(`${id} is a ${rec.kind}, not a clip`), { code: 400 });
  const clip = fileOf(p, rec.file);
  if (!fs.existsSync(clip)) throw Object.assign(new Error(`the clip is missing: ${rec.file}`), { code: 404 });
  const info = await probe(clip);
  if (!info.ok) throw Object.assign(new Error(`${rec.file} has no video stream to bake`), { code: 400 });
  const fps = Math.min(+opts.fps || BAKE_DEFAULTS.fps, info.fps || BAKE_DEFAULTS.fps);
  const cell = Math.max(64, Math.min(1080, Math.round(+opts.cell || BAKE_DEFAULTS.cell)));
  const cellH = Math.max(2, Math.round(cell * (info.h || 9) / (info.w || 16) / 2) * 2);   // even height for the encoder
  const plan = atlasPlan({ dur: info.dur, fps, cell, cols: opts.cols, rows: opts.rows, maxFrames: opts.maxFrames });

  const outDir = path.join(p.path, ATLAS_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  // old pages of this id are replaced wholesale: a re-bake may need fewer pages than the last one
  for (const f of fs.readdirSync(outDir)) if (f.startsWith(id + '-') || f === id + '.json') try { fs.unlinkSync(path.join(outDir, f)); } catch { }

  const pattern = path.join(outDir, `${id}-%02d.png`);
  const args = [
    '-y', '-loglevel', 'error', '-i', clip,
    '-an',                                                                        // the film's sound is its own: no provider audio
    '-vf', `fps=${fps},scale=${cell}:${cellH}:flags=lanczos,tile=${plan.cols}x${plan.rows}`,
    '-f', 'image2', '-start_number', '0', pattern,
  ];
  const r = await run(TOOLS.ffmpeg, args);
  if (r.code !== 0) throw Object.assign(new Error(`ffmpeg could not tile ${rec.file}: ${(r.stderr || '').trim().split('\n').pop()}`), { code: 400 });

  const sheets = fs.readdirSync(outDir).filter(f => f.startsWith(id + '-') && f.endsWith('.png')).sort()
    .map(f => ({ file: rel(ATLAS_DIR, f), size: fs.statSync(path.join(outDir, f)).size }));
  if (!sheets.length) throw Object.assign(new Error('ffmpeg produced no atlas sheets'), { code: 400 });

  const index = {
    v: 1, id, cell, cellW: cell, cellH, cols: plan.cols, rows: plan.rows, fps, total: plan.total, pages: sheets.length,
    srcW: info.w, srcH: info.h, srcDur: info.dur, srcFps: info.fps, audio: info.audio,
    sheets: sheets.map(s => s.file), bytes: sheets.reduce((n, s) => n + s.size, 0),
    madeAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, id + '.json'), JSON.stringify(index, null, 1));
  writeAtlasIndex(p);
  return index;
}

export function readAtlas(p, id) {
  if (!ID_RE.test(String(id || ''))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(p.path, ATLAS_DIR, id + '.json'), 'utf8')); } catch { return null; }
}

// ---- importing a file the user already has ------------------------------------------------------------------------
// Step 1 of the feature: no API, no key, no spend. A still or a clip dropped into the film is copied into gen/,
// recorded, and (for a clip) baked, so everything the later generation steps produce travels the same path.
export async function importFile(p, { file, name, prompt = '', source = 'import', kind }) {
  if (!file) throw Object.assign(new Error('which file?'), { code: 400 });
  const src = path.resolve(file);
  let st; try { st = fs.statSync(src); } catch { throw Object.assign(new Error(`no such file: ${file}`), { code: 404 }); }
  if (!st.isFile()) throw Object.assign(new Error('that is a folder'), { code: 400 });
  const isVid = VIDEO_EXT.test(src), isImg = IMAGE_EXT.test(src);
  if (!isVid && !isImg) throw Object.assign(new Error('Give it a PNG, JPEG, WEBP or an MP4/MOV/WEBM clip'), { code: 400 });
  const k = kind || (isVid ? 'clip' : 'plate');
  const id = newId();
  const destDir = path.join(p.path, k === 'clip' ? CLIP_DIR : PLATE_DIR);
  fs.mkdirSync(destDir, { recursive: true });
  const ext = path.extname(src).toLowerCase();
  const fileName = `${id}${ext}`;
  const dest = path.join(destDir, fileName);
  if (!dest.startsWith(path.join(p.path, GEN_DIR) + path.sep)) throw Object.assign(new Error('refusing to write outside gen/'), { code: 400 });
  fs.copyFileSync(src, dest);
  const fileRel = rel(k === 'clip' ? CLIP_DIR : PLATE_DIR, fileName);

  const rec = { id, kind: k, state: 'ready', file: fileRel, name: String(name || path.basename(src)).slice(0, 120), prompt: String(prompt || '').slice(0, 2000), source, provider: null, cost: 0 };
  // the record goes in first: the bake looks the asset up in gen.json, and an asset that was copied in is worth
  // recording even if its bake then fails (that is what bakeError is for)
  add(p, rec);
  if (k === 'clip') {
    try { await bakeClip(p, id, {}); rec.baked = true; }
    catch (e) { rec.baked = false; rec.bakeError = String(e.message || e).slice(0, 300); }
  }
  const at = readAtlas(p, id);
  if (at) rec.atlas = rel(ATLAS_DIR, id + '.json');
  if (rec.baked !== undefined || rec.atlas) {
    // only the fields the bake settled are updated; the manifest itself is append-only for everything else
    const m = readManifest(p), a = m.assets.find(x => x.id === id);
    if (a) { Object.assign(a, { baked: !!rec.baked, atlas: rec.atlas, bakeError: rec.bakeError }); writeManifest(p, m); }
  }
  return { ...rec, atlasInfo: at || null };
}

// ---- routes -------------------------------------------------------------------------------------------------------
export function routes(route, project, readBody) {
  const need = (id) => { const p = project(id); if (!p) throw Object.assign(new Error('project not found'), { code: 404 }); return p; };
  route('GET', '/api/gen/:id', (req, url, { id }) => {
    const p = need(id);
    const assets = list(p).map(a => ({ ...a, atlasInfo: a.kind === 'clip' && a.baked ? readAtlas(p, a.id) : null }));
    return { assets, bytes: assets.reduce((n, a) => n + (a.atlasInfo?.bytes || 0), 0) };
  });
  route('GET', '/api/gen/:id/atlas/:asset', (req, url, { id, asset }) => {
    const p = need(id), at = readAtlas(p, asset);
    if (!at) throw Object.assign(new Error('no atlas for ' + asset), { code: 404 });
    return at;
  });
  route('POST', '/api/gen/:id/import', async (req, url, { id }) => importFile(need(id), await readBody(req)));
  // where generated clips play: the timeline lane and the film both read these placements
  route('GET', '/api/gen/:id/placements', (req, url, { id }) => {
    const p = need(id);
    const assets = new Map(list(p).map(a => [a.id, a]));
    return { gen: placements(p).map(e => ({ ...e, label: assets.get(e.id)?.name || e.id, baked: !!assets.get(e.id)?.baked, dur: Math.round((e.t1 - e.t0) * 100) / 100 })) };
  });
  route('POST', '/api/gen/:id/place', async (req, url, { id }) => {
    const p = need(id), b = await readBody(req);
    return place(p, { id: b.asset, t0: b.t0, t1: b.t1, op: b.op ?? 1, fit: b.fit || 'cover', filmDur: b.filmDur });
  });
  route('PATCH', '/api/gen/:id/place/:asset', async (req, url, { id, asset }) => {
    const p = need(id), b = await readBody(req);
    const cur = placements(p), e = cur.find(q => q.id === asset);
    if (!e) throw Object.assign(new Error(`no placement for ${asset}`), { code: 404 });
    return place(p, { id: asset, t0: b.t0 ?? e.t0, t1: b.t1 ?? e.t1, op: b.op ?? e.op ?? 1, fit: b.fit ?? e.fit ?? 'cover' });
  });
  route('DELETE', '/api/gen/:id/place/:asset', async (req, url, { id, asset }) => {
    const p = need(id);
    const rest = placements(p).filter(q => q.id !== asset);
    const out = mergeTweaks(readTweaksStrict(path.join(p.path, 'tweaks.json')), { gen: rest }, {});
    writeTweaks(path.join(p.path, 'tweaks.json'), out);
    return { gen: out.gen || [] };
  });
  route('POST', '/api/gen/:id/bake', async (req, url, { id }) => {
    const p = need(id), body = await readBody(req);
    const at = await bakeClip(p, body.asset, body);
    const m = readManifest(p), a = m.assets.find(x => x.id === body.asset);
    if (a) { a.baked = true; a.atlas = rel(ATLAS_DIR, body.asset + '.json'); delete a.bakeError; writeManifest(p, m); }
    return at;
  });
}



// ---- placing a generated clip on the timeline ---------------------------------------------------------------
// A clip is drawn because tweaks.json says where it plays, not because film.js was edited. The film reads the same file
// (engine-hooks/vhatlas.js), so generating a clip and seeing it on the timeline are one action.

const tweaksFile = p => path.join(p.path, 'tweaks.json');

// Where a new clip goes when nobody says otherwise: after the last one, or the first free moment that fits. It never
// overlaps an existing placement, so adding a clip cannot silently hide one the user already has.
export function nextSlot(existing, dur, filmDur) {
  const list = cleanGen(existing || []);
  const start = list.length ? Math.max(...list.map(e => e.t1)) : 0;
  const t0 = Math.max(0, Math.min(start, Math.max(0, filmDur - dur)));
  return { t0: +t0.toFixed(3), t1: +(t0 + dur).toFixed(3) };
}

// Add (or replace, when the same asset is placed twice) one placement and return the new list.
export function place(p, { id, t0, t1, op = 1, fit = 'cover', filmDur } = {}) {
  if (!/^\d{8}-[a-z0-9]{6}$/.test(String(id || ''))) throw Object.assign(new Error('a placement needs a generated asset id'), { code: 400 });
  const file = tweaksFile(p);
  const cur = readTweaksStrict(file);
  const list = cleanGen(cur.gen || []);
  const dur = Number.isFinite(+t1) && Number.isFinite(+t0) ? +t1 - +t0 : 5;
  const when = Number.isFinite(+t0) ? { t0: +t0, t1: +t1 } : nextSlot(list, Math.max(0.1, dur), +filmDur || 10);
  const rec = { id, ...when, op, ...(fit === 'contain' ? { fit } : {}) };
  // A drag moves the bar it grabbed (same asset, same start), so that placement is replaced. The same clip CAN be placed
  // at a different time — a 5 s clip covering two beats is a normal cut, and refusing it silently lost one.
  const i = list.findIndex(e => e.id === id && Math.abs(e.t0 - when.t0) < 0.001);
  if (i >= 0) list[i] = rec; else list.push(rec);
  const out = mergeTweaks(cur, { gen: list }, {});
  writeTweaks(file, out);
  return { placed: rec, gen: out.gen || [] };
}

export function placements(p) {
  try { return cleanGen(readTweaksStrict(tweaksFile(p)).gen || []); } catch { return []; }
}
