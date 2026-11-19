// agent.js — the Agent tab's brain: run `opencode run` in a film folder and stream its events back.
//
// NodeCut has no LLM of its own and is not getting one. What it has is an `opencode` binary on PATH, and OpenCode's
// non-interactive mode (`opencode run --format json`) speaks a clean line-delimited JSON event stream:
//
//   {"type":"step_start", ...}                       a turn begins
//   {"type":"text", part:{"text":"…"}}               a reply chunk
//   {"type":"tool", ...}                             a tool call
//   {"type":"error", error:{"message":"…","status":…}}  a structured failure
//
// This module spawns that, parses it, and keeps one run per film. It writes nothing to the project itself: the agent
// does, through its own tools, the same way it would in a terminal.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const RUN_TIMEOUT_MS = 10 * 60 * 1000;

// How the Agent tab answers: short, plain, no jargon. This is a film review page, not a terminal — the person reading it
// is deciding whether their video looks right, and a wall of technical text is noise. The preamble is re-sent every turn
// because a session's instructions drift over a long conversation.
export const STYLE = [
  'How to answer in this chat:',
  '- Keep it short. Two or three sentences, or a short list. No preamble, no summary of what you are about to do.',
  '- Write plainly, like you are explaining to a smart 17 year old who does not code. No jargon, no file paths unless the',
  '  person needs one, no error codes without saying in plain words what went wrong.',
  '- Say what you did, or what you found, and stop. Do not explain your process.',
  '- If something needs a decision, ask one short question instead of listing options.',
].join('\n');   // an agent turn on a film can take minutes; ten is the ceiling
export const MAX_LOG = 400;                      // transcript entries kept per run

const runs = new Map();        // projectId -> run
let modelsCache = null;        // { at, list } from `opencode models`

// which models exist, cached: `opencode models` takes ~1s and the list rarely changes
export function listModels({ force = false } = {}) {
  if (!force && modelsCache && Date.now() - modelsCache.at < 5 * 60 * 1000) return Promise.resolve(modelsCache.list);
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn('opencode', ['models'], { env: shellEnv() }); } catch { return resolve([]); }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => { });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const list = out.split('\n').map((l) => l.trim()).filter((l) => l && l.includes('/'));
      modelsCache = { at: Date.now(), list };
      resolve(list);
    });
    setTimeout(() => { try { child.kill(); } catch { } resolve(modelsCache?.list || []); }, 15000);
  });
}

// A GUI-launched hub (and any detached process) gets a thin environment: no ~/.opencode/bin, no version managers, so
// `opencode` is found but dies with no output. Ask a login shell for its PATH once and cache it, then give every run that
// PATH. Without this the agent silently produces nothing, which is the worst failure mode there is.
let envCache = null;
export function shellEnv() {
  if (envCache) return envCache;
  const base = { ...process.env };
  if (process.platform !== 'win32') {
    try {
      const shell = base.SHELL || '/bin/zsh';
      const out = execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const p = String(out).trim();
      if (p && p.length > 10) base.PATH = p;
    } catch { /* a shell that will not answer: keep the inherited PATH */ }
  }
  // the places opencode actually installs, in case the shell said nothing useful
  if (process.platform !== 'win32') {
    const extra = [os.homedir() + '/.opencode/bin', os.homedir() + '/.local/bin', '/opt/homebrew/bin', '/usr/local/bin'];
    const parts = String(base.PATH || '').split(':').filter(Boolean);
    for (const e of extra) if (!parts.includes(e)) parts.push(e);
    base.PATH = parts.join(':');
  }
  envCache = base;
  return envCache;
}

// the opencode binary: PATH first, then the usual install spots, so a GUI-launched hub still finds it
export function findOpencode() {
  const candidates = process.platform === 'win32'
    ? ['opencode.cmd', 'opencode.exe', 'opencode']
    : ['opencode', '/usr/local/bin/opencode', '/opt/homebrew/bin/opencode', `${os.homedir()}/.local/bin/opencode`];
  return candidates[0];   // spawn resolves the rest through PATH; the extras are here to document intent
}

// parseLine(text) -> an entry for the transcript, or null. Pure, so it can be tested against captured CLI output.
export function parseLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  let ev;
  try { ev = JSON.parse(trimmed); } catch { return { kind: 'raw', text: trimmed }; }
  const t = ev.type;
  if (t === 'text' && ev.part && typeof ev.part.text === 'string') return { kind: 'text', text: ev.part.text };
  if (t === 'step_start') return { kind: 'step', text: '' };
  if (t === 'step_finish') return { kind: 'done', text: '' };
  if (t === 'reasoning' && ev.part && typeof ev.part.text === 'string') return { kind: 'thinking', text: ev.part.text };
  if (t === 'tool') {
    const p = ev.part || {};
    const name = p.tool || p.name || 'tool';
    const input = p.state && p.state.input ? p.state.input : (p.input || {});
    const where = input.filePath || input.path || input.command || input.pattern || '';
    return { kind: 'tool', text: name + (where ? ' · ' + String(where).slice(0, 120) : '') };
  }
  if (t === 'error') {
    const e = ev.error || {};
    const msg = e.message || (e.data && e.data.message) || 'The agent stopped.';
    // the CLI's own words are the most useful thing on screen, so they are shown as-is, with the status if there is one
    return { kind: 'error', text: (e.status ? e.status + ' · ' : '') + msg };
  }
  return null;
}

// ---- the film's memory ----------------------------------------------------------------------------------------
// The Agent tab must know the film's history across days, restarts and other projects. `opencode run` keeps a session
// only if it is told which one, so each film gets ONE stable session id, stored in the project folder next to the film.
// Verified: two separate processes with the same --session id share the conversation.
// The conversation lives at the project ROOT with a visible name: this repo forbids dot-prefixed paths (GitHub's browser
// upload silently drops them), and a film's history is something a person should be able to open and read.
export const SESSION_FILE = 'AGENT.md';

export function sessionIdFor(projectId) {
  // the id is derived from the film id, so it survives even if the file is lost; the file stores the rest (model, log)
  return 'ses_vh' + String(projectId).replace(/[^a-z0-9]/gi, '').slice(0, 24);
}

function metaPath(folder) { return path.join(folder, SESSION_FILE); }

// The history is stored as markdown with the machine-readable block on top: readable by a person in the folder, parseable
// by the hub. A JSON blob in the same file (a fenced block) keeps both without a second file.
const FENCE = '```';

// readMeta(folder): { sessionId?, model?, startedAt?, entries? } — everything the tab needs after a reload
export function readMeta(folder) {
  try {
    const raw = fs.readFileSync(metaPath(folder), 'utf8');
    const m = raw.match(/<!-- vh-agent:([\s\S]*?)-->/);
    return m ? JSON.parse(m[1]) : {};
  } catch { return {}; }
}

export function writeMeta(folder, patch) {
  const cur = readMeta(folder);
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  try {
    const body = (next.entries || []).map(e => {
      const who = e.kind === 'you' ? '**You**' : e.kind === 'tool' ? '_- ' + e.text + '_' : e.kind === 'error' ? '**Error:** ' + e.text : e.text;
      return who;
    }).filter(x => x && x.trim()).join('\n\n');
    const md = [
      '# Agent conversation',
      '',
      'The history of what was asked of the agent for this film, and what it did. It is here so the conversation',
      'survives restarts, and so it travels with the film instead of living in a browser tab.',
      '',
      `Session: \`${next.sessionId || ''}\`  ·  model: \`${next.model || ''}\``,
      '',
      body || '_Nothing yet._',
      '',
      '<!-- vh-agent:' + JSON.stringify(next) + '-->',
      '',
    ].join('\n');
    fs.writeFileSync(metaPath(folder), md);
  } catch { /* a film folder that cannot be written is the user's problem to see elsewhere; the run still works */ }
  return next;
}

// state(projectId, folder?) -> what the UI needs: status, the live transcript, and the remembered one when idle
export function state(projectId, folder = null) {
  const r = runs.get(projectId);
  if (r) return { status: r.status, entries: r.entries, model: r.model, startedAt: r.startedAt, error: r.error || null, sessionId: r.sessionId };
  const meta = folder ? readMeta(folder) : {};
  const entries = Array.isArray(meta.entries) ? meta.entries : [];
  // A run that was cut off leaves a transcript with no ending and no clean-exit marker. Reporting that as "idle" would
  // say the work finished when it did not, which is the one thing the tab must never do; say it was interrupted instead.
  const cutOff = !!(meta.interrupted);
  return {
    status: cutOff ? 'stopped' : 'idle',
    entries: cutOff ? [...entries, { kind: 'error', text: meta.interrupted }] : entries,
    model: meta.model || null,
    startedAt: meta.startedAt || null,
    error: cutOff ? meta.interrupted : null,
    sessionId: meta.sessionId || sessionIdFor(projectId),
  };
}

// busy(): true while any agent is working. The hub's idle timer asks this before it closes itself — without it, a film
// being written would be killed mid-sentence by the same rule that closes an unused window.
export function busy() {
  for (const r of runs.values()) if (r.status === 'running') return true;
  return false;
}

// killAll(): end every run now. Called when the hub is about to exit. Without it a child process outlives its parent,
// is reparented to PID 1, and keeps working on a film nobody is watching — holding the session open, so the next run
// in that film collides with it and appears to hang.
export function killAll() {
  for (const [id, r] of runs) {
    try { r.child.kill('SIGKILL'); } catch { }
    r.status = 'stopped';
    try {
      writeMeta(r.folder, {
        sessionId: r.sessionId, model: r.model || null, startedAt: r.startedAt,
        entries: [...r.entries.slice(-MAX_LOG), { kind: 'meta', text: 'Stopped when NodeCut closed.' }],
      });
    } catch { }
    runs.delete(id);
  }
}

export function stop(projectId) {
  const r = runs.get(projectId);
  if (!r || r.status !== 'running') return { stopped: false };
  try { r.child.kill('SIGTERM'); } catch { }
  // a CLI that ignores SIGTERM (it can be mid-write) gets five seconds, then SIGKILL
  setTimeout(() => { try { r.child.kill('SIGKILL'); } catch { } }, 5000);
  r.status = 'stopped';
  push(r, { kind: 'meta', text: 'Stopped.' });
  // Stopping on purpose is not being cut off: clear the flag so the tab does not come back saying it was interrupted.
  try { writeMeta(r.folder, { sessionId: r.sessionId, model: r.model || null, startedAt: r.startedAt, entries: r.entries.slice(-MAX_LOG) }); } catch { }
  return { stopped: true };
}

// Saved as the run goes, not only when it ends. A hub that exits during a run (idle timer, a restart, a crash) used to
// take the whole conversation with it, so the tab came back empty and there was no way to tell why. Writing on every
// entry means the last thing the agent said is still there afterwards.
let lastSave = 0;
function saveSoon(r) {
  const now = Date.now();
  if (!r.folder || now - lastSave < 1000) return;
  lastSave = now;
  try { writeMeta(r.folder, { sessionId: r.sessionId, model: r.model || null, startedAt: r.startedAt, entries: r.entries.slice(-MAX_LOG) }); } catch { }
}
function push(r, entry) {
  if (!entry) return;
  r.entries.push(entry);
  if (r.entries.length > MAX_LOG) r.entries.splice(0, r.entries.length - MAX_LOG);
  saveSoon(r);
  r.onEvent && r.onEvent();
}

// start(projectId, folder, message, { model }) -> { started, error }. One run per film at a time: two agent turns in the
// same folder would both edit film.js and the last writer would win.
export function start(projectId, folder, message, { model = null, onEvent = null } = {}) {
  const existing = runs.get(projectId);
  if (existing && existing.status === 'running') return { started: false, error: 'The agent is already working on this film. Stop it first.' };
  const text = String(message || '').trim();
  if (!text) return { started: false, error: 'Write what you want the agent to do.' };

  // The session is what gives the agent the film's history. It is stable per film and stored in the project, so a run
  // days later, from a different chat, still knows what was asked and what was changed.
  const meta = readMeta(folder);
  const sessionId = meta.sessionId || sessionIdFor(projectId);

  const args = ['run', '--format', 'json', '--session', sessionId];
  if (model) args.push('-m', model);
  args.push(STYLE + '\n\n' + text);

  let child;
  try {
    // stdin MUST be 'ignore'. With an open (empty) stdin pipe `opencode run` waits for input and then exits 130 with no
    // output at all — no error, no message, a silent dead tab. Ignoring stdin makes it run the prompt and return.
    child = spawn('opencode', args, { cwd: folder, env: shellEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  } catch (e) {
    return { started: false, error: 'Could not start opencode: ' + e.message };
  }

  // the remembered transcript is shown first, so the tab reads as one continuous conversation across days
  const remembered = Array.isArray(meta.entries) ? meta.entries : [];
  const r = { status: 'running', entries: [...remembered, { kind: 'you', text }], model, startedAt: Date.now(), child, onEvent, error: null, sessionId, folder };
  // Claim the run on disk before it does anything, so a hub that dies mid-run leaves evidence instead of a clean slate.
  // The close handler below clears it. Everything else is a cut-off run.
  try { writeMeta(folder, { sessionId, model: model || meta.model || null, startedAt: r.startedAt, entries: r.entries, interrupted: 'This run was cut off before it finished — NodeCut closed while the agent was still working. Press Send to carry on; it remembers the conversation above.' }); } catch { }
  runs.set(projectId, r);

  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const entry = parseLine(line);
      if (entry) {
        if (entry.kind === 'text' && r.entries.length && r.entries[r.entries.length - 1].kind === 'text') {
          r.entries[r.entries.length - 1].text += entry.text;   // chunks of one reply are one paragraph
          saveSoon(r);
          r.onEvent && r.onEvent();
        } else if (entry.kind === 'step' || entry.kind === 'done') {
          // not shown: the transcript is the conversation, not the machine's turn markers
        } else if (entry.kind === 'error') {
          r.error = entry.text;
          push(r, entry);
        } else push(r, entry);
      }
    }
  });
  child.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s && !/^\s*$/.test(s)) push(r, { kind: 'raw', text: s.slice(0, 400) });
  });
  child.on('error', (e) => {
    r.status = 'failed';
    r.error = e.code === 'ENOENT' ? 'The `opencode` command was not found. Install it, or make sure it is on PATH.' : e.message;
    push(r, { kind: 'error', text: r.error });
  });
  child.on('close', (code) => {
    if (r.status === 'running') r.status = code === 0 && !r.error ? 'done' : (r.error ? 'failed' : 'done');
    // keep the conversation with the film, not with this browser tab. `interrupted` is cleared here and nowhere else, so
    // its absence is proof the run ended on its own terms.
    writeMeta(folder, { sessionId, model: model || meta.model || null, startedAt: r.startedAt, entries: r.entries.slice(-MAX_LOG) });
    if (code !== 0 && !r.error && r.status !== 'stopped') {
      r.error = 'opencode exited with code ' + code;
      push(r, { kind: 'error', text: r.error });
    }
  });

  r.timer = setTimeout(() => {
    if (r.status !== 'running') return;
    try { r.child.kill('SIGTERM'); } catch { }
    r.status = 'timeout';
    r.error = 'The agent ran for ' + Math.round(RUN_TIMEOUT_MS / 60000) + ' minutes and was stopped.';
    push(r, { kind: 'error', text: r.error });
  }, RUN_TIMEOUT_MS);

  return { started: true };
}

// forget(projectId): drop the transcript (a new film, or the user clearing it)
export function forget(projectId, folder = null) {
  const r = runs.get(projectId);
  if (r && r.timer) clearTimeout(r.timer);
  runs.delete(projectId);
  // clearing the transcript must also start a NEW session: keeping the old one would leave the agent remembering what
  // the user just asked it to forget.
  if (folder) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    writeMeta(folder, { sessionId: sessionIdFor(projectId) + '_' + stamp, entries: [], startedAt: null });
  }
}
