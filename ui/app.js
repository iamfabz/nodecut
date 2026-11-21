import { trashName, setSystemCapabilities, sameFolder } from './system.js';
import { agentName, setAgentName } from './agent.js';
// NodeCut UI: hash router + pages. No build step.
import { reviewPage } from './review.js';
import { outputsPanel, outputActions } from './outputs-panel.js';
import { activeRenders, elapsedSeconds, timeText, remainingText } from './render-status.js';
import { NOTE_STATUS_LABEL, NOTE_KIND_LABEL, PROJECT_STATUS_LABEL } from './values.js';

// ---------- tiny helpers
export const $ = (s, el = document) => el.querySelector(s);
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value' && tag === 'textarea') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
export async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
export const GB = b => !b ? '0' : b >= 1073741824 ? (b / 1073741824).toFixed(b >= 10737418240 ? 0 : 1) + ' GB' : b >= 1048576 ? Math.round(b / 1048576) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
export const DUR = s => { if (!s && s !== 0) return '—'; s = Math.round(s); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`; };
export const TC = s => { const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r.toFixed(2).padStart(5, '0')}`; };
export function AGO(ms) {
  if (!ms) return '—'; const d = (Date.now() - (typeof ms === 'number' ? ms : Date.parse(ms))) / 1000;
  if (d < 60) return 'just now'; if (d < 3600) return Math.floor(d / 60) + ' min ago'; if (d < 86400) return Math.floor(d / 3600) + ' h ago';
  if (d < 86400 * 30) return Math.floor(d / 86400) + ' days ago';
  return new Date(typeof ms === 'number' ? ms : Date.parse(ms)).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function toast(msg, err) { const el = h('div', { class: err ? 'err' : '' }, msg); $('#toast').append(el); setTimeout(() => el.remove(), err ? 7000 : 4000); }
export function confirmBox(title, body, okText = 'OK') {
  return new Promise(res => {
    const bg = h('div', { class: 'modal-bg' }, h('div', { class: 'modal' }, h('h1', {}, title), body,
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { onclick: () => { bg.remove(); res(false); } }, 'Cancel'), h('button', { class: 'primary', onclick: () => { bg.remove(); res(true); } }, okText))));
    (document.fullscreenElement || document.body).append(bg);   // in fullscreen only the fullscreen element shows
  });
}
// one field, one answer: resolves the text ('' is a real answer) or null when cancelled.
// `validate` returns an error message for a value the server would refuse, so the box can say so before sending.
export function promptBox(title, { label = '', value = '', placeholder = '', okText = 'Create', validate } = {}) {
  return new Promise(res => {
    const input = h('input', { type: 'text', value, placeholder, style: { width: '100%' } });
    const err = h('div', { class: 'sub red', style: { minHeight: '18px' } });
    let done = false, bg = null;
    const close = v => { if (done) return; done = true; bg.remove(); res(v); };
    const submit = () => { const v = input.value.trim(); const bad = v && validate ? validate(v) : (!v ? 'Give the film a name' : ''); if (bad) { err.textContent = bad; input.focus(); return; } close(v); };
    bg = h('div', { class: 'modal-bg' }, h('div', { class: 'modal' }, h('h1', {}, title),
      label ? h('div', { class: 'sub' }, label) : null, input, err,
      h('div', { class: 'row' }, h('span', { class: 'spacer' }),
        h('button', { onclick: () => close(null) }, 'Cancel'),
        h('button', { class: 'primary', onclick: submit }, okText))));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === 'Escape') { e.preventDefault(); close(null); } });
    bg.addEventListener('mousedown', e => { if (e.target === bg) close(null); });
    (document.fullscreenElement || document.body).append(bg);
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}
// A new film is a name AND a brief. The brief is what the film is for, and it is required: a folder with no brief is a
// folder somebody has to interrogate later. Returns { name, brief, editorV1, sourceVideo } or null.
//
// Editor V1 is an option on this dialog and nowhere else, because it is the one kind of film that cannot start from a
// brief alone: it needs a recording to edit. The card is present but locked until a video is attached, so the choice is
// visible before it is possible — a person should be able to see that the editor exists and understand exactly what
// unlocks it, rather than wonder why it appeared after they dropped a file.
export function newFilmBox({ existing = [], validate, editor = null } = {}) {
  return new Promise(res => {
    const name = h('input', { type: 'text', placeholder: 'e.g. Spring sale 30s', style: { width: '100%' } });
    const brief = h('textarea', {
      rows: 6, placeholder: 'e.g. A 20 second luxury brand film for a candle that smells of old libraries. Dark, slow, no voiceover.',
      style: { width: '100%', resize: 'vertical', font: 'inherit', lineHeight: '1.5' },
    });
    const err = h('div', { class: 'sub red', style: { minHeight: '18px' } });
    // ---- the recorded film, and the editor that can only exist with one
    let sourceVideo = null;      // { name, data } once a real video file is attached
    let useEditor = false;       // only ever true while a video is attached
    const videoName = h('span', { class: 'ev1-file' }, 'no video attached');
    const hint = h('div', { class: 'ev1-hint' }, 'Upload a source video to unlock Editor V1');
    const pick = h('input', { type: 'file', accept: 'video/*,.mp4,.mov,.mkv,.m4v,.webm,.avi', hidden: true });
    const card = h('div', { class: 'ev1-card locked' },
      h('div', { class: 'ev1-top' },
        h('div', { class: 'ev1-title', role: 'button', tabindex: '0' }, 'Editor V1'),
        h('div', { class: 'ev1-filewrap' }, videoName)),
      h('div', { class: 'ev1-desc' }, 'Cuts a recording you already have into a fast documentary-style film. Needs the recording; it cannot start from a brief.'));
    const attach = h('button', { type: 'button', class: 'ev1-attach' }, 'Choose video…');
    const clear = h('button', { type: 'button', class: 'ev1-attach ev1-clear', hidden: true }, 'Remove');
    card.append(h('div', { class: 'ev1-actions' }, attach, clear));
    card.append(hint);

    const isVideo = (n) => /\.(mp4|mov|mkv|m4v|webm|avi)$/i.test(String(n || ''));
    const setLocked = (why) => {
      card.classList.toggle('locked', true);
      card.classList.remove('active');
      hint.textContent = why;
    };
    const setUnlocked = (n) => {
      card.classList.remove('locked');
      videoName.textContent = n;
      hint.textContent = 'Editor V1 will cut this recording. Click the card to use it.';
      clear.hidden = false;
      attach.textContent = 'Change video…';
    };
    const toggleEditor = () => {
      if (!sourceVideo) return;          // a locked card cannot be selected: that is the whole gate
      useEditor = !useEditor;
      card.classList.toggle('active', useEditor);
      hint.textContent = useEditor ? 'Editor V1 is on for this film. Click again to make a blank film instead.'
        : 'Editor V1 will cut this recording. Click the card to use it.';
    };
    card.querySelector('.ev1-title').addEventListener('click', toggleEditor);
    card.querySelector('.ev1-title').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleEditor(); } });
    attach.addEventListener('click', () => pick.click());
    pick.addEventListener('change', async () => {
      const f = pick.files && pick.files[0];
      if (!f) return;
      if (!isVideo(f.name)) { err.textContent = 'That is not a video. Editor V1 needs MP4, MOV, MKV, M4V, WEBM or AVI.'; return; }
      if (f.size > 4 * 1024 * 1024 * 1024) { err.textContent = 'That video is larger than 4 GB. Trim it first.'; return; }
      setLocked('Reading the video…');
      try {
        const data = await new Promise((ok, no) => {
          const r = new FileReader();
          r.onload = () => ok(String(r.result || ''));
          r.onerror = () => no(new Error('the file could not be read'));
          r.readAsDataURL(f);
        });
        sourceVideo = { name: f.name, data };
        setUnlocked(f.name);
        err.textContent = '';
        // attaching a recording is the strongest signal of intent there is, so the editor turns on by itself
        if (!useEditor) toggleEditor();
      } catch (e) {
        sourceVideo = null; useEditor = false;
        setLocked('Upload a source video to unlock Editor V1');
        err.textContent = 'Could not read that video: ' + e.message;
      }
    });
    clear.addEventListener('click', () => {
      sourceVideo = null; useEditor = false; pick.value = '';
      card.classList.remove('active');
      videoName.textContent = 'no video attached';
      attach.textContent = 'Choose video…';
      clear.hidden = true;
      setLocked('Upload a source video to unlock Editor V1');
    });
    // An editor that is not installed is said plainly and the card stays locked, because an option that cannot run is
    // worse than no option: the person would create the film and only then discover it.
    if (editor && editor.usable === false) setLocked(editor.reason || 'Editor V1 is not available on this computer.');

    let done = false, bg = null;
    const close = v => { if (done) return; done = true; bg.remove(); res(v); };
    const submit = () => {
      const n = name.value.trim(), b = brief.value.trim();
      if (!n) { err.textContent = 'Give the film a name'; name.focus(); return; }
      const bad = validate ? validate(n) : (existing.some(x => String(x).toLowerCase() === n.toLowerCase()) ? 'A project with that name already exists' : '');
      if (bad) { err.textContent = bad; name.focus(); return; }
      if (!b) { err.textContent = 'Describe what the film should be. The brief is what the film is built from.'; brief.focus(); return; }
      if (b.length < 20) { err.textContent = `That is too short (${b.length} of 20 characters). Say what it is, who watches it and how long it should be.`; brief.focus(); return; }
      close({ name: n, brief: b, editorV1: useEditor && !!sourceVideo, sourceVideo: useEditor ? sourceVideo : null });
    };
    bg = h('div', { class: 'modal-bg' }, h('div', { class: 'modal modal-brief' }, h('h1', {}, 'New film'),
      h('div', { class: 'sub' }, 'A folder with that name goes into your films folder, from the NodeCut starter.'),
      h('label', { class: 'field-label' }, 'Name'), name,
      h('label', { class: 'field-label' }, 'What is this film?'), brief,
      h('div', { class: 'sub dim' }, 'The more specific, the better: what it is for, who watches it, how long, and anything it must not look like. The NodeCut team picks the pipeline and the craft files from this.'),
      card, pick,
      err,
      h('div', { class: 'row' }, h('span', { class: 'spacer' }),
        h('button', { onclick: () => close(null) }, 'Cancel'),
        h('button', { class: 'primary', onclick: submit }, 'Create film'))));
    // Enter submits the name; ⌘/Ctrl+Enter submits from the brief (a plain Enter is a new line there)
    name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === 'Escape') { e.preventDefault(); close(null); } });
    brief.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });
    bg.addEventListener('mousedown', e => { if (e.target === bg) close(null); });
    (document.fullscreenElement || document.body).append(bg);
    setTimeout(() => name.focus(), 0);
  });
}
const STATUSES = ['in-progress', 'review', 'revision', 'approved', 'published', 'archived'];
const FAMILY = { A: 'chunked', B: 'worker chunks', C: 'segmented', otomasyon: 'automation', snipp: 'Snipp', media: 'video folder', code: 'code', other: 'other' };
const ROLE = { final: 'final with audio', web: 'web copy', preview: 'preview', clip: 'test clip', silent: 'silent', broken: 'broken' };
export const pill = (cls, text) => h('span', { class: 'pill ' + String(cls).replace(/\s/g, '-') }, text);
// one EventSource for the whole app: a panel subscribes with onSse(type, fn) and gets an unsubscribe back
const sseSubs = new Map();
export function onSse(type, fn) {
  if (!sseSubs.has(type)) { sseSubs.set(type, new Set()); es.addEventListener(type, e => { let d = null; try { d = JSON.parse(e.data); } catch { } for (const f of sseSubs.get(type)) f(d); }); }
  sseSubs.get(type).add(fn);
  return () => { sseSubs.get(type)?.delete(fn); };
}

// ---------- live data (SSE)
let rendersCache = null; const renderSubs = new Set();
const es = new EventSource('/api/events');
// NodeCut closes itself when unused; if this window outlived it, say how to bring it back (EventSource keeps retrying)
let downTimer = null;
const downBar = h('div', { class: 'downbar', hidden: true }, 'The NodeCut server is off (it shut down because it was idle). Click the NodeCut shortcut on your desktop; this window will reconnect automatically.');
document.body.append(downBar);
es.addEventListener('error', () => { if (!downTimer) downTimer = setTimeout(() => { downBar.hidden = false; }, 4000); });
es.addEventListener('open', () => { clearTimeout(downTimer); downTimer = null; if (!downBar.hidden) location.reload(); });
// no pop-up messages for things the user did not just do: lists and badges update silently
let userScan = false, uiVersion = null, reloadPending = false;
export const markUserScan = () => { userScan = true; };
const busyWriting = () => !!document.querySelector('.composer, .rv2-composer, .rv2-drafts:not([hidden]), .nc textarea, .textin:not([hidden])');
function reloadWhenIdle() {
  if (busyWriting()) { reloadPending = true; return; }   // never lose a note being written
  location.reload();
}
setInterval(() => { if (reloadPending && !busyWriting()) location.reload(); }, 3000);
es.addEventListener('hello', e => { const v = JSON.parse(e.data).v; if (uiVersion && v && v !== uiVersion) reloadWhenIdle(); uiVersion = v; });
es.addEventListener('version', e => { const v = JSON.parse(e.data).v; if (v !== uiVersion) reloadWhenIdle(); });
es.addEventListener('renders', e => { rendersCache = JSON.parse(e.data); updateLive(); for (const f of renderSubs) f(rendersCache); });
es.addEventListener('scan', e => {
  const ev = JSON.parse(e.data);
  if (ev.phase === 'done') { if (userScan) toast(`Scan complete: ${ev.count} projects`); userScan = false; refreshProjectList(); }
  if (ev.phase === 'error' && userScan) { toast('Scan error: ' + ev.error, true); userScan = false; }
});
es.addEventListener('job', e => {
  // a render ended: a notice that stays a while, with the way to the video; the "new" counts follow
  let ev = null; try { ev = JSON.parse(e.data); } catch { }
  const j = ev?.job;
  if (j && rendersCache) {
    const jobs = [...(rendersCache.jobs || [])], at = jobs.findIndex(x => x.id === j.id);
    if (at >= 0) jobs[at] = j; else jobs.unshift(j);
    rendersCache = { ...rendersCache, jobs }; updateLive();
  }
  for (const f of renderSubs) f(rendersCache);
  if (ev?.type === 'done' && j) longToast(h('div', { class: 'render-finished' },
    h('b', {}, 'Render finished: ' + j.projectName + (j.version ? ' v' + j.version : '')),
    j.outputPath ? outputActions({ file: j.outputPath, exists: true, projectId: j.project, rel: j.output }) : null,
    h('a', { href: '#/outputs' }, 'View recent renders →')));
  if (ev?.type === 'failed' && j) longToast(h('span', {}, `❌ Render failed: ${j.projectName} — ${j.error || ''} `, h('a', { href: '#/renders' }, 'Details')), true);
});
function longToast(node, err) { const el = h('div', { class: err ? 'err' : '' }, node); $('#toast').append(el); setTimeout(() => el.remove(), 15000); }
// The "N new" counters that used to hang off the Home and Renders links are gone by request: they nagged about
// unwatched outputs the user had usually just looked at. The badge spans stay in the markup, hidden and never
// filled, so any other code that looks them up still finds them.
// window.__vhNewCount stays as a no-op: the review page and the outputs panel call it whenever they mark an output
// as seen, and they should keep working without a badge to update.
window.__vhNewCount = () => { };
// Claude asked to show a page (hub_live): go there, unless a note is being written
es.addEventListener('navigate', e => {
  let d = null; try { d = JSON.parse(e.data); } catch { } if (!d?.hash || location.hash === d.hash) return;
  if (busyWriting()) { toast(h('span', {}, `${agentName()} wants to open a page. After saving your note: `, h('a', { href: d.hash }, 'open'))); return; }
  location.hash = d.hash; try { window.focus(); } catch { }
});
// new projects from other chats: rescan when the window comes back to the front (the hub skips it if it scanned < 1 min ago)
const softScan = () => { if (document.visibilityState === 'visible') fetch('/api/scan?soft=1', { method: 'POST' }).catch(() => { }); };
window.addEventListener('focus', softScan); document.addEventListener('visibilitychange', softScan);
// redraw the project list after a scan, unless the user is typing in it; keep the scroll position
async function refreshProjectList() {
  const name = location.hash.replace(/^#\/?/, '').split('/')[0] || 'projects';
  if (name !== 'projects' || document.activeElement?.matches('input, textarea, select')) return;
  const main = $('#main'), y = main.scrollTop; await render(); main.scrollTop = y;
}
// pages subscribe to other server events (e.g. 'proxy') through this
const hubSubs = {};
export function onHubEvent(type, fn) {
  if (!hubSubs[type]) { hubSubs[type] = new Set(); es.addEventListener(type, e => { let d = null; try { d = JSON.parse(e.data); } catch { } for (const f of hubSubs[type]) f(d); }); }
  hubSubs[type].add(fn); return () => hubSubs[type].delete(fn);
}
// what this computer is. Read once; only free RAM (from the render feed) and free disk are live.
let machineInfo = null;
api('/api/machine').then(m => { machineInfo = m; updateLive(); }).catch(() => { });

function updateLive() {
  const g = rendersCache?.guard, n = activeRenders(rendersCache).filter(r => r.state !== 'queued').length;
  const c = $('#renderCount'); c.hidden = !n; c.textContent = n;
  const box = $('#live'); box.innerHTML = '';

  // a compact spec sheet: one short line per fact, dim enough to stay furniture. Each line is dropped when it is
  // not known rather than shown as a dash, so a missing GPU does not leave a hole in the panel.
  if (machineInfo) {
    const { os: osName, cpu, cores, gpu, disk } = machineInfo;
    const line = (k, v, title) => v ? h('div', { class: 'mrow', title: title || v }, h('span', { class: 'mk' }, k), h('span', { class: 'mv' }, v)) : null;
    box.append(...[
      line('OS', osName),
      line('CPU', cpu ? `${cpu}${cores ? ' ×' + cores : ''}` : null),
      gpu ? line('GPU', gpu) : null,
      disk ? line('Disk', `${disk.freeGB} GB free`, `${disk.freeGB} GB free of ${disk.totalGB} GB`) : null,
    ].filter(Boolean));
  }

  box.append(
    g?.running
      ? h('div', { class: 'mrow' }, h('span', { class: 'mk' }, 'RAM'), h('span', { class: 'mv' }, `${(g.ramAvailMB / 1024).toFixed(1)} GB free`))
      : h('div', { class: 'dim' }, 'Render protection is off'),
    g?.running && g.renders?.some(r => r.slow) ? h('div', { class: 'accent' }, '🐢 a render is slowed down') : '',
  );
}

// ---------- router
const pages = { outputs: outputsPage, projects: projectsPage, p: projectPage, review: reviewPage, renders: rendersPage, disk: diskPage, settings: settingsPage };
let cleanup = null;
async function render() {
  await agentReady;
  const [name = 'projects', ...args] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  document.querySelectorAll('[data-nav]').forEach(a => {
    // Disk is a child of Settings, so the parent stays lit (but not the child styling) while Disk is open
    const isHome = a.dataset.nav === 'projects';
    const on = a.dataset.nav === (name === 'p' || name === 'review' ? 'projects' : name)
      || (a.dataset.nav === 'settings' && name === 'disk');
    a.classList.toggle('on', on);
    a.classList.toggle('parent-on', on && a.classList.contains('sub') === false && name === 'disk');
  });
  if (cleanup) { try { cleanup(); } catch { } cleanup = null; }
  // The watermark belongs to every page except the live preview, where a film is on screen and a mark over the picture
  // is a defect. `~live` is the same check the router already uses to pick the live viewer, so the two can never
  // disagree about which page is playing.
  const wm = document.getElementById('wm');
  if (wm) wm.classList.toggle('away', name === 'review' && args[1] === '~live');
  const main = $('#main'); main.innerHTML = '';
  const page = h('div', { class: 'page' }); main.append(page);
  try { cleanup = await (pages[name] || projectsPage)(page, ...args.map(decodeURIComponent)) || null; }
  catch (e) { page.append(h('div', { class: 'empty' }, 'Error: ' + e.message)); }
}
const agentReady = api('/api/config').then(c => { setAgentName(c.agentName); setSystemCapabilities(c.capabilities); }).catch(() => {});

// ---------- the sidebar can be put away
// Collapsing it gives the whole window to the page, which is the point on the editor, where the timeline and the
// side panel want every pixel. The state is remembered, and it is driven by a class on .app so CSS owns the
// animation and the layout at once.
{
  const app = $('.app');
  const hideBtn = $('#sideToggle'), showBtn = $('#sideReveal');
  const KEY = 'nodecut.sideHidden';
  const apply = hidden => {
    app.classList.toggle('side-hidden', hidden);
    hideBtn.setAttribute('aria-expanded', String(!hidden));
    showBtn.hidden = !hidden;
    try { localStorage.setItem(KEY, hidden ? '1' : '0'); } catch { }
  };
  let startHidden = false;
  try { startHidden = localStorage.getItem(KEY) === '1'; } catch { }
  apply(startHidden);
  hideBtn.onclick = () => apply(true);
  showBtn.onclick = () => apply(false);
  // Ctrl/Cmd+B is the usual "toggle the sidebar" everywhere else, so it is the obvious key here
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
      e.preventDefault(); apply(!app.classList.contains('side-hidden'));
    }
  });
}
window.addEventListener('hashchange', render);
render();

// ---------- first run: no projects yet → where films go, the example film, adding a folder
async function welcomePanel() {
  const c = await api('/api/config').catch(() => ({ roots: [] }));
  const on = (c.roots || []).filter(r => r.enabled !== false), ex = c.example || {};
  const box = h('div', { class: 'panel', style: { marginTop: '14px', maxWidth: '860px' } },
    h('h2', { style: { marginTop: 0 } }, 'Welcome to NodeCut'),
    h('p', {}, `NodeCut lists the film projects in the folders it watches. Ask ${agentName()} for a video: it builds the film as code in one of these folders, opens it here in the live preview (no render), and you leave notes on the frames and press "Send to ${agentName()}".`),
    h('div', { class: 'sub' }, on.length ? 'Watched now:' : 'No folder is watched yet.'),
    on.length ? h('ul', { style: { margin: '4px 0 10px' } }, on.map(r => h('li', { class: 'mono', style: { fontSize: '12.5px' } }, r.path))) : null,
    h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
      ex.available && !ex.installed ? h('button', { class: 'primary', onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = 'Adding…';
        try { const r = await api('/api/example/install', { method: 'POST' }); toast('Example film added: ' + r.path); render(); } catch (err) { toast('Could not add the example: ' + err.message, true); e.target.disabled = false; }
      } }, '▶ Add the example film') : null,
      ex.installed ? h('span', { class: 'dim' }, 'The example film is in ' + ex.target + ' (scanning…)') : null,
      h('button', { onclick: () => location.hash = '#/settings' }, '📂 Add a folder…')),
    c.workspace ? h('div', { class: 'sub', style: { marginTop: '10px' } }, 'Your workspace (films, outputs, sounds, thumbnails, archive): ', h('span', { class: 'mono' }, c.workspace)) : null,
    h('div', { class: 'row', style: { gap: '8px', marginTop: '8px', alignItems: 'center' } }, h('span', { class: 'sub' }, 'Render speed:'), renderSpeedControl(c)),
    h('p', { class: 'dim', style: { fontSize: '12.5px', marginBottom: 0 } }, 'The example (examples\\hello-film) is a 10-second film that shows the whole loop: live preview, notes, a chunked render with sound, partial re-renders. What a film folder needs is described in docs\\PROJECT-CONTRACT.md.'));
  return box;
}

// the encoder renders use (config render.encoder → NODECUT_ENCODER for render scripts): a select that saves at once,
// with what this PC can use (GET /api/encoders probes once, then it is cached)
function renderSpeedControl(c) {
  const cur = c.render?.encoder || 'auto';
  const sel = h('select', { disabled: true, title: 'Which encoder turns the frames into the MP4' }, h('option', { value: cur }, cur));
  const note = h('span', { class: 'dim', style: { fontSize: '12.5px' } }, 'checking this PC…');
  api('/api/encoders').then(e => {
    const has = new Set(e.available || []), L = e.labels || {};
    sel.replaceChildren(...['auto', 'nvenc', 'amf', 'qsv', 'vaapi', 'videotoolbox', 'x264'].map(v => h('option', { value: v, selected: v === cur, disabled: v !== 'auto' && v !== cur && !has.has(v) },
      (L[v] || v) + (v !== 'auto' && v !== 'x264' && !has.has(v) ? ' (not on this PC)' : ''))));
    sel.disabled = false;
    note.textContent = e.best && e.best !== 'x264' ? `This PC can encode on its graphics card (${e.best}${e.gpus?.length ? ', ' + e.gpus[0] : ''}): same quality, usually faster.` : 'No graphics-card encoder found: renders use the processor (x264).';
  }).catch(() => { sel.disabled = false; note.textContent = ''; });
  sel.onchange = async () => { try { await api('/api/config', { method: 'POST', body: { render: { encoder: sel.value } } }); toast('Render speed saved: ' + sel.selectedOptions[0].textContent); } catch (err) { toast('Could not save: ' + err.message, true); } };
  return h('span', { class: 'row', style: { gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, sel, note);
}

// ---------- Projects
const state ={ q: '', status: '', family: '', root: '', sort: 'updated' };
async function projectsPage(page) {
  const data = await api('/api/projects');
  const ps = data.projects;
  // New film: copies the starter into the films folder, then opens its live preview. Creating the film also sends the
  // first turn to the agent, because a film that only exists as an empty folder is not what the person asked for — they
  // described a film they want to watch. If the agent could not start, the live page can start it again from the button
  // the agent panel shows, so this is a hand-off, not a dead end.
  const newFilm = async () => {
    // Editor V1's availability is asked for before the dialog opens, so the card can be locked with a reason rather than
    // failing after the person has typed a brief and waited for a folder.
    let editor = null;
    try { editor = await api('/api/editor-v1'); } catch { editor = { usable: false, reason: 'NodeCut could not check whether Editor V1 is installed.' }; }
    const got = await newFilmBox({
      existing: ps.map(p => p.title),
      validate: v => /[\\/:*?"<>|]/.test(v) ? 'A folder name cannot contain \\ / : * ? " < > |' : '',
      editor,
    });
    if (!got) return;
    try {
      const p = await api('/api/projects/new', {
        method: 'POST',
        body: { name: got.name, brief: got.brief, editorV1: !!got.editorV1, sourceVideo: got.sourceVideo || null },
      });
      const r = p.route;
      const began = p.started && p.started.started;
      const why = p.started && p.started.error ? ` · ${p.started.error}` : '';
      const isEdit = !!p.editor;
      toast(
        began ? `${isEdit ? 'Editing' : 'Building'} "${p.title}" — the agent is working on it now`
        : `Created "${p.title}" but the agent did not start${why}`,
        !began,
      );
      location.hash = `#/review/${p.id}/~live`;   // straight into the preview: the film is being written as you watch
    } catch (e) { toast('Could not create the film: ' + e.message, true); }
  };
  // toolbar: title, then icon-only utilities (Refresh / Outputs folder) so the row reads as one control group
  const rescanBtn = h('button', { class: 'iconbtn', title: 'Rescan folders for new films', 'aria-label': 'Rescan',
    onclick: async () => { markUserScan(); await api('/api/scan', { method: 'POST' }); toast('Scan started…'); } }, '⟳');
  const outputsBtn = h('button', { class: 'iconbtn', title: 'Recent renders and the outputs folder', 'aria-label': 'Outputs folder',
    onclick: () => { location.hash = '#/outputs'; } }, '📂');
  // Search: a magnifying glass in the toolbar that opens a field in place. The field is only in the layout while it
  // is open, so the toolbar stays three controls wide in normal use; Escape or the same button closes it and clears
  // the query, and any open search closes itself when the page is left.
  const searchInput = h('input', {
    type: 'search', class: 'toolbar-search', placeholder: 'Search films…', value: state.q, 'aria-label': 'Search films',
    oninput: e => { state.q = e.target.value; draw(); },
    onkeydown: e => { if (e.key === 'Escape') { state.q = ''; searchInput.value = ''; closeSearch(); draw(); } },
  });
  const searchBtn = h('button', { class: 'iconbtn', title: 'Search films', 'aria-label': 'Search films', 'aria-expanded': 'false',
    onclick: () => document.body.classList.contains('search-open') ? closeSearch() : openSearch() }, '🔍');
  function openSearch() {
    document.body.classList.add('search-open');
    searchBtn.setAttribute('aria-expanded', 'true');
    searchInput.focus();
  }
  function closeSearch() {
    document.body.classList.remove('search-open');
    searchBtn.setAttribute('aria-expanded', 'false');
  }
  // the button does nothing on its own when the page is gone
  const searchWrap = h('div', { class: 'toolbar-search-wrap' }, searchInput, searchBtn);
  page.append(h('div', { class: 'row toolbar' }, h('h1', {}, 'Projects'), h('span', { class: 'spacer' }),
    h('button', { class: 'primary', onclick: newFilm, title: 'Create a film from a brief — or, with a recording, an Editor V1 edit' }, '＋ New film'),
    h('div', { class: 'icongroup' }, searchWrap, rescanBtn, outputsBtn)));
  const total = ps.reduce((s, p) => s + (p.sizes?.total || 0), 0);
  const open = ps.reduce((s, p) => s + (p.notesOpen || 0), 0);
  const tiles = h('div', { class: 'tiles' },
    tile('Projects', ps.length),
    tile('Total size', GB(total)),
    tile('Render leftovers', h('span', { id: 'cleanTile', title: 'Space recoverable with safe cleanup (Disk page)' }, '…'), () => location.hash = '#/disk'),
    tile('Open notes', open),
  );
  page.append(h('div', { class: 'sub' }, data.at ? `Last scan ${AGO(data.at)}` : 'Scanning…'), tiles);
  if (!ps.length && !data.scanning) page.append(await welcomePanel());
  api('/api/disk').then(d => { const s = d.candidates.filter(c => c.preset === 'safe').reduce((a, c) => a + c.size, 0); const el = $('#cleanTile'); if (el) el.textContent = GB(s); }).catch(() => { });

  const grid = h('div', { class: 'grid' }); page.append(grid);
  function draw() {
    thumbObserver.disconnect();
    const q = state.q.toLocaleLowerCase('en-US');
    let list = ps.filter(p => (!q || (p.title + ' ' + p.label).toLocaleLowerCase('en-US').includes(q)) && (!state.status || p.status === state.status) && (!state.family || p.family === state.family) && (!state.root || p.root === state.root));
    const bloat = p => p.finalSize ? p.sizes.total / p.finalSize : 0;
    list.sort({ updated: (a, b) => b.updated - a.updated, size: (a, b) => b.sizes.total - a.sizes.total, bloat: (a, b) => bloat(b) - bloat(a), notes: (a, b) => b.notesOpen - a.notesOpen, name: (a, b) => a.title.localeCompare(b.title, 'en-US') }[state.sort]);
    grid.innerHTML = '';
    if (!list.length) grid.append(h('div', { class: 'empty' }, 'No matching projects.'));
    for (const p of list.slice(0, 300)) grid.append(projectCard(p));
  }
  draw();
  return () => { thumbObserver.disconnect(); };
}
// load a card's picture only when it scrolls into view
const thumbObserver = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const el = e.target; thumbObserver.unobserve(el);
    if (!el.isConnected) continue;
    const img = new Image();
    img.onload = () => { if (el.isConnected) { el.style.backgroundImage = `url(${img.src})`; el.querySelector('.noimg')?.remove(); } };
    img.onerror = () => { if (el.isConnected && !el.querySelector('.noimg')) el.append(h('div', { class: 'noimg' }, el.dataset.live ? 'Open live preview' : 'Cover is not ready yet')); };
    // Cached live cover, or a frame from the last video. Loading a card never starts the film engine.
    img.src = `/api/thumb/${el.dataset.thumb}?${el.dataset.live ? 'source=live&' : ''}v=${encodeURIComponent(el.dataset.version || '')}`;
  }
}, { rootMargin: '200px' });
function tile(k, v, onclick) { return h('div', { class: 'tile nodecut-glass-card' + (onclick ? ' click' : ''), onclick }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)); }
function projectCard(p) {
  // the picture plays the film; the rest of the card opens the project page
  const thumb = h('div', { class: 'thumb' + (p.outputsCount ? ' playable' : ''), title: p.live ? 'Live preview from the latest code' : p.outputsCount ? 'Play the latest render' : null,
    onclick: e => { e.stopPropagation(); openProject(p); } },
    p.sizes?.total ? h('span', { class: 'size', title: 'Size of the whole film folder' }, GB(p.sizes.total)) : null,
    p.latestDur ? h('span', { class: 'dur' }, DUR(p.latestDur)) : null, p.outputsCount ? h('span', { class: 'play' }, '▶') : null);
  if (!p.outputsCount) thumb.append(h('div', { class: 'noimg' }, p.emptyNote || 'no video yet'));
  if (p.outputsCount || p.live) { thumb.dataset.thumb = p.id; thumb.dataset.version = p.thumbVersion || p.updated || ''; if (p.live) thumb.dataset.live = '1'; thumbObserver.observe(thumb); }
  // A card is a poster, a name with its size, and the two things you do to it. Status pills, family, note counts,
  // bloat ratios and timestamps all used to sit here and made the grid read as a data table; the detail is one click
  // away on the project page, which is where it belongs. The size stays because it is the one figure you scan a grid
  // of films for.
  return h('div', { class: 'card', onclick: () => openProject(p) }, thumb,
    h('div', { class: 'body' },
      h('div', { class: 'cardline' },
        h('div', { class: 't', title: p.label }, p.title),
        h('button', { class: 'cardbtn', title: 'Open folder in file manager', onclick: e => { e.stopPropagation(); openFolder(p.id); } }, '📂'),
        h('button', { class: 'cardbtn', title: `Remove project… (from the list or to the ${trashName()})`, onclick: e => { e.stopPropagation(); removeProject(p, () => render()); } }, '🗑')),
    ));
}

// a project opens where the work happens: its live preview, else its newest video, else the project page
async function openProject(p) {
  const li = await api(`/api/project/${p.id}/live?probe=1`).catch(() => null);
  if (li?.ok) location.hash = `#/review/${p.id}/~live`;
  else if (p.outputsCount && p.latest) location.hash = `#/review/${p.id}/${encodeURIComponent(p.latest)}`;
  else location.hash = '#/p/' + p.id;
}
// "Remove": hide it from the list (no file touched, restore from Settings) or send its folder to the system Trash
export async function removeProject(p, after) {
  let mode = 'hide';
  const opt = (m, label, sub) => h('label', { class: 'row', style: { gap: '8px', alignItems: 'flex-start', margin: '8px 0' } },
    h('input', { type: 'radio', name: 'rmp', checked: mode === m, onchange: () => { mode = m; } }), h('div', {}, h('b', {}, label), h('div', { class: 'dim', style: { fontSize: '12.5px' } }, sub)));
  const where = p.group ? `${p.path} · ${(p.groupFiles || []).length} files` : p.path + (p.studio && p.outDir ? `  +  ${p.outDir}` : '');
  const ok = await confirmBox(`Remove "${p.title || p.name}"?`, h('div', {},
    h('div', { class: 'mono', style: { fontSize: '12.5px', wordBreak: 'break-all', margin: '4px 0 8px' } }, where),
    h('div', { class: 'muted' }, `Size: ${GB(p.sizes?.total || 0)}`),
    opt('hide', 'Remove from list', 'NodeCut will hide this project without changing any files. Restore it from Settings → Hidden projects.'),
    opt('delete', `Delete folder (${trashName()})`, p.group ? `This film’s files go to the ${trashName()}, where you can restore them.` : `The entire project folder goes to the ${trashName()}, where you can restore it. Unavailable while rendering.`)), 'Apply');
  if (!ok) return false;
  try {
    if (mode === 'hide') { await api(`/api/project/${p.id}/hide`, { method: 'POST' }); toast('Removed from list (Settings → Hidden projects)'); }
    else {
      toast(`Sending to ${trashName()}…`);
      const r = await api(`/api/project/${p.id}/delete-folder`, { method: 'POST' });
      if (r.ok) toast(`Sent to ${trashName()} · ${GB(p.sizes?.total || 0)} freed`); else toast('Could not delete: ' + (r.error || ''), true);
    }
  } catch (e) { toast(e.message, true); return false; }
  after && after(); return true;
}

// ---------- Project
// the project folder (or a video's folder with the video selected) in the file manager
export const openFolder = (id, file) => api(`/api/project/${id}/open-folder`, { method: 'POST', body: file ? { file } : {} }).catch(e => toast(e.message, true));
async function projectPage(page, id) {
  const p = await api('/api/project/' + id);
  const latest = p.outputs.find(o => o.rel === p.latest);
  // live preview: watch the film from its code, no render (shown only when the film page supports it)
  const liveBtn = h('button', { hidden: true, title: `The film plays from its code and refreshes automatically when ${agentName()} updates it`, onclick: () => location.hash = `#/review/${id}/~live` }, "▶ Live preview (no render)");
  api(`/api/project/${id}/live?probe=1`).then(li => { if (li?.ok) { liveBtn.hidden = false; liveBtn.classList.add('primary'); /* always prominent: the code is usually newer than the last render */ } }).catch(() => { });
  const statusSel = h('select', { onchange: async e => { await api(`/api/project/${id}/meta`, { method: 'POST', body: { status: e.target.value } }); toast('Status saved'); } },
    (STATUSES.includes(p.status) ? STATUSES : [p.status, ...STATUSES]).map(s => h('option', { value: s, selected: s === p.status }, PROJECT_STATUS_LABEL[s] || s)));
  page.append(
    h('div', { class: 'sub' }, h('a', { href: '#/' }, 'Projects'), ' / ', p.label),
    h('div', { class: 'row', style: { marginTop: '6px' } }, h('h1', {}, p.title), pill('fam', FAMILY[p.family] || p.family), h('span', { class: 'spacer' }),
      latest ? h('button', { class: 'primary', onclick: () => location.hash = `#/review/${id}/${encodeURIComponent(latest.rel)}` }, 'Review') : null,
      liveBtn,
      h('button', { title: p.path, onclick: () => openFolder(id) }, '📂 Open folder'),
      h('button', { onclick: async () => { await api(`/api/project/${id}/rescan`, { method: 'POST' }); render(); } }, 'Rescan'),
      h('button', { class: 'ghost', title: `Remove from the list or send the folder to the ${trashName()}`, onclick: () => removeProject(p, () => { location.hash = '#/'; }) }, '🗑 Remove…'),
      h('span', { class: 'muted' }, 'Status'), statusSel),
  );
  // videos
  page.append(h('h2', {}, `Videos (${p.outputs.length})`));
  if (!p.outputs.length) page.append(h('div', { class: 'empty' }, 'No videos in this project yet.'));
  else page.append(h('div', { class: 'panel nodecut-glass-card', style: { padding: '4px 6px' } }, h('table', { class: 't' },
    h('tr', {}, h('th', {}, 'File'), h('th', {}, 'Type'), h('th', { class: 'num' }, 'Duration'), h('th', { class: 'num' }, 'Resolution'), h('th', { class: 'num' }, 'Size'), h('th', { class: 'num' }, 'Date'), h('th', {})),
    p.outputs.map(o => h('tr', {},
      h('td', {}, h('span', { class: 'ellip', title: o.path }, o.rel), o.dupOf ? h('div', { class: 'dim', style: { fontSize: '12px' } }, 'copy of: ' + o.dupOf.split(/[\\/]/).slice(-2).join('/')) : null, o.role === 'silent' && o.coveredBy ? h('div', { class: 'dim', style: { fontSize: '12px' } }, 'video included in: ' + o.coveredBy) : null),
      h('td', {}, pill(o.role, ROLE[o.role] || o.role)),
      h('td', { class: 'num' }, DUR(o.dur)), h('td', { class: 'num muted' }, o.w ? `${o.w}×${o.h} ${Math.round(o.fps)}fps` : '—'),
      h('td', { class: 'num' }, GB(o.size)), h('td', { class: 'num muted' }, AGO(o.mtime)),
      h('td', { class: 'num' }, h('button', { class: 'ghost', onclick: () => location.hash = `#/review/${id}/${encodeURIComponent(o.rel)}` }, 'Watch / add notes'),
        h('button', { class: 'ghost', title: 'Show in folder (file selected)', onclick: () => openFolder(id, o.rel) }, 'Show')))),
  )));
  // disk
  const S = p.sizes || {}, parts = [['output', 'Videos', 'var(--green)'], ['chunk', 'Render chunks', 'var(--accent)'], ['oldChunk', 'Old chunks', 'var(--red)'], ['part', 'Part/segment', 'var(--yellow)'], ['profile', 'Chrome profiles', 'var(--red)'], ['snap', 'Check frames', 'var(--blue)'], ['audio', 'Audio', 'var(--violet)'], ['other', 'Code and other files', 'var(--dim)']];
  page.append(h('h2', {}, `Disk · ${GB(S.total)}`), h('div', { class: 'panel' },
    h('div', { class: 'stack' }, parts.map(([k, , c]) => S[k] ? h('i', { style: { width: (100 * S[k] / S.total) + '%', background: c }, title: GB(S[k]) }) : null)),
    h('div', { class: 'legend' }, parts.filter(([k]) => S[k]).map(([k, t, c]) => h('span', {}, h('b', { style: { background: c } }), `${t} ${GB(S[k])}`))),
  ));
  if (p.cleanup.length || p.busy || (p.sizes?.chunk || 0) > 0) page.append(tidyBlock(p, () => render()));
  else if (p.cleanupPending) page.append(h('div', { class: 'sub', style: { marginTop: '10px' } }, 'Preparing cleanup list… (refresh in a moment)'));
  // notes + render info + history
  const notes = p.notes || [];
  page.append(h('div', { class: 'split' },
    h('div', {},
      h('h2', {}, `Notes (${notes.length})`),
      notes.length ? h('div', { class: 'panel nodecut-glass-card', style: { padding: '4px 6px' } }, h('table', { class: 't' }, notes.slice().reverse().map(n => h('tr', { style: { cursor: 'pointer' }, onclick: () => location.hash = `#/review/${id}/${encodeURIComponent(n.file || p.latest)}?n=${n.id}` },
        h('td', { class: 'mono' }, '#' + n.id), h('td', { class: 'mono' }, TC(n.t)), h('td', {}, pill(n.status, NOTE_STATUS_LABEL[n.status] || n.status)), h('td', { class: 'muted' }, NOTE_KIND_LABEL[n.kind] || n.kind), h('td', {}, n.text), h('td', { class: 'num dim' }, AGO(n.createdAt))))))
        : h('div', { class: 'empty' }, 'No notes yet. Open the video with "Review" to leave a note on a frame.'),
      h('h2', {}, 'Render history'),
      p.history.length ? h('div', { class: 'panel nodecut-glass-card', style: { padding: '4px 6px' } }, h('table', { class: 't' }, p.history.slice(0, 25).map(x => h('tr', {}, h('td', { class: 'num muted' }, x.at.replace('T', ' ').slice(0, 16)), h('td', {}, x.event), h('td', {}, x.session), h('td', { class: 'muted' }, x.detail)))))
        : h('div', { class: 'empty' }, 'No render history for this project.'),
    ),
    h('div', {}, h('h2', {}, 'Render info'), h('div', { class: 'panel kv' },
      h('div', { class: 'k' }, 'Folder'), h('div', { class: 'mono', style: { wordBreak: 'break-all' } }, p.path),
      h('div', { class: 'k' }, 'Type'), h('div', {}, FAMILY[p.family] || p.family),
      h('div', { class: 'k' }, 'Script'), h('div', {}, p.render?.script || '—'),
      h('div', { class: 'k' }, 'FPS / chunk'), h('div', {}, p.render?.fps ? `${p.render.fps} fps` : '—', p.render?.chunkSec ? ` · ${p.render.chunkSec} s chunks` : ''),
      h('div', { class: 'k' }, 'Partial render'), h('div', {}, p.render?.supportsOnly ? h('span', { class: 'green' }, 'supported (ONLY=)') : h('span', { class: 'muted' }, 'unavailable')),
      h('div', { class: 'k' }, 'File count'), h('div', {}, p.counts?.files ?? '—', p.counts?.chunks ? ` · ${p.counts.chunks} chunks` : ''),
    )),
  ));
}

// "Tidy up this project": what the films take vs what can go; the safe items and the deep ones the rules
// pre-select (chunks of a film marked finished by the user, old QA) are ticked
function tidyBlock(p, after) {
  const cands = p.cleanup, film = p.outputs.filter(o => o.role === 'final' || o.role === 'web').reduce((t, o) => t + (o.size || 0), 0);
  const left = cands.filter(c => c.preset).reduce((t, c) => t + c.size, 0);
  const inReview = !['approved', 'published', 'archived', 'done'].includes(p.status);
  return h('div', {},
    h('h2', {}, 'Tidy up this project'),
    h('div', { class: 'sub', style: { marginBottom: '8px' } }, `Videos ${GB(film)} · leftovers ${GB(left)}`,
      inReview && p.render?.chunkSec ? h('span', { class: 'dim' }, ' · film in review: render\\chunks are kept for partial renders (mark it "approved" to include them in cleanup)') : null),
    !p.busy && (p.sizes?.chunk || 0) > 0 && (inReview || p.statusAuto) ? h('div', { class: 'panel release-chunks' },
      h('b', {}, GB(p.sizes.chunk) + ' of render chunks kept for revision.'),
      h('p', { class: 'sub' }, 'Once review is finished, you can release the chunks for cleanup. Code, audio and final videos stay; later changes will need a full render.'),
      h('button', { disabled: p.notesOpen > 0, title: p.notesOpen > 0 ? 'Resolve the open revision notes first.' : '', onclick: async () => {
        if (await confirmBox('Is the review finished?', h('p', {}, `The project will be marked approved. You can then select the render chunks and send them to the ${trashName()}; this step does not delete files.`), 'Finish review')) {
          await api('/api/project/' + p.id + '/meta', { method: 'POST', body: { status: 'approved' } }); render();
        }
      } }, 'Review finished · release chunks for cleanup')) : null,
    p.busy ? h('div', { class: 'sub' }, `⏳ Render leftovers for this project are not listed right now: ${p.busy}.`) : null,
    cleanupBlock(cands, after, c => c.preset === 'safe' || (c.preset === 'deep' && c.checked), false));
}
function cleanupBlock(cands, after, pre = c => c.checked, title = true) {
  const checked = new Set(cands.filter(pre).map(c => c.id));
  const sum = () => cands.filter(c => checked.has(c.id)).reduce((s, c) => s + c.size, 0);
  const btn = h('button', { class: 'primary', 'data-clean': '1' });
  const upd = () => { btn.textContent = `Clean selected (${GB(sum())})`; btn.dataset.empty = checked.size ? '0' : '1'; lockCleanButtons(); };
  btn.onclick = () => runClean(cands.filter(c => checked.has(c.id)), after);
  upd();
  return h('div', {}, title ? h('h2', {}, `Available to clean · ${GB(cands.reduce((s, c) => s + c.size, 0))}`) : null, h('div', { class: 'rule' }, h('div', { class: 'items', style: { borderTop: 0 } },
    cands.map(c => h('label', { class: 'item' }, h('input', { type: 'checkbox', checked: checked.has(c.id), onchange: e => { e.target.checked ? checked.add(c.id) : checked.delete(c.id); upd(); } }),
      h('div', {}, h('div', { class: 'ellip', title: c.path }, c.path.split(/[\\/]/).slice(-3).join('/')), h('div', { class: 'why' }, (c.action === 'archive' ? 'Moves to archive · ' : `${trashName()} · `) + c.reason)),
      h('div', { class: 'num' }, GB(c.size)))))), h('div', { class: 'row', style: { marginTop: '8px' } }, btn));
}

// Cleaning runs on the hub in the background, one run at a time. A panel shows its progress (SSE 'clean') and,
// at the end, what went where and what could not go and why. Clean buttons are locked while a run is going.
let cleanState = null, cleanBox = null, cleanAfter = null;
const cleanRunning = () => cleanState && cleanState.state === 'running';
const lockCleanButtons = () => document.querySelectorAll('button[data-clean]').forEach(b => { b.disabled = cleanRunning() || b.dataset.empty === '1'; b.title = cleanRunning() ? 'Cleanup in progress' : ''; });
const STATUS_TR = { ok: 'done', error: 'failed', skipped: 'skipped', gone: 'already gone' };
// Element.append prints null as text: skip empty parts
const putClean = (...kids) => cleanBox.append(...kids.filter(k => k != null && k !== false));
function drawCleanBox() {
  const st = cleanState; if (!st || st.state === 'none') { cleanBox?.remove(); cleanBox = null; return; }
  if (!cleanBox) { cleanBox = h('div', { class: 'cleanbox' }); document.body.append(cleanBox); }
  cleanBox.innerHTML = '';
  if (st.state === 'running') {
    const pct = st.total ? Math.round(100 * st.done / st.total) : 0;
    putClean(h('b', {}, st.phase === 'list' ? 'Preparing cleanup…' : `Cleaning · ${st.done}/${st.total}`),
      h('div', { class: 'bar' }, h('i', { style: { width: pct + '%' } })),
      h('div', { class: 'muted' }, `${GB(st.freed)} freed`, st.current ? h('div', { class: 'ellip dim', title: st.current }, st.current.split(/[\\/]/).slice(-3).join('/')) : null),
      h('div', { class: 'dim', style: { fontSize: '12px' } }, 'You can keep using NodeCut; cleanup continues even if you close the page.'));
  } else {
    const rs = st.results || [], bad = rs.filter(r => r.status === 'error'), other = rs.filter(r => r.status === 'skipped' || r.status === 'gone');
    putClean(h('b', {}, `Cleanup finished · ${GB(st.freed)} freed`),
      h('div', { class: 'muted' }, `${st.ok} done${bad.length ? ` · ${bad.length} failed` : ''}${other.length ? ` · ${other.length} skipped / already gone` : ''}`),
      bad.length || other.length ? h('div', { class: 'cleanres' }, [...bad, ...other].map(r => h('div', { class: 'item' + (r.status === 'error' ? ' red' : '') },
        h('div', {}, h('b', {}, STATUS_TR[r.status] + ' '), r.path ? h('span', { class: 'ellip', title: r.path }, (r.project ? r.project + ' · ' : '') + r.path.split(/[\\/]/).slice(-3).join('/')) : null),
        h('div', { class: 'why' }, r.error || '')))) : null,
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { onclick: () => { cleanBox.remove(); cleanBox = null; } }, 'Close')));
  }
}
function onCleanState(st) {
  if (st && cleanState && st.id === cleanState.id && cleanState.state === 'done' && st.state !== 'done') return;
  const was = cleanRunning(); cleanState = st; drawCleanBox(); lockCleanButtons();
  if (was && st?.state === 'done') { const f = cleanAfter; cleanAfter = null; if (f && location.hash === f.hash && !busyWriting()) f.fn(); }
}
onHubEvent('clean', onCleanState);
api('/api/disk/clean').then(st => { if (st?.state === 'running') onCleanState(st); }).catch(() => { });

export async function runClean(items, after) {
  if (cleanRunning()) { toast('Cleanup is already running; try again when it finishes.', true); return; }
  if (!items.length) return;
  const rec = items.filter(c => c.action === 'recycle'), arc = items.filter(c => c.action === 'archive');
  const ok = await confirmBox('Cleanup', h('div', { class: 'sub', style: { fontSize: '14px' } },
    rec.length ? h('p', {}, `${rec.length} items (${GB(rec.reduce((s, c) => s + c.size, 0))}) will go to the ${trashName()}. You can restore them from there.`) : null,
    arc.length ? h('p', {}, `${arc.length} old versions (${GB(arc.reduce((s, c) => s + c.size, 0))}) will move to the archive folder and be removed here after the copy is verified.`) : null,
    h('p', { class: 'dim' }, 'Runs in the background; progress appears at the bottom right.')), 'Clean');
  if (!ok) return;
  try {
    cleanAfter = after ? { fn: after, hash: location.hash } : null;
    onCleanState(await api('/api/disk/clean', { method: 'POST', body: { ids: items.map(c => c.id) } }));
  } catch (e) { cleanAfter = null; toast('Cleanup did not start: ' + e.message, true); }
}

// ---------- Renders
async function rendersPage(page) {
  page.append(h('h1', {}, "Renders"), h('div', { class: 'sub' }, 'Running jobs, elapsed time and speed settings. Finished videos are below.'));
  const live = h('div', { class: 'current-renders' }), hist = h('div', {}), settings = h('div', { class: 'current-render-settings' });
  let timedRows = new Map();
  const tickTimers = () => {
    const now = Date.now();
    for (const cell of live.querySelectorAll('[data-render-timer]')) {
      const row = timedRows.get(cell.dataset.rowKey); if (!row) continue;
      cell.textContent = cell.dataset.renderTimer === 'elapsed' ? timeText(elapsedSeconds(row, now)) : remainingText(row, now);
    }
  };
  const clock = setInterval(tickTimers, 1000);
  const outs = outputsPanel();
  page.append(h('h2', {}, 'Current renders'), live, h('h2', {}, 'Render speed and protection'), settings);
  page.append(h('div', { class: 'row recent-heading' }, h('h2', {}, 'Recent renders'), h('span', { class: 'spacer' }), h('a', { href: '#/outputs' }, 'Open list →')), outs.el, h('h2', {}, 'History'), hist);
  api('/api/guard/settings').then(gs => settings.append(guardPanel(gs))).catch(() => settings.append(h('div', { class: 'empty' }, 'Could not load render settings.')));
  const draw = d => {
    if (!d) return;
    const g = d.guard || {}, active = activeRenders(d);
    timedRows = new Map(active.map(r => [r.key, r]));
    live.innerHTML = '';
    live.append(h('div', { class: 'tiles' },
      tile('Render protection', g.running ? h('span', { class: 'green' }, 'on') : h('span', { class: 'muted', title: g.reason }, 'off')),
      tile('Free RAM', g.running ? `${(g.ramAvailMB / 1024).toFixed(1)} GB` : '—'),
      tile('CPU limit', g.capabilities?.cpuAffinity === false ? h('span', { title: g.capabilities.cpuLimitReason }, 'unavailable') : g.running ? (g.capNow >= 100 ? 'unlimited' : g.capNow + '%') : '—'),
      tile('Running', active.filter(r => r.state === 'running').length),
    ));
    // slow every render down at once (and back): frees the computer for a moment without stopping anything
    if (g.running && (g.renders || []).length) live.append(h('div', { class: 'row', style: { gap: '8px', margin: '4px 0 8px' } },
      h('button', { title: 'Run every render at the lowest speed, so the computer is free for you', onclick: () => cmd('slow') }, '🐢 Slow all down'),
      h('button', { title: 'Back to normal render speed', onclick: () => cmd('normal') }, '▶ Normal speed for all')));
    // programs that hold RAM next to the renders (only shown; closing them is the user's call)
    const hogs = (d.hogs || []).filter(x => x.bytes >= 1024 ** 3);
    if (hogs.length) live.append(h('div', { class: 'panel hogs' },
      h('b', {}, 'Programs using RAM: '), hogs.map((x, i) => [i ? ', ' : '', h('span', { class: x.bytes >= 3 * 1024 ** 3 ? 'red' : 'accent' }, `${x.name} ${GB(x.bytes)}`)]),
      h('div', { class: 'dim' }, 'Closing these while rendering can speed up the render and keep your computer responsive. On a 16 GB computer, an Android emulator alone can use 8 GB.')));
    const rows = active.map(row => {
      const r = row.native, j = row.job;
      const label = j?.projectName || r?.project || r?.cwd || 'Render';
      const session = j?.session?.title || r?.session?.title || '';
      const started = row.startedAt ? new Date(row.startedAt) : null;
      const startText = started && Number.isFinite(started.getTime()) ? 'Started ' + started.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      const timerCell = (kind, title) => h('td', { class: 'num render-time', 'data-render-timer': kind, 'data-row-key': row.key, title },
        kind === 'elapsed' ? timeText(elapsedSeconds(row)) : remainingText(row));
      return h('tr', { 'data-active-render': row.key },
        h('td', {}, h('b', {}, label), h('div', { class: 'dim' }, session), h('div', { class: 'dim render-start' }, row.state === 'queued' ? 'Waiting in queue' : startText)),
        h('td', { class: 'muted' }, r?.what || (j?.mode + (j?.chunks?.length ? ' · ' + j.chunks.length + ' chunks' : '')),
          j?.phase ? h('div', { class: 'dim' }, ({ prepare: 'Preparing', render: 'Drawing frames', validate: 'Checking chunks', concat: 'Joining video', audio: 'Adding audio', register: 'Saving output' })[j.phase] || '') : null),
        h('td', {}, row.state === 'queued' ? (j.needsApproval ? h('div', {}, h('span', { class: 'accent' }, 'Needs your approval'), h('div', { class: 'dim', title: j.cmd, style: { fontFamily: 'var(--mono)', fontSize: '11.5px', maxWidth: '420px', overflowWrap: 'anywhere' } }, j.cmd)) : h('span', { class: 'muted' }, j.waiting || 'Queued (' + (j.position || '—') + ')')) :
          row.state === 'paused' ? h('span', { class: 'red' }, '⏸ Paused') :
          h('div', { class: 'row' }, r?.slow ? h('span', { class: 'accent' }, '🐢 Slow') : null,
            row.progress != null ? [h('div', { class: 'progress' }, h('i', { style: { width: Math.max(0, Math.min(100, row.progress * 100)) + '%' } })), Math.round(row.progress * 100) + '%'] : h('span', { class: 'dim' }, 'Waiting for progress'))),
        timerCell('elapsed', 'Time since the job actually started; excludes queue time and includes pauses.'),
        timerCell('remaining', 'Estimate based on the latest progress. Render speed, pauses and joining can change the remaining time.'),
        h('td', { class: 'num' }, r && r.cpu != null ? Math.round(r.cpu) + '%' : '—'),
        h('td', { class: 'num' }, r && r.ramMB != null ? GB(r.ramMB * 1048576) : '—'),
        h('td', { class: 'num render-controls' },
          r ? [
            h('button', { onclick: () => cmd(r.slow ? 'normal' : 'slow', r.rootPid) }, r.slow ? 'Normal speed' : 'Slow down'),
            h('button', { class: 'danger', onclick: async () => { if (await confirmBox('Stop this render?', h('p', {}, label), 'Stop')) { if (j) await api('/api/jobs/' + j.id + '/cancel', { method: 'POST' }).catch(e => toast(e.message, true)); else await cmd('kill', r.rootPid); } } }, 'Stop')
          ] : j ? [
            j.needsApproval ? h('button', { class: 'primary', title: `${agentName()} asked to run this command in the project folder. Run it only if you know what it does.`, onclick: async () => { if (await confirmBox('Run this command?', h('div', {}, h('p', {}, `${agentName()} asked NodeCut to run this command in the folder of "` + label + '":'), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, j.cmd), h('p', { class: 'dim' }, 'A command can do anything on this computer. Approve it only if it is what you expected.')), 'Run it')) await api('/api/jobs/' + j.id + '/approve', { method: 'POST' }).catch(e => toast(e.message, true)); } }, 'Approve') : null,
            h('button', { class: 'danger', onclick: () => api('/api/jobs/' + j.id + '/cancel', { method: 'POST' }).catch(e => toast(e.message, true)) }, 'Cancel')] : null));
    });
    live.append(rows.length ? h('div', { class: 'panel active-render-table' }, h('table', { class: 't' },
      h('tr', {}, h('th', {}, 'Project / session'), h('th', {}, 'Running task'), h('th', {}, 'Progress'), h('th', { class: 'num' }, 'Elapsed'), h('th', { class: 'num' }, 'Estimated remaining'), h('th', { class: 'num' }, 'CPU'), h('th', { class: 'num' }, 'RAM'), h('th', {})), rows))
      : h('div', { class: 'empty' }, 'No renders are running.'));
    const sn = (d.snipp || []).filter(s => s.state === 'running' || Date.now() - s.updated < 864e5);
    if (sn.length) live.append(h('h2', {}, 'Snipp exports'), h('div', { class: 'panel nodecut-glass-card', style: { padding: '4px 6px' } }, h('table', { class: 't' }, sn.map(s => h('tr', {}, h('td', {}, s.name), h('td', {}, pill(s.state === 'done' ? 'approved' : s.state === 'running' ? 'revision' : 'done', s.state)), h('td', {}, s.progress != null ? `${Math.round(s.progress * 100)}%` : ''), h('td', { class: 'num dim' }, AGO(s.updated)))))));
  };
  const cmd = async (action, rootPid) => { const r = await api('/api/renders/cmd', { method: 'POST', body: { action, rootPid } }); if (r.note) toast(r.note, true); };
  const d = await api('/api/renders').catch(e => { clearInterval(clock); outs.dispose(); throw e; }); draw(d);
  const jobsDone = (d.jobs || []).filter(j => !['queued', 'running'].includes(j.state)).slice(0, 15);
  const hrows = [...jobsDone.map(j => ({ at: j.finishedAt || j.createdAt, event: j.state === 'done' ? 'FINISHED' : j.state.toUpperCase(), session: j.session?.title || '', project: j.projectName, detail: `NodeCut ${j.mode}${j.chunks?.length ? ' · ' + j.chunks.length + ' chunks' : ''}${j.durationSec ? ' · ' + DUR(j.durationSec) : ''}` })), ...(d.history || [])].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  hist.append(hrows.length ? h('div', { class: 'panel nodecut-glass-card', style: { padding: '4px 6px' } }, h('table', { class: 't' },
    h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Event'), h('th', {}, 'Session'), h('th', {}, 'Project'), h('th', {}, 'Details')),
    hrows.slice(0, 200).map(x => h('tr', {}, h('td', { class: 'num muted' }, String(x.at).replace('T', ' ').slice(0, 16)), h('td', {}, x.event), h('td', {}, x.session), h('td', { class: 'muted' }, x.project), h('td', { class: 'muted' }, x.detail))))) : h('div', { class: 'empty' }, 'No history yet.'));
  const sub = x => draw(x); renderSubs.add(sub);
  return () => { clearInterval(clock); renderSubs.delete(sub); outs.dispose(); };
}

// ---------- dedicated recent-render history
async function outputsPage(page) {
  const panel = outputsPanel();
  page.append(h('div', { class: 'row' }, h('h1', {}, 'Recent renders'), h('span', { class: 'spacer' }), h('a', { href: '#/renders' }, 'Running renders →')),
    h('p', { class: 'sub' }, 'Your finished videos, newest first. Open a video, find it in its folder or review it in NodeCut.'), panel.el);
  return panel.dispose;
}

// ---------- render settings (RenderGuard): presets, a temporary full-power window, and the sliders
const PRESETS = [
  ['Full power', 'every core, normal priority', { CapActive: 100, LowPrio: false }],
  ['Balanced', '90% of the cores, low priority (default)', { CapActive: 90, LowPrio: true }],
  ['Quiet', 'half of the cores; keeps your computer responsive', { CapActive: 50, LowPrio: true }],
];
function guardPanel(gs, { full = false } = {}) {
  const box = h('div', { class: 'panel gpanel' });
  const redraw = async () => { const fresh = await api('/api/guard/settings').catch(() => null); if (fresh) box.replaceWith(guardPanel(fresh, { full })); };
  let timer = null; const pending = {};
  const save = (k, v) => { pending[k] = v; clearTimeout(timer); timer = setTimeout(async () => { const body = { ...pending }; for (const x in pending) delete pending[x]; try { await api('/api/guard/settings', { method: 'POST', body }); } catch (e) { toast('Could not save: ' + e.message, true); } }, 400); };
  const slider = (key, label, min, max, step, fmt, help) => {
    const out = h('b', { style: { minWidth: '150px', display: 'inline-block' } }, fmt(gs[key]));
    const inp = h('input', { type: 'range', 'data-guard-setting': key, min, max, step, value: gs[key], style: { width: '280px' }, oninput: e => { out.textContent = fmt(+e.target.value); save(key, +e.target.value); } });
    return h('div', { class: 'row', style: { margin: '6px 0' } }, h('span', { style: { width: '260px' } }, label), inp, out, help ? h('span', { class: 'muted', style: { fontSize: '12px' } }, help) : null);
  };
  const toggle = (key, label, help) => h('label', { class: 'row', style: { margin: '6px 0', cursor: 'pointer' } },
    h('input', { type: 'checkbox', 'data-guard-setting': key, checked: !!gs[key], onchange: e => save(key, e.target.checked) }), h('span', {}, label), help ? h('span', { class: 'dim', style: { fontSize: '12px' } }, help) : null);
  const affinity = gs.capabilities?.cpuAffinity !== false;
  const limitReason = gs.capabilities?.cpuLimitReason || 'CPU limit not available on this system. Renders still use priority and RAM protection.';
  const cores = gs.cores || navigator.hardwareConcurrency || 12;
  const pct = v => v >= 100 ? '100% · unlimited' : `${v}% · ≈${(v * cores / 100).toFixed(1)} cores`;
  const same = p => Object.entries(p).every(([k, v]) => (typeof v === 'boolean' ? !!gs[k] === v : +gs[k] === v));
  const presets = h('div', { class: 'row', style: { gap: '8px', margin: '2px 0 10px' } }, h('span', { class: 'muted', style: { width: '120px' } }, 'Speed'),
    PRESETS.map(([name, help, p]) => h('button', { class: same(p) ? 'primary' : '', title: help, onclick: async () => { await api('/api/guard/settings', { method: 'POST', body: p }); toast(`Render speed: ${name}`); redraw(); } }, name)));
  // full power for a while, then the current settings come back by themselves (also after a restart)
  const temp = gs.temp && Date.parse(gs.temp.until) > Date.now() ? gs.temp : null;
  const hhmm = iso => new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const tempRow = h('div', { class: 'row', style: { gap: '8px', margin: '0 0 10px' } }, h('span', { class: 'muted', style: { width: '120px' } }, 'Temporary'),
    temp ? [h('span', { class: 'accent' }, `Full power until ${hhmm(temp.until)}, then previous settings`), h('button', { onclick: async () => { await api('/api/guard/temp', { method: 'POST', body: { cancel: true } }); toast('Previous settings restored'); redraw(); } }, 'End now')]
      : [h('span', { class: 'muted' }, 'Full power, then automatically restore previous settings:'), [1, 2, 4, 8].map(hr => h('button', { onclick: async () => { const r = await api('/api/guard/temp', { method: 'POST', body: { hours: hr } }); toast(`Full power until ${hhmm(r.until)}`); redraw(); } }, `${hr} h`))]);
  box.append(
    h('div', { class: 'sub', style: { marginBottom: '8px' } }, affinity ? 'Render protection is part of NodeCut: renders started from NodeCut get a CPU limit and low priority, and slow down when free RAM runs low.' : 'Render protection is part of NodeCut: renders started from NodeCut use low priority and slow down when available RAM runs low.'),
    ...(affinity ? [presets, tempRow, slider('CapActive', 'Render power', 10, 100, 5, pct)] : [h('p', { class: 'muted' }, limitReason)]),
    toggle('LowPrio', 'Run renders at low priority', 'keeps open apps responsive; rendering slows slightly'));
  const more = h('div', {},
    slider('PauseMB', 'Slow down when free RAM reaches', 300, Math.max(4000, Math.round((gs.ramTotalMB || 16384) / 4 / 100) * 100), 100, v => `${(v / 1024).toFixed(1)} GB free`, 'the newest render slows down; the oldest continues'),
    ...(affinity ? [slider('SlowCapPct', 'Speed in slow mode', 1, 30, 1, v => `${v}% CPU`, 'rendering continues at a lower speed')] : []),
    slider('CriticalMB', 'Critical RAM', 200, 2000, 100, v => `${(v / 1024).toFixed(1)} GB`, 'below this, the oldest render also slows down'),
    toggle('Startup', 'Start NodeCut at login and keep it running', 'opens no window and starts render protection immediately; when disabled, starts when you open NodeCut and exits 2 min after closing the window if no renders are running'));
  if (full) box.append(more);
  else { more.hidden = true; const link = h('button', { class: 'ghost', onclick: () => { more.hidden = !more.hidden; link.textContent = more.hidden ? 'RAM and other settings ▾' : 'Show less ▴'; } }, 'RAM and other settings ▾'); box.append(link, more); }
  return box;
}

// ---------- Disk
async function diskPage(page) {
  page.append(h('h1', {}, 'Disk'), h('div', { class: 'sub' }, `See what can be safely removed and why. Deleted files go to the ${trashName()}; old versions go to the archive.`));
  const wait = h('div', { class: 'empty' }, 'Measuring folders… (large projects may take 10–30 s)'); page.append(wait);
  const d = await api('/api/disk'); wait.remove();
  const T = d.totals || {}, parts = [['output', 'Videos', 'var(--green)'], ['chunk', 'Render chunks', 'var(--accent)'], ['oldChunk', 'Old chunks', 'var(--red)'], ['part', 'Part/segment', 'var(--yellow)'], ['profile', 'Chrome profiles', 'var(--red)'], ['snap', 'Check frames', 'var(--blue)'], ['audio', 'Audio', 'var(--violet)'], ['other', 'Code and other files', 'var(--dim)']];
  page.append(h('div', { class: 'panel', style: { marginTop: '14px' } }, h('div', { class: 'row' }, h('b', {}, `Watched folders: ${GB(T.total)}`), h('span', { class: 'spacer' }), h('span', { class: 'muted' }, `Archive: ${d.archiveDir}${d.archiveOk ? '' : ' (drive unavailable!)'}`)),
    h('div', { class: 'stack', style: { marginTop: '10px' } }, parts.map(([k, , c]) => T[k] ? h('i', { style: { width: (100 * T[k] / T.total) + '%', background: c }, title: GB(T[k]) }) : null)),
    h('div', { class: 'legend' }, parts.filter(([k]) => T[k]).map(([k, t, c]) => h('span', {}, h('b', { style: { background: c } }), `${t} ${GB(T[k])}`)))));
  const safeBytes = d.candidates.filter(c => c.preset === 'safe').reduce((n,c) => n+c.size,0);
  const heldChunks = (d.projects || []).filter(p => p.chunksKept).reduce((n,p) => n+(p.chunks || 0),0);
  page.append(h('div', { class: 'tiles storage-tiles' },
    tile('Safe to clean', GB(safeBytes)),
    tile('Chunks kept for revision', GB(heldChunks)),
    tile('Videos', GB(T.output))),
    h('div', { class: 'panel storage-help' },
      h('b', {}, 'Two options after rendering'),
      h('p', { class: 'sub' }, 'If revisions are ongoing, clean silent copies, old chunks and temporary files; keep the current chunks. When the film is finished, complete the review on its project page, then clean the chunks too.'),
      h('span', { class: 'dim' }, 'Final videos, source code and audio are kept. Review the file list before confirming each action.')));
  // presets: "Safe" (never needed again), "Deep" (+ recent QA, old versions to the archive, chunks of finished films), "Custom"
  const inPreset = (c, k) => k === 'safe' ? c.preset === 'safe' : (c.preset === 'safe' || c.preset === 'deep');
  const presetSum = k => d.candidates.filter(c => inPreset(c, k)).reduce((s, c) => s + c.size, 0);
  const checked = new Set(d.candidates.filter(c => inPreset(c, 'safe')).map(c => c.id));
  const setPreset = k => { checked.clear(); for (const c of d.candidates) if (inPreset(c, k)) checked.add(c.id); document.querySelectorAll('.items input[data-id]').forEach(i => { i.checked = checked.has(i.dataset.id); }); presetBtns.forEach(b => b.classList.toggle('primary', b.dataset.k === k)); upd(); };
  const presetBtns = [['safe', 'Safe (recommended)', 'No longer needed: replaced chunks (chunks_v*, chunks_prev*), Chrome profiles, ' + 3 + ' days or older check frames and test clips, silent copies and old previews. Chunks needed for partial renders of films in review are kept.'],
    ['deep', 'Deep', 'Safe cleanup plus recent check frames, old versions (moved to the archive) and render chunks of finished/approved films (partial rendering will no longer be available).']]
    .map(([k, t, help]) => h('button', { 'data-k': k, title: help, class: k === 'safe' ? 'primary' : '', onclick: () => setPreset(k) }, `${t} · ${GB(presetSum(k))}`));
  const allBtn = h('button', { class: 'primary', 'data-clean': '1', onclick: () => runClean(d.candidates.filter(c => checked.has(c.id)), () => render()) });
  const rows = (d.projects || []).filter(r => r.deep >= (50 << 20) || r.chunks >= (50 << 20));
  page.append(h('h2', {}, 'Render leftovers · all projects'),
    h('div', { class: 'panel' },
      h('div', { class: 'sub', style: { marginBottom: '8px' } }, `Cleanup sends files to the ${trashName()} (old versions to the archive). You can also change individual selections in the list below.`),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Preset:'), presetBtns, h('span', { class: 'spacer' }), allBtn),
      d.busy?.length ? h('div', { class: 'sub', style: { marginTop: '8px' } }, '⏳ Projects currently excluded: ', d.busy.map(b => `${b.name} (${b.reason})`).join(' · '), '. They will appear in the list when rendering finishes.') : null,
      rows.length ? h('table', { class: 't', style: { marginTop: '10px' } },
        h('tr', {}, h('th', {}, 'Project'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Films'), h('th', { class: 'num' }, 'Leftovers · safe'), h('th', { class: 'num' }, 'Leftovers · deep'), h('th', { class: 'num' }, 'Total'), h('th', {})),
        rows.map(r => h('tr', {}, h('td', {}, r.name), h('td', {}, pill(r.status, PROJECT_STATUS_LABEL[r.status] || r.status)), h('td', { class: 'num' }, GB(r.film)), h('td', { class: 'num' }, GB(r.safe)), h('td', { class: 'num' }, GB(r.deep)), h('td', { class: 'num muted' }, GB(r.total)),
          h('td', { class: 'num' }, h('button', { class: 'ghost', title: '"Tidy up this project" on the project page', onclick: () => location.hash = '#/p/' + r.id }, 'Tidy up'))))) : null));
  const groups = {}; for (const c of d.candidates) (groups[c.rule] ||= []).push(c);
  const bar = h('div', { class: 'stickybar' }); const btn = h('button', { class: 'primary', 'data-clean': '1' }); const info = h('span', {});
  const upd = () => { const sel = d.candidates.filter(c => checked.has(c.id)), size = GB(sel.reduce((s, c) => s + c.size, 0)); info.textContent = `${sel.length} items selected · ${size}`; btn.textContent = 'Clean selected'; allBtn.textContent = `Clean render leftovers in all projects (${size})`; btn.dataset.empty = allBtn.dataset.empty = sel.length ? '0' : '1'; lockCleanButtons(); document.querySelectorAll('[data-rule]').forEach(el => { const g = groups[el.dataset.rule]; el.querySelector('.size').textContent = `${GB(g.filter(c => checked.has(c.id)).reduce((s, c) => s + c.size, 0))} / ${GB(g.reduce((s, c) => s + c.size, 0))}`; el.querySelector('input').checked = g.every(c => checked.has(c.id)); el.querySelector('input').indeterminate = !el.querySelector('input').checked && g.some(c => checked.has(c.id)); }); };
  btn.onclick = () => runClean(d.candidates.filter(c => checked.has(c.id)), () => render());
  page.append(h('h2', {}, 'Detailed list'));
  if (!d.candidates.length) page.append(h('div', { class: 'empty' }, 'Nothing to clean.'));
  for (const [rule, items] of Object.entries(groups).sort((a, b) => b[1].reduce((s, c) => s + c.size, 0) - a[1].reduce((s, c) => s + c.size, 0))) {
    const list = h('div', { class: 'items', hidden: true });
    for (const c of items.sort((a, b) => b.size - a.size)) list.append(h('label', { class: 'item' },
      h('input', { type: 'checkbox', checked: checked.has(c.id), 'data-id': c.id, onchange: e => { e.target.checked ? checked.add(c.id) : checked.delete(c.id); upd(); } }),
      h('div', {}, h('div', {}, h('b', {}, c.projectName), ' ', h('span', { class: 'ellip muted', title: c.path }, c.path.split(/[\\/]/).slice(-3).join('/'))), h('div', { class: 'why' }, c.reason)),
      h('div', { class: 'num' }, GB(c.size))));
    const head = h('header', { 'data-rule': rule },
      h('input', { type: 'checkbox', onclick: e => { e.stopPropagation(); const on = e.target.checked; for (const c of items) on ? checked.add(c.id) : checked.delete(c.id); list.querySelectorAll('input').forEach(i => i.checked = on); upd(); } }),
      h('b', {}, d.rules[rule] || rule), h('span', { class: 'muted' }, `${items.length} items`), items[0]?.action === 'archive' ? pill('published', 'to archive') : null,
      h('span', { class: 'size' }), h('span', { class: 'dim' }, '▾'));
    head.onclick = () => { list.hidden = !list.hidden; };
    page.append(h('div', { class: 'rule' }, head, list));
  }
  bar.append(info, h('span', { class: 'spacer' }), btn);
  $('#main').append(bar); upd();
  return () => bar.remove();
}

// ---------- Settings
// Generation spends money, so it is off until switched on here and every job shows its price before it is submitted.
// The keys are never read back from the hub: the fields say whether one is stored, and an empty field keeps the old one.
function generationPanel() {
  const host = h('div', { class: 'panel' });
  const draw = (g) => {
    host.innerHTML = '';
    const on = !!g.enabled;
    const keyRow = (label, name) => {
      const inp = h('input', { type: 'password', placeholder: g.keys?.[name] ? 'saved — type to replace' : 'not set', style: { width: '340px' }, autocomplete: 'off' });
      return h('div', { class: 'row', style: { margin: '6px 0' } }, h('span', { style: { width: '220px' } }, label), inp,
        h('span', { class: 'dim', style: { fontSize: '12px' } }, g.keys?.[name] ? '✓ stored on this computer' : 'needed before anything can be made'));
    };
    const kDeep = keyRow('DeepInfra key (stills)', 'DEEPINFRA_API_KEY');
    const kOpen = keyRow('OpenRouter key (clips)', 'OPENROUTER_API_KEY');
    const kEleven = keyRow('ElevenLabs key (voice, music, sound effects)', 'ELEVENLABS_API_KEY');
    const cap = h('input', { type: 'number', step: '0.5', min: '0', value: String(g.dailyCapUsd), style: { width: '100px' } });
    const res = h('select', {}, ['480p', '768p', '1080p', '2K'].map(v => h('option', { value: v, selected: g.resolution === v }, v)));
    const dur = h('input', { type: 'number', min: '1', max: '30', value: String(g.duration), style: { width: '80px' } });
    const on3 = h('input', { type: 'checkbox', checked: on });
    const save = async () => {
      const body = { enabled: on3.checked, dailyCapUsd: +cap.value || 0, resolution: res.value, duration: +dur.value || 5, keys: {} };
      for (const [inp, name] of [[kDeep.querySelector('input'), 'DEEPINFRA_API_KEY'], [kOpen.querySelector('input'), 'OPENROUTER_API_KEY'], [kEleven.querySelector('input'), 'ELEVENLABS_API_KEY']]) if (inp.value.trim()) body.keys[name] = inp.value.trim();
      try { const saved = await api('/api/gen/config', { method: 'POST', body }); draw(saved); toast(saved.enabled ? 'Generation is on' : 'Generation is off'); }
      catch (e) { toast('Could not save: ' + e.message, true); }
    };
    host.append(
      h('p', { class: 'sub' }, 'Let a model make new plates and clips for a film. It never changes what is already in the film: everything it makes is added to the film\'s gen/ folder and stays there until you remove it. Off by default, and nothing is sent anywhere until you press Generate on a film.'),
      h('div', { class: 'row', style: { margin: '8px 0' } }, h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, on3, h('b', {}, 'Use models to generate media')),
        h('span', { class: 'dim', style: { fontSize: '12px' } }, on ? 'on' : 'off')),
      kDeep, kOpen, kEleven,
      h('div', { class: 'row', style: { margin: '6px 0' } }, h('span', { style: { width: '220px' } }, 'Daily spend cap (USD)'), cap,
        h('span', { class: 'dim', style: { fontSize: '12px' } }, 'a job that would pass it is refused, not just warned about')),
      h('div', { class: 'row', style: { margin: '6px 0' } }, h('span', { style: { width: '220px' } }, 'Clip resolution and length'), res, dur,
        h('span', { class: 'dim', style: { fontSize: '12px' } }, 'price is per second: 480p is usually the cheapest tier')),
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'primary', onclick: save }, 'Save generation settings')),
    );
  };
  api('/api/gen/config').then(draw).catch(() => host.append(h('p', { class: 'sub' }, 'Generation settings are not available.')));
  return host;
}
async function settingsPage(page) {
  const [c, gs] = await Promise.all([api('/api/config'), api('/api/guard/settings').catch(() => null)]);
  setSystemCapabilities(c.capabilities);
  page.append(h('h1', {}, 'Settings'), h('div', { class: 'sub' }, 'Settings for this computer.'));
  // ---- render protection (RenderGuard runs in the background; the same panel is on the Renders page)
  if (gs) page.append(h('h2', {}, 'Render protection'), guardPanel(gs, { full: true }));
  // ---- projects removed from the list ("Remove from list"), with their folders untouched
  const hidden = await api('/api/hidden').catch(() => []);
  if (hidden.length) page.append(h('h2', {}, `Hidden projects (${hidden.length})`), h('div', { class: 'panel nodecut-glass-card', style: { padding: '4px 6px' } }, h('table', { class: 't' },
    hidden.map(x => h('tr', {}, h('td', {}, h('b', {}, x.name)), h('td', { class: 'muted mono', style: { fontSize: '12px', wordBreak: 'break-all' } }, x.path), h('td', { class: 'num dim' }, AGO(x.at)),
      h('td', { class: 'num' }, h('button', { onclick: async () => { await api('/api/hidden/restore', { method: 'POST', body: { key: x.key } }); toast(`"${x.name}" restored to the list`); render(); } }, 'Restore')))))));
  const agentIn = h('input', { value: c.agentName || 'Claude', maxlength: '40' });
  page.append(h('h2', {}, 'Agent name'), h('p', { class: 'sub' }, 'The name shown on review and thumbnail buttons.'), agentIn);
  const roots = c.roots.map(r => ({ ...r }));
  const list = h('div', {});
  const draw = () => {
    list.innerHTML = '';
    list.append(h('div', { class: 'panel nodecut-glass-card', style: { padding: '4px 6px' } }, h('table', { class: 't' },
      h('tr', {}, h('th', {}, 'Enabled'), h('th', {}, 'Folder'), h('th', {}, 'Type'), h('th', {})),
      roots.map((r, i) => h('tr', {},
        h('td', {}, h('input', { type: 'checkbox', checked: r.enabled !== false, onchange: e => { r.enabled = e.target.checked; } })),
        h('td', { class: 'mono' }, r.path, ' ', folderButton(() => r.path, (p) => { r.path = p; draw(); }, 'Choose a folder to watch', '📂')),
        h('td', {}, h('select', { onchange: e => { r.type = e.target.value; } }, [['container', 'contains project folders'], ['project', 'single project'], ['media', 'finished videos']].map(([v, t]) => h('option', { value: v, selected: r.type === v }, t)))),
        h('td', { class: 'num' }, h('button', { class: 'ghost danger', onclick: () => { roots.splice(i, 1); draw(); } }, 'Remove')))))));
  };
  draw();
  const addIn = h('input', { placeholder: 'Absolute path to a folder', style: { width: '420px' } });
  const addRoot = value => {
    const folder = value.trim(); if (!folder) return;
    if (roots.some(r => sameFolder(r.path, folder))) { toast('This folder is already in the list.'); return; }
    roots.push({ path: folder, type: 'container', enabled: true }); addIn.value = ''; draw(); toast('Added: click Save to keep your changes');
  };
  const arch = h('input', { value: c.archiveDir, style: { width: '420px' } });
  const par = h('select', {}, [1, 2].map(n => h('option', { value: n, selected: c.maxParallelRenders === n }, n === 1 ? 'One render at a time (recommended)' : `2 renders if ${Math.round(c.secondRenderMinFreeMB / 1024)} GB+ RAM is free`)));
  // the other folders NodeCut writes to or reads from (defaults under Documents\NodeCut)
  const dirField = (label, value, help) => { const inp = h('input', { value: value || '', placeholder: 'not set', style: { width: '420px' } }); return { inp, row: h('div', { class: 'row', style: { margin: '6px 0' } }, h('span', { style: { width: '220px' } }, label), inp, folderButton(() => inp.value.trim(), (p) => { inp.value = p; }, label), help ? h('span', { class: 'dim', style: { fontSize: '12px' } }, help) : null) }; };
  const dOut = dirField('Outputs folder', c.outputsDir, 'every render as a hard link, one folder per day');
  const dSnd = dirField('Sound library', c.soundLibDir, 'your music beds and effects for "Add sound"');
  const dStu = dirField('3D studio engine (optional)', c.studioDir, 'only for ready-made sound effects and studio scenes');
  const skipIn = h('input', { value: (c.skipFolders || []).join(', '), style: { width: '420px' } });
  const I = c.integrations || {};
  // the explanation is the part people actually read, so it takes full text colour; the label stays quiet.
  // A muted sentence over a lit glass panel measured 4.14:1, under AA, which is why these were hard to read.
  const okRow = (name, ok, text) => [h('div', { class: 'k' }, name), h('div', { class: 'v' }, ok ? h('span', { class: 'green' }, '✓ ') : h('span', { class: 'muted' }, '— '), text)];
  page.append(h('h2', {}, 'Optional parts on this computer'), h('div', { class: 'panel kv' },
    okRow('ffmpeg', I.ffmpeg, I.ffmpeg ? 'found (frame pictures, previews, renders)' : 'not found — see README installation instructions for your system'),
    okRow('Browser for renders', !!I.browser, I.browser || 'no Chrome, Chromium or Edge found — renders need a native browser (Snap/Flatpak browsers are not supported)'),
    okRow('Render protection', true, c.capabilities?.cpuAffinity === false ? (c.capabilities.cpuLimitReason || 'CPU limit not available on this system') + '; priority and RAM protection remain available' : 'built in (CPU limit, low priority, RAM slow mode)'),
    okRow('Ready-made sound effects', I.sfx?.ok, I.sfx?.ok ? 'available' : I.sfx?.why || 'not available')));
  page.append(h('h2', {}, 'Workspace'), h('div', { class: 'sub' }, 'The folder chosen in setup: the default home of every folder below (films, outputs, sounds, archive). Each folder can still be changed on its own here.'),
    h('div', { class: 'row', style: { marginTop: '6px' } }, h('span', { class: 'mono' }, c.workspace || '—')),
    h('h2', {}, 'Render speed'), h('div', { class: 'sub' }, 'The encoder for films whose render script reads NODECUT_ENCODER (every film made from the template). Automatic uses the graphics card when it can, with the same picture quality as the processor. Saved at once; the render dialog can still pick another one for a single render.'),
    h('div', { style: { marginTop: '6px' } }, renderSpeedControl(c)));
  page.append(h('h2', {}, 'Watched folders'), list,
    h('div', { class: 'row', style: { marginTop: '10px' } }, addIn, folderButton(() => addIn.value.trim(), addRoot, 'Choose a folder to watch', '📂 Choose folder…'), h('button', { onclick: () => addRoot(addIn.value) }, 'Add')),
    h('div', { class: 'sub', style: { marginTop: '8px' } }, 'Helper folders inside a watched folder that are never listed as projects (unless they have their own render script):'),
    h('div', { class: 'row', style: { marginTop: '4px' } }, skipIn),
    h('h2', {}, 'Archive folder'), h('div', { class: 'sub' }, 'Old versions are moved here instead of being deleted.'), h('div', { class: 'row', style: { marginTop: '6px' } }, arch, folderButton(() => arch.value.trim(), (p) => { arch.value = p; }, 'Choose archive folder')),
    h('h2', {}, 'Generation'), generationPanel(),
    h('h2', {}, 'Other folders'), h('div', { class: 'panel' }, dOut.row, dSnd.row, dStu.row),
    h('h2', {}, 'Render queue'), par,
    h('h2', {}, 'Tools'), h('div', { class: 'panel kv' }, Object.entries(c.tools).map(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'mono' }, v || h('span', { class: 'red' }, 'not found'))])),
    h('div', { class: 'row', style: { marginTop: '20px' } }, h('button', { class: 'primary', onclick: async () => {
      const v = (i) => i.inp.value.trim() || null;
      try {
        const saved = await api('/api/config', { method: 'POST', body: { agentName: agentIn.value, roots, archiveDir: arch.value.trim(), maxParallelRenders: +par.value,
          outputsDir: v(dOut), soundLibDir: v(dSnd), studioDir: v(dStu), skipFolders: skipIn.value.split(',').map(s => s.trim()).filter(Boolean),
        } });
        agentIn.value = setAgentName(saved.agentName); toast('Saved, rescanning…');
      } catch (err) { toast('Could not save: ' + err.message, true); }
    } }, 'Save')),
  );
}

// One picker serves Settings and the render dialog; desktops without a native picker use a text field.
export function folderButton(getStart, onPick, title = 'Choose folder', label = '📂 Choose…') {
  const b = h('button', { type: 'button', class: 'ghost', title: 'Choose folder on this computer', onclick: async (e) => {
    e.preventDefault(); e.stopPropagation();
    const old = b.textContent; b.disabled = true; b.textContent = '⏳ dialog open…';
    try {
      const r = await api('/api/pick-folder', { method: 'POST', body: { start: getStart() || null, title } });
      if (r?.unsupported) {
        const input = h('input', { type: 'text', value: getStart() || '', placeholder: 'Absolute folder path', style: { width: '100%' } });
        const ok = await confirmBox(title, h('div', {}, h('p', {}, 'No folder dialog is available on this desktop. Enter the folder path below.'), input), 'Use folder');
        if (ok && input.value.trim()) onPick(input.value.trim());
      } else if (typeof r?.path === 'string' && r.path) onPick(r.path);
    }
    catch (err) { toast('Could not open folder dialog: ' + err.message, true); }
    finally { b.disabled = false; b.textContent = old; }
  } }, label);
  return b;
}
