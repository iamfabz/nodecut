// The film's scenes/shots ({name, t0, t1} in film seconds) for the review timeline's scene lane.
// The live preview reads them from the page (ui/review/scenes.js: VH_SCENES, SHOTS, EVENTS.shots + PIECES, __qaShotAt)
// and stores them here (<project>/.nodecut/scenes.json), so a rendered video of the same film shows them too.
// Without a stored list: data/shots.json (spotlight `render.js cues`), shots.json at the top.
import fs from 'node:fs';
import path from 'node:path';
import { project } from './scan.js';
import { readJson, writeJson } from './util.js';

const file = (p) => path.join(p.path, '.nodecut', 'scenes.json');
// One still per scene, for the outline beside the preview. Keyed by the scene's start time (rounded to the
// millisecond) so reordering or renaming scenes keeps the pictures that are still valid, and tagged with the code
// revision so a change to the film throws away every still rather than showing a frame from the old version.
const shotsDir = (p) => path.join(p.path, '.nodecut', 'scene-shots');
const shotFile = (p, t0) => path.join(shotsDir(p), 's' + (+t0).toFixed(3).replace('.', '_') + '.jpg');
const shotsMeta = (p) => readJson(path.join(shotsDir(p), 'index.json'), {});

export function clean(list) {
  if (!Array.isArray(list)) return [];
  const out = list.filter((s) => s && Number.isFinite(+s.t0) && Number.isFinite(+s.t1) && +s.t1 > +s.t0)
    .slice(0, 2000)
    .map((s) => ({ name: String(s.name ?? s.id ?? s.label ?? '').slice(0, 60) || 'scene', t0: +(+s.t0).toFixed(3), t1: +(+s.t1).toFixed(3), ...(s.set ? { set: String(s.set).slice(0, 40) } : {}) }))
    .sort((a, b) => a.t0 - b.t0);
  return out;
}

export function scenesOf(p) {
  const st = readJson(file(p), null);
  if (st && Array.isArray(st.scenes) && st.scenes.length) return { scenes: st.scenes, source: st.source || 'live preview', at: st.at };
  for (const r of ['data/shots.json', 'shots.json']) {
    const j = readJson(path.join(p.path, r), null);
    const s = clean(Array.isArray(j) ? j : j && j.shots);
    if (s.length) return { scenes: s, source: r };
  }
  return { scenes: [], source: null };
}

export function routes(route, readBody) {
  const need = (id) => { const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 }); return p; };
  route('GET', '/api/project/:id/scenes', (req, url, { id }) => scenesOf(need(id)));
  // the live page found its scenes: keep them (only when they changed, so nothing writes on every open)
  route('PUT', '/api/project/:id/scenes', async (req, url, { id }) => {
    const p = need(id), b = await readBody(req), scenes = clean(b.scenes);
    if (!scenes.length) return { ok: false, scenes: [] };
    const old = readJson(file(p), null);
    if (old && JSON.stringify(old.scenes) === JSON.stringify(scenes)) return { ok: true, scenes, unchanged: true };
    fs.mkdirSync(path.dirname(file(p)), { recursive: true });
    writeJson(file(p), { scenes, source: String(b.source || 'live preview').slice(0, 60), at: new Date().toISOString() });
    return { ok: true, scenes };
  });

  // ---- scene stills: one JPEG per scene for the outline
  // The client draws each frame from the live page and uploads it here, so the pictures survive a reload and the
  // outline shows something immediately on the next visit instead of a grid of empty boxes.
  route('POST', '/api/project/:id/scene-shot', async (req, url, { id }) => {
    const p = need(id), b = await readBody(req);
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(b.data || '');
    if (!m) throw Object.assign(new Error('not a JPEG'), { code: 400 });
    const t0 = +b.t0; if (!Number.isFinite(t0) || t0 < 0) throw Object.assign(new Error('bad t0'), { code: 400 });
    const revision = String(b.revision || '').slice(0, 64);
    const rev = readJson(path.join(shotsDir(p), 'rev.json'), {}).revision;
    // a new code revision means every stored still shows the wrong film: drop them all and start again
    if (rev && revision && rev !== revision) { try { fs.rmSync(shotsDir(p), { recursive: true, force: true }); } catch { } }
    fs.mkdirSync(shotsDir(p), { recursive: true });
    fs.writeFileSync(shotFile(p, t0), Buffer.from(m[1], 'base64'));
    writeJson(path.join(shotsDir(p), 'rev.json'), { revision });
    const idx = shotsMeta(p); idx[+t0.toFixed(3)] = { at: Date.now() };
    writeJson(path.join(shotsDir(p), 'index.json'), idx);
    return { ok: true };
  });
  route('GET', '/api/project/:id/scene-shot', (req, url, { id }, res) => {
    const p = need(id);
    const t0 = +url.searchParams.get('t0');
    if (!Number.isFinite(t0)) return res.writeHead(400).end('bad t0');
    const f = shotFile(p, t0);
    const rev = readJson(path.join(shotsDir(p), 'rev.json'), {}).revision;
    const fresh = !url.searchParams.get('rev') || !rev || url.searchParams.get('rev') === rev;
    if (!fresh || !fs.existsSync(f)) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
  });
}
