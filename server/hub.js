import { norm } from './util.js';
// NodeCut server: http://127.0.0.1:7788  (UI + JSON API + server-sent events). Local only.
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reveal, openUrlWindow, capabilities, findBrowser } from './platform.js';
import { config, saveConfig, discoverRoots, baseDir } from './config.js';
import { machine, diskSpace } from './machine.js';
import { detectEncoders, LABELS as ENC_LABELS } from './encoders.js';
import { scan, index, project, rescanProject, thumbnail, onScan, dropProject, hideKey } from './scan.js';
import { findCandidates, startClean, cleanStatus, onClean, busyProjects, RULES, invalidate, summary, recyclePaths, busyWhy } from './janitor.js';
import { guardState, guardHistory, guardCommand, snippRenders, guardSettings, saveGuardSettings, ensureGuard, quitGuard, guardExe } from './guard.js';
import { HUB_DIR, DATA_DIR, TOOLS, isInside, readJson, writeJson, shortPath } from './util.js';
import { readMeta, normalizeMeta } from './legacy.js';
import * as example from './example.js';
import * as notesApi from './notes.js';
import * as jobs from './jobs.js';
import * as media from './media.js';
import * as live from './live.js';
import { refreshSources } from './source-revision.js';
import * as sound from './sound.js';
import { cleanBrief, folderName, writeBrief, readBrief } from './brief.js';
import * as agent from './agent.js';
import * as outputsApi from './outputs.js';
import * as ciktilar from './ciktilar.js';
import * as layersApi from './layers.js';
import * as scenesApi from './scenes.js';
import * as edit2d from './edit2d.js';
import * as soundEdit from './soundedit.js';
import * as tweaksApi from './tweaks.js';
import * as contactSheet from './contactsheet.js';
import * as gen from './gen.js';
import * as genapi from './genapi.js';
import * as editorV1 from './editor-v1.js';
import * as editorV1Bridge from './editor-v1-bridge.js';
// `const { editorV1 } = await readBody(req)` below shadows the module in that scope, so the module is reached through one
// alias everywhere it is called. A shadowing bug here fails at request time, which is the worst place to find it.
const ev1 = editorV1;
import * as elevenlabs from './elevenlabs.js';
import { openFile } from './open-file.js';
import { transcript } from './transcript.js';
import { ramHogs } from './ramhogs.js';

const UI = path.join(HUB_DIR, 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.json': 'application/json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.flac': 'audio/flac', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

// ---------- UI version: open pages reload themselves when the UI files change
let uiVersion = '';
function computeUiVersion() {
  try { uiVersion = fs.readdirSync(UI, { recursive: true }).map(f => { const s = fs.statSync(path.join(UI, f)); return s.isFile() ? f + s.size + Math.round(s.mtimeMs) : ''; }).join('|'); } catch { }
  uiVersion = String([...uiVersion].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
}
computeUiVersion();
let uiTimer = null;
try { fs.watch(UI, { recursive: true }, () => { clearTimeout(uiTimer); uiTimer = setTimeout(() => { const old = uiVersion; computeUiVersion(); if (old !== uiVersion) broadcast('version', { v: uiVersion }); }, 400); }); } catch { }

// ---------- live events (SSE)
const clients = new Set();
export function broadcast(type, data) { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of clients) res.write(msg); }
onScan(ev => { if (ev.phase === 'done' || ev.type === 'project') invalidate(); broadcast('scan', ev); });
// warm the cleanup list in the background after a scan so pages open fast
onScan(ev => { if (ev.phase === 'done') setTimeout(() => { findCandidates().catch(() => { }); }, 200); });
// a finished full scan re-walks every project's code in the background (cards' live revision / thumbVersion)
onScan(ev => { if (ev.phase === 'done' && ev.full) refreshSources(index().projects); });
// a render ended: a Windows notification too (the open NodeCut window shows its own notice)
jobs.onJob(ev => { if (ev.type === 'done') outputsApi.notifyWindows(`Render finished: ${ev.job.projectName}${ev.job.version ? ' v' + ev.job.version : ''}`, ev.job.outputPath || ev.job.output || ''); else if (ev.type === 'failed') outputsApi.notifyWindows(`Render failed: ${ev.job.projectName}`, ev.job.error || ''); });
// a custom command waits for a yes: a Windows notification, and an open NodeCut window jumps to the Renders page
jobs.onJob(ev => { if (ev.type === 'approval') { outputsApi.notifyWindows('A render command needs your approval', `${ev.job.projectName}: ${ev.job.cmd || ''}`); broadcast('navigate', { hash: '#/renders' }); } });
jobs.onJob(ev => { broadcast('job', ev); if (ev.type === 'running' && !GUARD_OFF) ensureGuard().catch(() => { }); });   // a render always runs protected
setInterval(() => { if (clients.size) broadcast('renders', rendersPayload(false)); }, 2000);

function rendersPayload(withHistory = true) {
  const guard = guardState(), list = jobs.list();
  // programs holding RAM: looked up (one PowerShell call, cached 30 s) only while a render runs or waits, or the page opens
  const rendering = (guard.renders || []).length > 0 || list.some(j => j.state === 'running' || j.state === 'queued');
  return { guard, snipp: snippRenders(), jobs: list, hogs: rendering || withHistory ? ramHogs() : [], ...(withHistory ? { history: guardHistory() } : {}) };
}

// ---------- helpers
const send = (res, code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = req => new Promise((resolve, reject) => { const bufs = []; let n = 0; req.on('data', b => { n += b.length; if (n > 50 << 20) { reject(new Error('too large')); req.destroy(); } else bufs.push(b); }); req.on('end', () => { const t = Buffer.concat(bufs).toString('utf8'); try { resolve(t ? JSON.parse(t) : {}); } catch { resolve({}); } }); req.on('error', reject); });
// files we are willing to serve: inside a root, the archive, or a project's .nodecut folder
function allowedFile(p) {
  const roots = config().roots.map(r => r.path).concat([config().archiveDir, media.PROXY].filter(Boolean));
  return roots.some(r => isInside(p, r));
}
function serveFile(req, res, file) {
  let st; try { st = fs.statSync(file); } catch { return send(res, 404, { error: 'not found' }); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  // one range "bytes=a-b" / "a-" / "-n"; anything else (malformed, several ranges) gets the whole file
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (m && (m[1] || m[2])) {
    const a = m[1] ? +m[1] : Math.max(0, st.size - +m[2]), b = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
    if (a >= st.size || b < a) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, 'Accept-Ranges': 'bytes' }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1 });
    fs.createReadStream(file, { start: a, end: b }).on('error', () => res.destroy()).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
}
function lite(p) {
  const { outputs, meta, ...rest } = p;
  const canLive = live.liveCapable(p);
  const lo = outputs.find(o => o.rel === p.latest);   // no final yet: the film's length (manifest / DUR / sound), not a preview's
  return { ...rest, label: shortPath(p.path) + (p.group ? ' · ' + p.group : ''), latestDur: (lo?.role === 'final' ? lo.dur : p.filmDur || lo?.dur) || 0, outputsCount: outputs.length, live: canLive, thumbVersion: canLive ? live.codeRevision(p) : String(p.latest || '') + ':' + String(lo?.mtime || p.updated || 0), silentCovered: outputs.filter(o => o.role === 'silent' && o.coveredBy).length };
}
// what this PC has of the required and optional parts (Settings shows it; features without their part explain why)
function integrations() {
  const studio = config().studioDir && fs.existsSync(path.join(config().studioDir, 'engine', 'audio', 'synth.js'));
  return {
    ffmpeg: fs.existsSync(TOOLS.ffmpeg) || TOOLS.ffmpeg !== 'ffmpeg',
    browser: findBrowser().path,
    agent: { ok: true, builtIn: true, exe: null, why: null },   // render protection is part of the hub (no helper program since Nov 2026)
    sfx: { ok: !!studio, why: studio ? null : 'Ready-made sound effects need the optional 3D studio engine (studioDir). Your own sound folder works without it.' },
  };
}
function projectMetaPath(p) { return p.group ? path.join(DATA_DIR, 'meta', p.id + '.json') : path.join(p.path, '.nodecut', 'project.json'); }
// ---------- routes
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/ping', () => ({ ok: true, app: 'nodecut', pid: process.pid }));
route('GET', '/api/projects', async (req, url) => {
  if (url.searchParams.get('refresh') === '1' || !index().at) await scan();
  const s = index();
  return { at: s.at, scanning: s.scanning, projects: s.projects.map(lite), dupGroups: s.dups.length };
});
route('POST', '/api/scan', (req, url) => { if (url.searchParams.get('soft')) return { started: softScan(60e3) }; scan().catch(() => { }); return { started: true }; });
// New blank film: copies templates/new-film into the first watched films folder. The folder is the project, so this is the
// only place the hub writes a project on the user's behalf. Names are reduced to a safe folder name and never escape the root.
async function createProject({ name, brief, editorV1, sourceVideo, stagedVideo = null, videoName = null }) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) throw Object.assign(new Error('Give the film a name'), { code: 400 });
  // The brief is required, and it is the point of the dialog: it is what the film is for. A folder with no brief is a
  // folder someone has to interrogate later; a folder with one is a job that can start.
  const b = cleanBrief(brief);
  if (!b.ok) throw Object.assign(new Error(b.error), { code: 400 });
  const theBrief = b.brief;
  // Editor V1 is an EDITOR: it takes a recording and cuts it. That is the whole gate, and it is enforced here rather than
  // only in the dialog, because a request is not the dialog. Asking for it with nothing to edit is refused with the reason,
  // never silently downgraded to a blank film — a person who picks an editor and gets a blank folder thinks it worked.
  const wantEditor = editorV1 === true || editorV1 === 'true';
  // Two ways in: the small JSON request with base64 inline (only viable for a short clip), and the streamed upload that
  // is already on disk. Either one counts as "there is a recording"; neither is required for a blank film.
  const hasVideo = !!(stagedVideo || (sourceVideo && typeof sourceVideo === 'object' && sourceVideo.data));
  const videoFile = stagedVideo || null;
  const videoLabel = videoName || (sourceVideo && sourceVideo.name) || '';
  if (wantEditor && !hasVideo) throw Object.assign(new Error('Editor V1 needs a source video. Upload the recording to edit, or create a blank film instead.'), { code: 400 });
  if (wantEditor) {
    const d = ev1.detect();
    if (!d.usable) throw Object.assign(new Error(d.reason || 'Editor V1 is not available on this computer.'), { code: 409 });
    if (!ev1.isSourceVideo(videoLabel)) throw Object.assign(new Error('Editor V1 needs a video file: MP4, MOV, MKV, M4V, WEBM or AVI.'), { code: 400 });
  }
  // one folder name: no separators, no dot-prefixed or dot-only names, nothing Windows/macOS refuse
  const folder = folderName(raw);
  if (!folder) throw Object.assign(new Error('That name cannot be used for a folder'), { code: 400 });
  const roots = (config().roots || []).filter(r => r.enabled !== false && r.type === 'container').map(r => r.path);
  if (!roots.length) throw Object.assign(new Error('No films folder is set. Add one in Settings > Folders'), { code: 400 });
  const root = roots[0];
  const dest = path.join(root, folder);
  if (!isInside(dest, root)) throw Object.assign(new Error('That name cannot be used for a folder'), { code: 400 });
  const template = path.join(HUB_DIR, 'templates', 'new-film');
  if (!fs.existsSync(template)) throw Object.assign(new Error('The new-film template is missing from the NodeCut folder'), { code: 500 });

  // ---- Editor V1: the skill builds the project, because only it knows what an edit needs --------------------------------
  // new-video.sh creates the folder, lays out assets/, media/, out/ and kit.json, re-times the camera and extracts the
  // voice. Reproducing that here would be a second implementation to keep in step, so this branch does not try: it saves
  // the recording, lets the skill make the project in the films folder, and then adds only what NodeCut owns (the brief
  // and the .gitignore). A film labelled Editor V1 that does not carry the skill's layout is not an Editor V1 film.
  if (wantEditor) {
    if (fs.existsSync(dest)) throw Object.assign(new Error(`A project called "${folder}" already exists`), { code: 409 });
    // the recording goes to a scratch name first: the skill hard-links it inside the project, so it must outlive the call
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ev1-'));
    const stage = path.join(stageDir, path.basename(String(videoLabel)).replace(/[\\/:*?"<>|]/g, '_'));
    let editor = null;
    try {
      // which way the bytes came in decides how they get here; the skill sees one identical file either way
      if (videoFile) fs.copyFileSync(videoFile, stage);
      else {
        const dec = /^data:[\w.+-]+\/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(sourceVideo.data || ''));
        if (!dec) throw Object.assign(new Error('That file did not arrive. Try picking it again.'), { code: 400 });
        fs.writeFileSync(stage, Buffer.from(dec[1], 'base64'));
      }
      const made = await ev1.makeProject(stage, folder, { dir: root });
      if (!made.ok) throw Object.assign(new Error('Editor V1 could not start the edit: ' + String(made.stderr || made.stdout || '').trim().slice(-400)), { code: 500 });
      if (!fs.existsSync(dest)) throw Object.assign(new Error('Editor V1 did not create the project folder. Check the films folder and try again.'), { code: 500 });
      try {
        fs.writeFileSync(path.join(dest, '.gitignore'),
          '# A film is a project, not part of an app\'s source code.\n' +
          '# NodeCut writes renders, generated media and the agent conversation into this folder.\n' +
          '*\n!.gitignore\n');
      } catch { /* the guard is a safeguard, not a requirement */ }
      // The same containment a blank film gets: the edit is its own project root, so the agent works here and nowhere else.
      try { markOwnRepo(dest); } catch { }
      // the source the skill kept, for the plan screen and for the agent to refer to
      editor = { sourceVideo: path.relative(dest, path.join(dest, 'assets', 'media')), root };
    } catch (e) {
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch { }
      throw Object.assign(e.code ? e : Object.assign(new Error(e.message), { code: 500 }));
    } finally {
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { }
    }
    let routed = null;
    try { routed = writeBrief(dest, folder, theBrief); } catch { /* the edit is still usable without it */ }
    let p = null; try { await scan(); } catch { }
    p = index().projects.find(it => it.path === dest) || null;
    if (!p) throw Object.assign(new Error('The edit was created but NodeCut could not open it yet; press Rescan'), { code: 500 });
    const started = startFilm(p.id, p.path, { editor });
    return { ...lite(p), route: routed, started, editor };
  }

  try { fs.mkdirSync(dest); }   // throws EEXIST: never overwrite a film that is already there
  catch (e) {
    if (e.code === 'EEXIST') throw Object.assign(new Error(`A project called "${folder}" already exists`), { code: 409 });
    throw Object.assign(new Error('Could not create the folder: ' + (e.code || e.message)), { code: 500 });
  }
  try { fs.cpSync(template, dest, { recursive: true, errorOnExist: true }); }
  catch (e) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { } throw Object.assign(new Error('Could not copy the starter files: ' + (e.code || e.message)), { code: 500 }); }
  // A film is a project the person is making, not a change to this app. Films live inside whatever folder the user keeps
  // them in, which is often inside some repository, and a stray `git add .` would sweep an entire film into a commit. The
  // folder excludes itself so that cannot happen. Written here rather than shipped in the template because this repo
  // cannot carry dot-prefixed paths (GitHub's browser upload silently drops them), so a template copy would go missing.
  try {
    fs.writeFileSync(path.join(dest, '.gitignore'),
      '# A film is a project, not part of an app\'s source code.\n' +
      '# NodeCut writes renders, chunk caches, generated media, audio mixes and the agent conversation into this folder.\n' +
      '# None of it belongs in a commit, and this folder often sits inside someone else\'s repository.\n' +
      '# The film\'s own code is excluded too, on purpose: it is only committed if the person decides to.\n' +
      '*\n!.gitignore\n');
  } catch { /* a film without this file still works; it is a safeguard, not a requirement */ }
  // The brief and the routing land with the folder. If either fails the whole folder goes: a half-made project that
  // looks finished is worse than no project, because the next person trusts it.
  let routed = null;
  try { routed = writeBrief(dest, folder, theBrief); }
  catch (e) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { }
    throw Object.assign(new Error('Could not write the brief: ' + (e.code || e.message)), { code: 500 });
  }
  // An Editor V1 film never reaches this point: it is built by the skill above and returns early. The blank starter is the
  // only thing that needs the template copy.
  let edited = null;
  // A film must be its own project root. Without this the agent tools walk UP from the film folder and find whatever
  // repository encloses it — here, the user's home folder — and the agent then reads and edits the wrong tree entirely.
  // An empty repository *inside* the film stops the walk at the film, which is where every film's work belongs.
  try { markOwnRepo(dest); } catch { /* a film still works without it; the folder is just less contained */ }
  // index it now so the new card is there the moment the page redraws (a full scan walks every root, so ask for one)
  let p = null; try { await scan(); } catch { }
  p = index().projects.find(it => it.path === dest) || null;
  if (!p) throw Object.assign(new Error('The film was created but NodeCut could not open it yet; press Rescan'), { code: 500 });
  // Creating a film is the start of the work, not the end of it. The brief on disk is what the agent builds from, so the
  // first turn is sent here rather than waiting for someone to type "go". A failure to start is reported, never swallowed:
  // a film that looks created and is silently doing nothing is the worst outcome for the person who just described it.
  const started = startFilm(p.id, p.path, { editor: edited });
  return { ...lite(p), route: routed, started, editor: edited };
}

// The two ways a film gets created. Both run the same logic, so the rules (the gate, the folder name, the cleanup on
// failure) cannot drift between them.
route('POST', '/api/projects/new', async req => {
  const { name, brief, editorV1, sourceVideo, uploadToken } = await readBody(req);
  // a streamed upload is checked first: it is the path a real recording takes
  if (uploadToken && editorV1) {
    const staged = ev1StagePath(uploadToken);
    if (!staged || !fs.existsSync(staged)) throw Object.assign(new Error('The uploaded video is no longer on disk. Choose it again.'), { code: 410 });
    let videoName = 'recording.mov';
    try { videoName = fs.readFileSync(staged + '.name', 'utf8').trim() || videoName; } catch { }
    const cleanup = () => { try { fs.unlinkSync(staged); } catch { } try { fs.unlinkSync(staged + '.name'); } catch { } };
    try { return await createProject({ name, brief, editorV1, stagedVideo: staged, videoName }); }
    finally { cleanup(); }
  }
  return createProject({ name, brief, editorV1, sourceVideo });
});

// markOwnRepo(folder) -> gives the folder its own empty git repository, so nothing walks up past it.
//
// Why this exists: the agent tools resolve "the project" by walking up from the working folder to the nearest repository.
// A film inside a films folder inside someone's home is very often inside a repository they did not think about (here,
// ~ itself). The agent then treats that whole tree as its project and edits the first thing that looks relevant — which
// was this app's own source. An empty .git in the film makes the film the root, and the walk stops where the work is.
//
// It is `git init` with no commit: no history, no staging, nothing for the person to clean up. If git is missing or the
// command fails the film still works; it is simply less contained.
export function markOwnRepo(folder) {
  if (fs.existsSync(path.join(folder, '.git'))) return { created: false, reason: 'already a repository' };
  // a FILM folder is never /Users/x itself (that would make the person's whole home a repo): only contain a real subfolder
  if (path.dirname(folder) === folder || path.resolve(folder) === path.resolve(os.homedir())) return { created: false, reason: 'not a subfolder' };
  try {
    execFileSync('git', ['init', '-q', folder], { stdio: 'ignore', timeout: 15000 });
    return { created: fs.existsSync(path.join(folder, '.git')) };
  } catch (e) { return { created: false, reason: e.message }; }
}

// startFilm(projectId, folder, { editor }) -> { started, error? }. The opening turn of a brand-new film.
// Kept in one place so the route and the retry endpoint cannot drift apart: the same words open the same film twice.
// The brief is not passed as an argument: it is on disk in BRIEF.md, and the prompt tells the agent to read it there,
// so there is exactly one copy of what the film is for.
function startFilm(id, folder, { editor = null } = {}) {
  // ---- the guard that stops this app editing itself ---------------------------------------------------------------
  // The agent runs with `cwd: folder`, but its own tools resolve the project by walking UP to the nearest repository. A
  // film that is not its own repo root therefore hands the agent whatever tree encloses it — on this machine that was
  // ~, and the agent spent its first turn reading NodeCut's source instead of the recording. Before a run starts, the
  // film is made its own root; if the folder is somehow NodeCut's own code, the turn is refused outright rather than
  // letting an agent loose in the app.
  const here = path.resolve(folder);
  if (here === path.resolve(HUB_DIR) || isInside(path.resolve(HUB_DIR), here)) {
    return { started: false, error: 'That folder is NodeCut\'s own source code, not a film. Films live in your films folder.' };
  }
  try { markOwnRepo(folder); } catch { }
  // An Editor V1 film is not written from a brief the way a code film is: a recording already exists and the skill's job
  // is to cut it. The opening turn says so, and it names the tools the edit may use, because the difference between an
  // edit that sits on the free defaults and one that uses the voice and b-roll this machine already pays for is a line of
  // instruction — the agent will not reach for a paid tool it has not been told it may use.
  const first = editor ? [
    'Edit the recording in this project into an Editor V1 film.',
    '',
    'The recording is the one you were given: it is the only footage that is yours, and the brief in BRIEF.md says what',
    'the film is for. Read the brief first, then use the editor-v1 skill installed on this computer (its SKILL.md is at',
    '~/.claude/skills/editor-v1/SKILL.md; read it before you start, it is the source of truth for the style).',
    '',
    'Work in this order:',
    '',
    '1. Write the edit plan first and show it to me before building: what every line of the recording gets on screen,',
    '   where each picture comes from, and the rights line for anything found outside this folder.',
    '2. Build the edit with the skill\'s own scripts. Do not re-implement the renderer.',
    '3. You may use the tools this machine already has instead of the free defaults:',
    '   - Voice: hub_generate_audio (ElevenLabs, the key is already saved in Settings > Generation). Use it for a',
    '     voice-over or for lines the recording does not cover. Run hub_voices and ask me which voice before you pick one.',
    '   - Moving b-roll: hub_generate_clip (text_to_video, and image_to_video when you have a still to animate). These',
    '     cost money per clip; price them with hub_plan and tell me the total in the plan you show me.',
    '   - Pictures: hub_generate_image for stills, and the skill\'s own find-footage.py for public-domain material.',
    '4. Check the result and fix what is wrong. Do not render until I have seen it and said so.',
    '',
    'Do not stop to ask me before starting the plan. If something is genuinely missing, decide it the way the skill would,',
    'say what you decided in your reply, and keep going.',
  ].join('\n') : [
    'Make this film, start to finish.',
    '',
    'The brief is in BRIEF.md and the team files it routed to are listed there. Read the brief and those files first, then',
    'work in this order:',
    '',
    '1. Fill in the plan (hub_plan) so every beat has a time and a reason.',
    '2. Build the film as code, so every frame is a pure function of t.',
    '3. Check it against the craft notes as you go, and fix what the checker refuses.',
    '',
    'Do not stop to ask me before starting. If something is genuinely missing from the brief, decide it the way the craft',
    'notes would, say what you decided in your reply, and keep going.',
  ].join('\n');
  try {
    const r = agent.start(id, folder, first, { model: agentModel(), onEvent: () => broadcast('agent', { id }) });
    if (r.started) { broadcast('agent', { id }); return { started: true }; }
    return { started: false, error: r.error || 'The agent did not start.' };
  } catch (e) {
    return { started: false, error: e.message || 'The agent did not start.' };
  }
}

// agentModel() -> the model a run should use, or null to let opencode choose.
//
// NodeCut passes nothing by default, which means it inherits opencode's own default — and that default can be a free model
// whose provider blocks it. That is exactly what happened here: every new film opened, the first turn failed instantly
// with a 404, and nothing on screen said the film was fine and only the model was refused.
//
// So a model that is known to be blocked is replaced with one that is known to work with the key already saved, rather than
// inherited and left to fail. Only a model that is known bad is swapped: an explicit choice is always respected, and when
// nothing is known to be wrong this returns null and opencode's own choice stands.
const BLOCKED_MODEL = /(?::free|free)$/i;
// The fallback, in order of preference. Each one is a model this machine already has a key for (DeepInfra is configured in
// Settings > Generation), so the swap costs nothing and needs no setup.
const FALLBACK_MODELS = [
  'deepinfra/deepseek-ai/DeepSeek-V4-Pro',
  'deepinfra/deepseek-ai/DeepSeek-V3.2',
  'deepinfra/deepseek-ai/DeepSeek-V3.1',
];
export function agentModel() {
  const chosen = config().agentDefaultModel;
  if (chosen) return chosen;                       // an explicit choice is always respected, blocked or not
  const d = defaultAgentModel();
  if (!d) return null;                             // nothing to judge: let opencode decide
  if (!BLOCKED_MODEL.test(d)) return d;            // a paid model that already works: keep using it
  return FALLBACK_MODELS[0];                       // the configured default is a free model the provider blocks
}
let defaultCache = null;
// The model opencode itself would use, read from its config. There is no stable CLI for asking, and a guessed command that
// silently stops existing is how a fallback rots; the config file is what actually decides.
function defaultAgentModel() {
  if (defaultCache && Date.now() - defaultCache.at < 60 * 1000) return defaultCache.value;
  const candidates = [
    process.env.OPENCODE_CONFIG,
    path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc'),
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
  ].filter(Boolean);
  for (const f of candidates) {
    try {
      // the file is JSONC: comments are legal there and illegal in JSON, so they are dropped before parsing
      const j = JSON.parse(String(fs.readFileSync(f, 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
      defaultCache = { at: Date.now(), value: j.model || null };
      return defaultCache.value;
    } catch { /* try the next location */ }
  }
  defaultCache = { at: Date.now(), value: null };
  return null;
}

// GET /api/editor-v1 — can this film be an Editor V1 edit, and why not.
//
// The New film dialog asks before it shows the card, so an option that cannot work is never offered. It also reports the
// one thing that kept the cut-out off on this machine rather than letting the agent discover it by failing: PyTorch
// publishes arm64-only wheels for macOS, so the device cannot exist on an Intel Mac.
route('GET', '/api/editor-v1', () => {
  const d = ev1.detect();
  return { ...d, root: ev1.editorRoot(), rights: Object.keys(editorV1Bridge.SOURCE_RIGHTS || {}).map((k) => ({ id: k, ...editorV1Bridge.rightsFor(k) })) };
});

// POST /api/editor-v1/upload?name=<file> — raw video bytes in the body, a token back.
//
// A recording is far too large to carry inside a JSON body: 110 MB becomes 146 MB once base64 is applied, and the body
// reader above refuses anything over 50 MB by killing the socket — which reaches the browser as a bare "could not fetch"
// with nothing on screen or in the log to say why. So the video takes the same route as a large sound file: the raw bytes
// stream straight to disk, and only a small JSON call follows.
//
// The upload and the create are deliberately two steps. A film folder is created only once the recording is on disk, so a
// dropped connection cannot leave a half-made "Editor V1" project behind.
const EV1_TMP = path.join(os.tmpdir(), 'nodecut-ev1-upload');
export const EV1_UPLOAD_MAX = 4 * 1024 * 1024 * 1024;

function ev1StagePath(token) {
  if (!/^[a-z0-9]{16,64}$/.test(String(token || ''))) return null;
  return path.join(EV1_TMP, token);
}

route('POST', '/api/editor-v1/upload', (req, url) => new Promise((resolve, reject) => {
  const name = String(url.searchParams.get('name') || '').replace(/[\\/:*?"<>|]/g, '_');
  if (!ev1.isSourceVideo(name)) return reject(Object.assign(new Error('Editor V1 needs a video: MP4, MOV, MKV, M4V, WEBM or AVI.'), { code: 400 }));
  const token = crypto.randomBytes(18).toString('hex');
  const file = ev1StagePath(token);
  try { fs.mkdirSync(EV1_TMP, { recursive: true }); } catch (e) { return reject(Object.assign(new Error('Could not prepare the upload folder: ' + e.message), { code: 500 })); }
  const out = fs.createWriteStream(file);
  let n = 0, done = false;
  const fail = (e) => { if (done) return; done = true; try { out.destroy(); } catch { } try { fs.unlinkSync(file); } catch { } reject(e); };
  req.on('data', (d) => {
    n += d.length;
    if (n > EV1_UPLOAD_MAX) { req.destroy(); fail(Object.assign(new Error('That video is larger than 4 GB. Shorten it first.'), { code: 413 })); }
  });
  req.on('error', fail);
  out.on('error', fail);
  out.on('finish', () => {
    if (done) return;
    done = true;
    if (!n) return fail(Object.assign(new Error('The video arrived empty.'), { code: 400 }));
    // keep the real name beside the bytes: a token alone cannot be turned back into a sensible folder name
    try { fs.writeFileSync(file + '.name', name); } catch { }
    resolve({ token, name, bytes: n });
  });
  req.pipe(out);
}));

// POST /api/editor-v1/rights — what a planned edit would pull in, and whether any of it is not free to use.
route('POST', '/api/editor-v1/rights', async req => {
  const { assets } = await readBody(req);
  return editorV1Bridge.rightsSummary(Array.isArray(assets) ? assets : []);
});

// POST /api/project/:id/agent/start-building — the same opening turn again, for a film whose agent never began (the hub
// was restarted, or opencode was missing the first time). The new-film route returns `started: false` and the live page
// offers this, so "nothing is happening" is a state the UI can fix rather than a dead end.
route('POST', '/api/project/:id/agent/start-building', (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  // A film made as an Editor V1 edit must be re-opened as one. Its folder carries the recording, so the fact survives a
  // restart: the opening turn is chosen from what is on disk, not from what this process happens to remember.
  const isEditor = fs.existsSync(path.join(p.path, 'source')) || fs.existsSync(path.join(p.path, 'build.py'));
  const r = startFilm(id, p.path, { editor: isEditor ? { root: path.dirname(p.path) } : null });
  if (!r.started) throw Object.assign(new Error(r.error), { code: 400 });
  return agent.state(id, p.path);
});
// ---- the Agent tab: run opencode in this film's folder and stream what it does -------------------------------
// A run is one agent turn. It is per film and one at a time: two turns in one folder would both edit film.js.
route('GET', '/api/project/:id/agent', (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  // hasBrief tells the tab whether this film was made from a brief and has never been built. That is the one case where
  // an idle agent means "the work never started" rather than "the work is finished", and the tab offers to start it.
  const b = readBrief(p.path);
  return { ...agent.state(id, p.path), hasBrief: !!(b && b.brief) };
});
route('GET', '/api/agent/models', async () => ({ models: await agent.listModels(), default: (config().agentDefaultModel || null) }));
route('POST', '/api/project/:id/agent', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const { message, model } = await readBody(req);
  const r = agent.start(id, p.path, message, { model: model || null, onEvent: () => broadcast('agent', { id }) });
  if (!r.started) throw Object.assign(new Error(r.error), { code: 400 });
  return agent.state(id, p.path);
});
route('POST', '/api/project/:id/agent/stop', (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const r = agent.stop(id);
  broadcast('agent', { id });
  return r;
});
route('POST', '/api/project/:id/agent/clear', (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  agent.forget(id, p.path);
  broadcast('agent', { id });
  return { cleared: true };
});
// the brief a film was built from (BRIEF.md + plan/route.json), for the review page. No brief is a normal answer for a
// film made before briefs existed, so it returns null fields rather than an error.
route('GET', '/api/project/:id/brief', (req, url, { id }) => {
  const p = project(id);
  if (!p) throw Object.assign(new Error('No such project'), { code: 404 });
  const b = readBrief(p.path);
  return b ? { brief: b.brief, pipeline: b.pipeline, files: b.files, at: b.at } : { brief: '', pipeline: null, files: [], at: null };
});
// which project is this folder (or a file inside it)? deepest match wins; also accepts an id or a name
route('GET', '/api/find', async (req, url) => {
  const q = url.searchParams.get('q') || '';
  const pick = () => {
    const s = index().projects;
    const byId = s.find(p => p.id === q); if (byId) return byId;
    const inside = s.filter(p => !p.group && isInside(q, p.path)).sort((a, b) => b.path.length - a.path.length)[0]; if (inside) return inside;
    const lq = q.toLowerCase(); return s.find(p => p.name.toLowerCase() === lq) || s.find(p => (p.title || '').toLowerCase() === lq) || null;
  };
  let p = pick();
  if (!p && q && fs.existsSync(q)) { await scan({ soft: true }); p = pick(); }   // new folders are found by soft scans too
  if (!p) throw Object.assign(new Error('This folder is not a project NodeCut knows: ' + q + '. Put it inside one of NodeCut\'s folders, or add its parent folder in Settings → Folders.'), { code: 404 });
  return { ...lite(p), outputs: p.outputs, notes: notesApi.list(p), versionsLog: notesApi.versions(p) };
});
route('GET', '/api/project/:id', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const name = p.name.toLowerCase();
  const history = guardHistory(1000).filter(h => h.project && (h.project.toLowerCase().replaceAll('\\', '/').endsWith('/' + name) || h.project.toLowerCase() === name)).slice(0, 60);
  // the review page does not need the cleanup list (lite=1); the project page waits at most 1.5 s for it
  const cand = url.searchParams.get('lite') ? null : await Promise.race([findCandidates().catch(() => []), new Promise(r => setTimeout(() => r(null), 1500))]);
  return { ...p, label: shortPath(p.path), cleanup: (cand || []).filter(c => c.project === id), cleanupPending: !cand && !url.searchParams.get('lite'), busy: busyProjects().find(b => b.project === id)?.reason || null, notes: notesApi.list(p), versionsLog: notesApi.versions(p), history };
});
route('POST', '/api/project/:id/meta', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const body = await readBody(req), file = projectMetaPath(p);
  const meta = normalizeMeta({ ...readMeta(file, {}), ...body, updated: new Date().toISOString() });   // a Turkish status word is accepted too
  writeJson(file, meta);
  return await rescanProject(id).then(lite);
});
route('POST', '/api/project/:id/rescan', async (req, url, { id }) => lite(await rescanProject(id)));
// a film with no video yet: the picture its live page drew (the card draws it and sends it here; X-Stale = code is newer)
const LIVE_THUMBS = path.join(DATA_DIR, 'thumbs');
// the last automatic scan of a live film (ui/review/autoscan.js): ranges of problems, kept with the project
route('GET', '/api/project/:id/autoscan', (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  return readJson(path.join(p.path, '.nodecut', 'autoscan.json'), null);
});
route('PUT', '/api/project/:id/autoscan', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const b = await readBody(req);
  if (!b || !Array.isArray(b.ranges)) throw Object.assign(new Error('missing ranges'), { code: 400 });
  fs.mkdirSync(path.join(p.path, '.nodecut'), { recursive: true });
  writeJson(path.join(p.path, '.nodecut', 'autoscan.json'), { ...b, ranges: b.ranges.slice(0, 2000) });
  return { ok: true };
});
const TWEAK_CLEANERS = { cleanAudio: soundEdit.cleanAudio, cleanItems: edit2d.cleanItems, cleanActors: edit2d.cleanActors };
// the scene editor's fixes (camera, objects) for pages that draw them themselves (3D studio engine/tweaks.js)
route('GET', '/api/project/:id/tweaks', (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  return readJson(path.join(p.path, 'tweaks.json'), { v: 1, shots: {} });
});
route('PUT', '/api/project/:id/tweaks', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const b = await readBody(req);
  if (!b || typeof b.shots !== 'object' || Array.isArray(b.shots)) throw Object.assign(new Error('missing shots'), { code: 400 });
  const f = path.join(p.path, 'tweaks.json');
  // PUT always sets shots, cuts and sound (an absent cuts/sound = none); items2d / actors2d / audio only when given
  const { soundOps, ...rest } = b;
  const out = tweaksApi.mergeTweaks(tweaksApi.readTweaksStrict(f), { ...rest, cuts: b.cuts, sound: b.sound }, TWEAK_CLEANERS);
  tweaksApi.writeTweaks(f, out);
  return { ok: true, shots: Object.keys(b.shots).length, cuts: out.cuts.length, items2d: (out.items2d || []).length };
});
// each editor sends only its own keys: { shots, cuts, items2d, actors2d, audio, sound, soundOps } (any of them);
// read-modify-write runs synchronously after the body is read, so concurrent PATCHes never interleave
route('PATCH', '/api/project/:id/tweaks', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const b = await readBody(req);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw Object.assign(new Error('missing body'), { code: 400 });
  if ('shots' in b && (!b.shots || typeof b.shots !== 'object' || Array.isArray(b.shots))) throw Object.assign(new Error('shots must be an object'), { code: 400 });
  if ('soundOps' in b && (!b.soundOps || typeof b.soundOps !== 'object')) throw Object.assign(new Error('soundOps must be an object'), { code: 400 });
  const keys = ['shots', 'cuts', 'items2d', 'actors2d', 'gen', 'audio', 'sound', 'soundOps'].filter((k) => k in b);
  const f = path.join(p.path, 'tweaks.json');
  const body = Object.fromEntries(keys.map((k) => [k, b[k]]));
  const out = tweaksApi.mergeTweaks(tweaksApi.readTweaksStrict(f), body, TWEAK_CLEANERS);
  tweaksApi.writeTweaks(f, out);
  return { ok: true, keys, sound: out.sound || [], ...(out.audio ? { audio: out.audio } : {}) };
});
route('POST', '/api/project/:id/live-thumb', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const body = await readBody(req);
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(body.data || '');
  if (!m) throw Object.assign(new Error('not a JPEG'), { code: 400 });
  const revision = live.codeRevision(p, { fresh: true });   // never the cached one: a stale frame must get 409
  if (body.revision && body.revision !== revision) throw Object.assign(new Error('The code changed; the cover has to be drawn again.'), { code: 409 });
  fs.mkdirSync(LIVE_THUMBS, { recursive: true });
  fs.writeFileSync(path.join(LIVE_THUMBS, 'live-' + p.id + '.jpg'), Buffer.from(m[1], 'base64'));
  writeJson(path.join(LIVE_THUMBS, 'live-' + p.id + '.json'), { revision: body.revision || null });
  return { ok: true };
});
route('GET', '/api/thumb/:id', async (req, url, { id }, res) => {
  const p = project(id); if (!p) return send(res, 404, { error: 'Project not found' });
  const wantsLive = url.searchParams.get('source') === 'live' || !p.latest;
  if (wantsLive && live.liveCapable(p)) {
    const lf = path.join(LIVE_THUMBS, 'live-' + p.id + '.jpg');
    const meta = readJson(path.join(LIVE_THUMBS, 'live-' + p.id + '.json'), {});
    if (fs.existsSync(lf)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Thumb-Source': 'live', 'X-Stale': meta.revision === live.codeRevision(p) ? '0' : '1' });
      return fs.createReadStream(lf).on('error', () => res.destroy()).pipe(res);
    }
  }
  const f = await thumbnail(p);
  if (!f) return send(res, 404, { error: 'Cover not ready yet' });
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Thumb-Source': 'video', 'X-Stale': wantsLive && live.liveCapable(p) ? '1' : '0' });
  fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
});
route('GET', '/media', (req, url, _, res) => {
  const f = url.searchParams.get('p');
  if (!f || !allowedFile(f)) return send(res, 403, { error: 'not allowed' });
  serveFile(req, res, f);
});
route('POST', '/api/open', async (req) => {
  const { path: p, how } = await readBody(req);
  if (typeof p !== 'string' || !p || !allowedFile(p)) throw Object.assign(new Error('not allowed'), { code: 403 });
  return openFile(p, how || 'file');
});
// "Open folder": the project folder in Explorer, or (file) the folder of one of its videos with that file selected.
// Only folders inside a configured root (or the archive); test hubs (NODECUT_NO_WINDOW) answer without opening.
route('POST', '/api/project/:id/open-folder', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const b = await readBody(req);
  const o = b.file ? p.outputs.find(x => x.rel === b.file || x.path === b.file) : null;
  if (b.file && !o) throw Object.assign(new Error('This project has no such video'), { code: 404 });
  const target = o ? o.path : (p.groupFiles ? path.dirname(p.outputs[0]?.path || p.path) : p.path);
  if (!allowedFile(target) || !fs.existsSync(target)) throw Object.assign(new Error('This folder cannot be opened (outside NodeCut\'s folders, or missing)'), { code: 403 });
  if (!process.env.NODECUT_NO_WINDOW) await reveal(target, { select: !!o });
  return { ok: true, path: target, select: !!o };
});
// ---------- removing a project from the Projects page
// "Remove from list": hidden (config.hiddenProjects), no file touched, back from Settings → Hidden projects
route('POST', '/api/project/:id/hide', (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const list = (config().hiddenProjects || []).filter(h => h.key !== hideKey(p));
  list.push({ key: hideKey(p), name: p.title || p.name, path: p.path + (p.group ? ' · ' + p.group : ''), at: new Date().toISOString() });
  saveConfig({ hiddenProjects: list }); dropProject(id);
  return { ok: true };
});
route('GET', '/api/hidden', () => config().hiddenProjects || []);
route('POST', '/api/hidden/restore', async (req) => {
  const { key } = await readBody(req);
  saveConfig({ hiddenProjects: (config().hiddenProjects || []).filter(h => h.key !== key) });
  scan().catch(() => { }); return { ok: true };
});
// "Delete folder": the project's folder (a 3D scene: also its out\<scene>; loose files: just those files) to the Recycle Bin.
// Never a configured root itself or anything outside one, never while it renders or is queued.
route('POST', '/api/project/:id/delete-folder', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const roots = config().roots.map(r => r.path);
  const targets = p.group ? p.groupFiles.map(f => path.join(p.path, f)) : [p.path, ...(p.studio && p.outDir && fs.existsSync(p.outDir) ? [p.outDir] : [])];
  for (const t of targets) {
    if (!roots.some(r => isInside(t, r)) || roots.some(r => norm(r) === norm(t))) throw Object.assign(new Error('This folder cannot be deleted: it is one of NodeCut\'s folders itself, or outside them.'), { code: 403 });
  }
  if (jobs.list().some(j => j.project === id && ['queued', 'running'].includes(j.state))) throw Object.assign(new Error('This project is rendering or queued; try again when it is done.'), { code: 409 });
  const why = busyWhy(p); if (why) throw Object.assign(new Error('Cannot delete right now: ' + why + '.'), { code: 409 });
  if (cleanStatus()?.state === 'running') throw Object.assign(new Error('A cleanup is running; try again when it is done.'), { code: 409 });
  const res = await recyclePaths(targets.map(t => ({ path: t, size: p.group ? 0 : (p.sizes?.total || 0) })));
  const bad = res.filter(r => !r.ok);
  if (bad.length < res.length) dropProject(id);
  return { ok: !bad.length, results: res, error: bad[0]?.error || null };
});
route('GET', '/api/renders', () => rendersPayload(true));
route('POST', '/api/renders/cmd', async (req) => {
  const { action, rootPid } = await readBody(req);
  if (!['pause', 'resume', 'kill', 'pauseAll', 'resumeAll', 'slow', 'normal'].includes(action)) throw Object.assign(new Error('unknown command'), { code: 400 });
  return guardCommand(action, rootPid);
});
// settings + the running temporary override; a manual change ends the override (the user decided)
route('GET', '/api/guard/settings', async () => ({ ...(await guardSettings()), ramTotalMB: Math.round(os.totalmem() / 1048576), cores: os.cpus().length, temp: readJson(path.join(DATA_DIR, 'guard-temp.json')) }));
route('POST', '/api/guard/settings', async (req) => { const b = await readBody(req); try { fs.unlinkSync(path.join(DATA_DIR, 'guard-temp.json')); } catch { } return saveGuardSettings(b); });
route('GET', '/api/disk', async () => {
  const c = await findCandidates(), s = index();
  const totals = s.projects.reduce((t, p) => { for (const [k, v] of Object.entries(p.sizes || {})) t[k] = (t[k] || 0) + v; return t; }, {});
  return { rules: RULES, candidates: c, totals, projects: summary(c), busy: busyProjects(), clean: cleanStatus(), archiveDir: config().archiveDir, archiveOk: fs.existsSync(path.parse(config().archiveDir).root) };
});
// a cleaning run goes in the background (one at a time); progress and the result come as SSE 'clean'
route('POST', '/api/disk/clean', async (req) => { const { ids } = await readBody(req); return startClean(ids); });
// slow-save reports from the review player (data\perf.jsonl, last ~500 lines kept) with free RAM and renders at that moment
route('POST', '/api/perf', async (req) => {
  const b = await readBody(req), f = path.join(DATA_DIR, 'perf.jsonl'), g = guardState();
  const line = JSON.stringify({ at: new Date().toISOString(), ...b, freeRamMB: Math.round(os.freemem() / 1048576), renders: (g.renders || []).length, jobs: jobs.busy() }) + '\n';
  try { const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-499).join('\n') + '\n' : ''; fs.writeFileSync(f, old + line); } catch { }
  return { ok: true };
});
route('GET', '/api/disk/clean', () => cleanStatus() || { state: 'none' });
onClean(st => { broadcast('clean', st); if (st.state === 'done') { ciktilar.afterClean(st.results).catch(() => { }); scan().catch(() => { }); } });
// after every scan: each project's newest final in the outputs folder (the first scan fills it)
onScan(ev => { if (ev.phase === 'done') try { ciktilar.sync(); } catch (e) { console.error('ciktilar sync:', e.message); } });
// GET /api/config: everything the pages need, minus anything secret. The whole config spread used to be sent, which
// put the user's live API keys (generation.keys) in plain text in every page that asked — visible in devtools, in a
// saved HAR, or to anything else running on this machine. Keys are reported as "is one set?" booleans instead, the
// same way /api/gen/config already does it; the values never leave the server.
const redactConfig = c => {
  const keys = (c.generation && c.generation.keys) || {};
  return { ...c, generation: c.generation ? { ...c.generation, keys: Object.fromEntries(Object.keys(keys).map(k => [k, !!keys[k]])) } : c.generation };
};
route('GET', '/api/config', () => ({ ...redactConfig(config()), workspace: baseDir(), capabilities: capabilities(), discovered: discoverRoots(), tools: TOOLS, example: example.info(), integrations: integrations() }));
// what this computer is: static facts (once) plus the two figures that move (free RAM, free disk)
route('GET', '/api/machine', () => {
  const g = guardState(); const disk = diskSpace(baseDir());
  return { ...machine(), ramFreeGB: g?.running && g.ramAvailMB ? +(g.ramAvailMB / 1024).toFixed(1) : null, disk };
});
example.routes(route, readBody, () => scan());
route('POST', '/api/config', async (req) => { const body = await readBody(req); const c = saveConfig(body); scan().catch(() => { }); return redactConfig(c); });
// render encoders this PC can use (one tiny test encode each, cached in data/encoders.json; ?refresh=1 probes again)
route('GET', '/api/encoders', async (req, url) => ({ ...(await detectEncoders({ ffmpeg: TOOLS.ffmpeg, cacheFile: path.join(DATA_DIR, 'encoders.json'), refresh: url.searchParams.get('refresh') === '1' })), chosen: config().render?.encoder || 'auto', labels: ENC_LABELS }));
notesApi.routes(route, readBody);
sound.routes(route, project);
outputsApi.routes(route, readBody);
ciktilar.routes(route);
layersApi.routes(route);
scenesApi.routes(route, readBody);
edit2d.routes(route, readBody);
soundEdit.routes(route, readBody);
jobs.routes(route, readBody);
media.routes(route, allowedFile);
contactSheet.routes(route, project, live, +(process.env.NODECUT_PORT || config().port || 7788));
genapi.routes(route, project, readBody, +(process.env.NODECUT_PORT || config().port || 7788));
elevenlabs.routes(route, project, readBody);
gen.routes(route, project, readBody);   // after genapi: /api/gen/config is not a project id
media.onProxy(ev => broadcast('proxy', ev));
notesApi.onNote(ev => broadcast('note', ev));
setTimeout(() => { try { notesApi.resumePending(index().projects); } catch (e) { console.error('[notes] resume:', e.message); } }, 8000);
// a clip job started before a restart is still running on OpenRouter: pick it back up and draw it when it lands
setTimeout(() => { for (const p of index().projects) { try { genapi.resumeJobs(p); } catch (e) { console.error('[gen] resume:', e.message); } } }, 12000);

// the narration's text with timings (timeline row, captions)
route('GET', '/api/project/:id/transcript', (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  return transcript(p);
});

// show a page to the user (Claude's hub_live): an open NodeCut window jumps there, otherwise a window opens
route('POST', '/api/show', async (req) => {
  const { hash } = await readBody(req);
  if (typeof hash !== 'string' || !/^#\/[\w\-/~%.]*$/.test(hash)) throw Object.assign(new Error('invalid page'), { code: 400 });
  if (process.env.NODECUT_GUARD !== 'off') ensureGuard().catch(() => { });
  if (clients.size) { broadcast('navigate', { hash }); return { ok: true, how: 'window' }; }
  if (process.env.NODECUT_NO_WINDOW) return { ok: true, how: 'none' };
  await openUrlWindow(`http://127.0.0.1:${port}/${hash}`);
  return { ok: true, how: 'opened' };
});

// live preview (no render): what to play for a project; open players hear about code changes
route('GET', '/api/project/:id/live', async (req, url, { id }) => {
  const p = project(id); if (!p) throw Object.assign(new Error('Project not found'), { code: 404 });
  const info = await live.liveInfo(p);
  if (info.ok && !url.searchParams.get('probe')) live.watch(p, ev => broadcast('live-changed', ev));
  return info;
});

route('GET', '/api/events', (req, url, _, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(`event: hello\ndata: ${JSON.stringify({ v: uiVersion })}\n\n`); clients.add(res);
  req.on('close', () => { clients.delete(res); lastUse = Date.now(); });   // the 2 min count from the window closing
  softScan(30e3);   // a NodeCut window opened: pick up projects other chats made meanwhile
  if (!GUARD_OFF) ensureGuard().catch(() => { });
});

// ---------- new projects show up by themselves: rescan when a window opens or comes back to the front,
// every 10 min while one is open, and when Claude asks about a folder (see /api/project). A full scan takes ~7 s.
function softScan(maxAgeMs) {
  const at = index().at, t = typeof at === 'number' ? at : Date.parse(at || 0) || 0;
  if (index().scanning || Date.now() - t < maxAgeMs) return false;
  scan({ soft: true }).catch(() => { }); return true;   // only changed projects are walked again (scan.js)
}
setInterval(() => { if (clients.size) softScan(9 * 60e3); }, 60e3);

// ---------- a temporary RenderGuard override ("just this time", data/guard-temp.json): put the saved settings back once it expired
const TEMP_FILE = path.join(DATA_DIR, 'guard-temp.json');
async function checkGuardTemp(force = false) {
  const t = readJson(TEMP_FILE);
  if (!t?.until || (!force && Date.now() < Date.parse(t.until))) return false;
  try { await saveGuardSettings(t.restore || {}); fs.unlinkSync(TEMP_FILE); console.log('NodeCut: the temporary render setting ended, the previous settings are back.'); return true; } catch { return false; }
}
// POST {hours}: full power until then (keeps the settings from before the first override); {cancel:true}: restore now
route('POST', '/api/guard/temp', async (req) => {
  const b = await readBody(req);
  if (b.cancel) { await checkGuardTemp(true); return { ok: true }; }
  const hours = Math.max(0.25, Math.min(24, +b.hours || 2));
  const old = readJson(TEMP_FILE), cur = await guardSettings();
  const restore = old?.restore || { CapActive: cur.CapActive, CapIdle: cur.CapIdle, LowPrio: !!cur.LowPrio };
  const until = new Date(Date.now() + hours * 3600e3).toISOString();
  writeJson(TEMP_FILE, { reason: 'Renders page: temporary full power', until, restore });
  await saveGuardSettings({ CapActive: 100, CapIdle: 100, LowPrio: false });
  return { ok: true, until };
});
checkGuardTemp(); setInterval(checkGuardTemp, 60e3).unref();

// ---------- run only while used: no NodeCut window, no render, no queued work for 2 min → RenderGuard and the hub close.
// Claude's hub_* tools start the hub again when needed; a render job starts RenderGuard again.
// "Start with Windows" on = the user wants them always running, so nothing closes.
const IDLE_MS = (+process.env.NODECUT_IDLE_SEC || 120) * 1000;
const GUARD_OFF = process.env.NODECUT_GUARD === 'off';   // test instances: never start or stop the real RenderGuard
let lastUse = Date.now(), startupCache = { at: 0, on: false };
async function alwaysOn() {
  if (Date.now() - startupCache.at > 60e3) { try { startupCache = { at: Date.now(), on: !!(await guardSettings()).Startup }; } catch { } }
  return startupCache.on;
}
setInterval(async () => {
  const g = guardState();
  // agent.busy() is part of "in use", not an afterthought: an agent writing a film is work the user asked for, and it
  // takes far longer than the idle window. Closing the hub here kills the child process with it, and because the
  // transcript is only saved when that process exits, the run leaves nothing behind at all — the same failure as a
  // crash, from a timer that thought the app was unused.
  if (clients.size || agent.busy() || jobs.busy() || cleanStatus()?.state === 'running' || notesApi.busyPictures() || media.makingCopies() || index().scanning || (!GUARD_OFF && g.running && (g.renders || []).length)) { lastUse = Date.now(); return; }
  if (Date.now() - lastUse < IDLE_MS || await alwaysOn()) return;
  console.log('NodeCut: not in use, closing together with the render protection.');
  if (!GUARD_OFF) await quitGuard().catch(() => { });
  agent.killAll();
  process.exit(0);
}, 20e3).unref();

// ---------- keeping each film's conversation short
// A long-lived film accumulates turns until the model runs out of room mid-sentence. The turn-end hook in agent.js covers
// the common case, but a film can sit untouched for weeks and still be over the line when it is opened again, so this
// sweep checks every film whose agent has a remembered conversation — every 15 minutes, only while the hub is being used,
// and never while a turn is running. Nothing is announced: a shortened conversation is housekeeping, and the person asked
// for none of it. See compactIfNeeded() for why this goes to the OpenCode server rather than through a run.
setInterval(() => {
  if (GUARD_OFF || !clients.size || agent.busy()) return;   // test instances and an unwatched hub do no housekeeping
  let list = [];
  try { list = scan().projects || []; } catch { return; }
  (async () => {
    for (const p of list) {
      if (agent.busy()) return;                               // someone started a turn while this was going: stop here
      try { await agent.maybeCompact(p.id, p.path); } catch { }
    }
  })();
}, 15 * 60e3).unref();
// A hub that is killed by Ctrl-C or by the terminal closing must take its agent children with it, or they are reparented
// to PID 1 and keep writing to a film with nobody watching. Same on the ordinary exit path.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { agent.killAll(); process.exit(0); });
process.on('exit', () => { try { agent.killAll(); } catch { } });
// "Start with Windows" (node scripts/install.mjs open --server at log-in): the hub stays on, so the render protection runs from the start
if (!GUARD_OFF) alwaysOn().then(on => { if (on) ensureGuard().catch(() => { }); }).catch(() => { });

// only this PC's own pages and tools: a page on another website (or a DNS name pointed at 127.0.0.1) must not drive
// the hub — its job queue can run commands. Claude's MCP tools, RenderGuard and scripts send no Origin/Sec-Fetch-Site.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
function foreign(req) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (!LOOPBACK.has(host)) return 'host';
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return 'site';
  const origin = req.headers.origin;
  if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    let o = null; try { o = new URL(origin); } catch { }
    if (!o || !LOOPBACK.has(o.hostname.toLowerCase().replace(/^\[(.*)\]$/, '[$1]')) || String(o.port || '80') !== String(server.address()?.port)) return 'origin';
  }
  return null;
}
const server = http.createServer(async (req, res) => {
  // A public tunnel exists only to hand OpenRouter one still for one submit. It is answered before the loopback-only
  // check on purpose, and it can reach nothing but the file a running job registered.
  if (genapi.tunnelServe(req, res)) return;
  const why = foreign(req);
  if (why) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('NodeCut: only NodeCut windows and tools on this computer may use this server (' + why + ')'); }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/api/ping') lastUse = Date.now();   // RenderGuard's keep-alive ping is not a use
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re); if (!m) continue;
      const out = await r.fn(req, url, m.groups || {}, res);
      if (out !== undefined && !res.headersSent) send(res, 200, out);
      return;
    }
    if (req.method !== 'GET') return send(res, 404, { error: 'not found' });
    // a film page for live preview: /live/<project id>/<file>; absolute URLs from such a page land here via its Referer
    if (url.pathname.startsWith('/live/')) {
      const [, , pid, ...rest] = url.pathname.split('/'), lp = project(pid);
      if (!lp) return send(res, 404, { error: 'not found' });
      return live.serve(req, res, lp, rest.join('/'));
    }
    // (browsers don't always send a Referer for module imports, so the cookie set by /live/<id>/... decides too)
    const ref = (req.headers.referer || '').match(/\/live\/([0-9a-f]{12})\//) || (req.headers.cookie || '').match(/(?:^|;\s*)vhlive=([0-9a-f]{12})/);
    if (ref && !fs.existsSync(path.join(UI, decodeURIComponent(url.pathname)))) { const lp = project(ref[1]); if (lp && fs.existsSync(path.join(lp.studio || lp.path, decodeURIComponent(url.pathname)))) return live.serve(req, res, lp, url.pathname.slice(1)); }
    // static UI
    let f = path.join(UI, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!isInside(f, UI) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(UI, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] ||'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (!res.headersSent) send(res, e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: String(e.message || e) });
  }
});

const port = +(process.env.NODECUT_PORT || config().port || 7788);
server.on('error', e => { if (e.code === 'EADDRINUSE') { console.error(`NodeCut is already running (port ${port}).`); process.exit(0); } throw e; });
server.listen(port, '127.0.0.1', () => {
  console.log(`NodeCut: http://127.0.0.1:${port}`);
  if (!index().at || index().projects.length === 0) scan().catch(e => console.error('scan:', e.message)); else scan().catch(() => { });
  if (process.env.NODECUT_JOBS !== 'off') jobs.resume();   // test instances never pick up the real render queue
});
