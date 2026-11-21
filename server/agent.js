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

// A run has no maximum length. A real film can take fifteen minutes, half an hour, or longer, and a fixed ceiling stops
// work that was going perfectly well — which is a worse failure than a hung process.
//
// What it does have is a stall limit: if the agent produces nothing at all for STALL_MS, it is not slow, it is stuck — a
// dead network, a credential that expired, a CLI waiting on a prompt that will never come. That is worth ending, and it
// is a different event from "took a long time", so it says so in different words.
// Override both with NODECUT_AGENT_STALL_MIN (minutes of silence) when a machine is genuinely slower than this.
export const STALL_MS = Math.max(1, +process.env.NODECUT_AGENT_STALL_MIN || 20) * 60 * 1000;
// Kept for anything that imports it; a run is no longer cut short by total duration.
export const RUN_TIMEOUT_MS = Infinity;

// When a conversation gets too long, OpenCode starts running out of room to think in: the model forgets the early part
// of the film and starts repeating itself, or the turn fails outright. Waiting for that to happen means it happens
// mid-sentence, which is a failure the person watching can do nothing about. So the conversation is shortened on purpose
// BEFORE it gets there: at this many tokens of conversation the film's session is compacted — OpenCode replaces the old
// turns with its own summary and carries on in the same session, with the same memory of the film, in the same folder.
//
// 100k is deliberately under the smallest context windows in common use, so this works whatever model is picked rather
// than only for the big ones. It runs between turns, while the tab is idle, and says nothing: it is housekeeping, and the
// person asked for nothing to watch. Override with NODECUT_AGENT_COMPACT_TOKENS.
export const COMPACT_AT_TOKENS = Math.max(10_000, +process.env.NODECUT_AGENT_COMPACT_TOKENS || 100_000);

// How the Agent tab answers: short, plain, no jargon. This is a film review page, not a terminal — the person reading it
// is deciding whether their video looks right, and a wall of technical text is noise. The preamble is re-sent every turn
// because a session's instructions drift over a long conversation.
export const STYLE = [
  'How to answer in this chat:',
  '- Keep it short. Two or three sentences, or a short list. No preamble, no summary of what you are about to do.',
  '- Write plainly, like you are explaining to a smart 17 year old who does not code. No jargon, no file paths unless the',
  '  person needs one, no error codes without saying in plain words what went wrong.',
  '- Say what you did, or what you found, and stop. Do not explain your process.',
  '',
  // A turn that ends in a question is a turn that did half a job: the person has to come back, read it, answer it, and
  // wait again. NodeCut runs these turns so they can be left alone, so the agent makes the calls itself and reports them.
  // The reported decisions are what a person reviews afterwards — a log, not a prompt.
  'Never end a turn with a question.',
  '- Where a choice comes up, make it. Pick the voice, the music, the shot, the length, the medium. Say what you chose in',
  '  one line so it can be judged after the fact, and carry on working.',
  '- Only a real blocker stops you: a missing key, a tool that has failed twice, a file that is not there. Report that as',
  '  an error at the end of your reply. Never turn a blocker into a question either — say what is broken and what you would',
  '  need, and stop.',
  '',
  // The work in this folder is the film, not a code change to NodeCut. A film is a project the person is making, so its
  // files must never be presented as, or swept into, a commit to this app. Said on every turn because a long session drifts.
  'Working rules for this folder:',
  '- This folder is a FILM PROJECT, not part of NodeCut\'s source code. Never run git commands here: no git add, commit,',
  '  stash, checkout or branch. The person decides what to keep; nothing in this folder is a code change to the app.',
  '- Do not edit files outside this folder. The studio\'s own code lives elsewhere and is not yours to change.',
  '- Read the brief and work forwards from it. If the brief is thin, decide what it probably means and build that.',
  '',
  // Audio used to be the one thing an agent could not make, so it synthesized a beep track in code and called it music, and
  // later asked the user to paste an API key into a .env file that the studio never reads. Both are named and closed here.
  'Sound:',
  '- For any music, voice-over or sound effect, use hub_generate_audio. It uses the ElevenLabs key the user already saved in',
  '  Settings > Generation. Never ask them for the key, and never tell them to put it in a .env file.',
  '- Never present a synthesized tone, chord bed or MIDI-style sequence as music for the film. If hub_generate_audio fails,',
  '  say what it said and stop; a cheap placeholder is worse than an honest gap.',
  '- Different voices and music for each film are usually NOT wanted by the person. Default to a warm, clear documentary',
  '  voice, and a bed that matches the film\'s mood, chosen by you. hub_voices lists what exists; read it and pick.',
  '',
  // The person should not have to ask for generated video. It is a medium the plan can choose on its own, and the moment
  // to choose it is planning, not after the film is written. Said here too because a film can be rebuilt on a turn that
  // never touches hub_plan, and the rule has to hold then as well.
  'Making a film look real:',
  '- When you plan a film, consider a generated clip for beats where the thing moving IS the point: heat, steam, liquid,',
  '  a hand, a place, weather. Use hub_plan and choose text_to_video (no still yet) or image_to_video (you have the still).',
  '  hub_plan prices the plan and tells the person the total. Do not ask permission separately and do not announce the',
  '  feature: plan it, and let the price line be the thing they see. Only if generation is switched off in Settings does it',
  '  fall back to drawn beats, and then say so in one line.',
  '- Most beats are still not clips. If a beat could be drawn, typed or charted, it must be: a clip on a beat that did not',
  '  need one is what makes a film look bought.',
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
      // A caller that has deliberately set a PATH keeps it: the whole point of asking the login shell is to find a binary
      // a GUI-launched app cannot see, and it must not overrule a PATH that was set on purpose (which is also how the
      // tests drive a stand-in for the CLI).
      if (p && p.length > 10 && !base.NODECUT_KEEP_PATH) base.PATH = p;
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

// resetShellEnv(): drop the cached environment. Only a test needs this — it exists so a test can drive a stand-in CLI
// without the first call freezing the real PATH for every later case in the same process.
export function resetShellEnv() { envCache = null; }

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
    const head = (e.status ? e.status + ' · ' : '');
    // A provider can refuse a model for reasons that have nothing to do with the film — most often a guardrail that blocks
    // free models which train on your data. The raw text is a policy page, not an explanation, so a plain sentence comes
    // first; the provider's own words stay on the line underneath, because they are the evidence when something else is
    // behind the same status.
    if (/guardrail|data policy|free model training|0 endpoints.*available/i.test(msg)) {
      return { kind: 'error', text: `${head}The model is blocked by the provider, so no work could start. Free models on OpenRouter are often blocked for training on your data — pick another model in Settings > Agent and press Send. Your film and video are fine.\n${msg}` };
    }
    if (/no credits|insufficient|billing|payment required|402/i.test(msg)) {
      return { kind: 'error', text: `${head}The provider says this account has no credit left. Top it up, or pick another model in Settings > Agent, then press Send. The film is fine.\n${msg}` };
    }
    // otherwise the CLI's words are the most useful thing on screen, shown as-is with the status if there is one
    return { kind: 'error', text: head + msg };
  }
  return null;
}

// ---- did the turn end in a question? ---------------------------------------------------------------------------
// The agent is told never to end a turn with a question, because a question is a dead end for someone who left it running.
// This is the check that notices when it happened anyway: it looks at the last thing the agent said and returns the
// question itself, or null.
//
// Deliberately narrow. A reply that merely contains a "?" mid-sentence ("is it worth a re-shoot? I did both") is not a
// question to answer, and flagging those would train the person to ignore the note. Only a short sentence at the very end
// of the reply, ending in "?", counts.
export function lastTurnQuestion(entries) {
  if (!Array.isArray(entries)) return null;
  const last = [...entries].reverse().find(e => e && (e.kind === 'text'));
  if (!last || !last.text) return null;
  const body = String(last.text).trim();
  if (!body) return null;
  const tail = body.slice(-400);
  const para = tail.split(/\n\s*\n/).filter(p => p.trim()).pop() || tail;
  const sentence = para.split(/(?<=[.!?])\s+/).filter(s => s.trim()).pop() || para;
  const s = sentence.trim().replace(/\s+/g, ' ');
  // "Looks good?" and "Ready for me to start sourcing the pictures and building the edit?" are questions.
  // "It is 71 seconds — is that long enough? The rest is done." is not: the question is not what the reply ends on.
  if (!/\?$/.test(s)) return null;
  if (s.length > 240) return null;                   // a long tail is a summary, not a direct question
  return s.replace(/\?$/, '') + '?';
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

// estimate({status, startedAt, steps, runTimes, now}) -> what the tab says about finishing.
//
// An agent cannot know how long a job will take: it does not know what it will find. So this never invents a precise
// number. It reports three things it can actually stand behind — how long it has been running, how many steps it has
// taken, and a completion estimate that only appears once there is evidence for one.
//
//   no past runs   the estimate is deliberately coarse ("a few minutes"): a made-up figure would be trusted and then be
//                  wrong, which is worse than saying nothing specific
//   past runs      the median of this film's own finished runs, which is measured, not guessed
//   running long   once elapsed passes the estimate, the wording changes to say it is taking longer than expected
//
// `confident` says whether a measured figure backs the estimate. `late` says the run has passed that figure — a separate
// thing, and the only one that should colour the line, so an honest first run does not look like a warning.
//
// Steps refine the estimate while a run is going: if it is at step 4 of a typical 10, roughly 40% is done.
export function estimate({ status = 'idle', startedAt = null, steps = 0, runTimes = [], now = Date.now(), typicalSteps = 10 } = {}) {
  const elapsedMs = startedAt && status === 'running' ? Math.max(0, now - startedAt) : 0;
  const times = (runTimes || []).filter(t => Number.isFinite(t) && t > 5000);
  // the median, not the mean: one run that hit an unexpected fix-up should not drag every later estimate with it
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const base = median ?? null;

  const out = { elapsedMs, steps, hasHistory: !!median, typicalMs: base, late: false };
  if (status !== 'running') return { ...out, remainingMs: null, text: '' };

  if (!base) {
    // no evidence: say what is true and useful, and do not dress it up as a calculation
    out.text = elapsedMs < 45000 ? 'starting · a few minutes' : 'working · a few minutes';
    out.remainingMs = null;
    out.confident = false;
    return out;
  }

  // progress by steps when there are any, and never let a step count promise more than the clock allows
  const bySteps = steps > 0 ? Math.min(0.9, steps / Math.max(typicalSteps, steps)) : 0;
  const remainingMs = Math.max(0, Math.round(base * (1 - bySteps) - elapsedMs));
  const late = elapsedMs > base * 1.25;
  out.remainingMs = remainingMs;
  out.late = late;
  out.confident = true;
  out.text = late
    ? `taking longer than usual · ${fmtDur(elapsedMs)} so far`
    : remainingMs > 20000 ? `about ${fmtDur(remainingMs)} left`
      : 'nearly done';
  return out;
}

// fmtDur(ms) -> "2 min", "45 s", "1 min 30 s". Short, because it sits in a status line.
export function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60), rem = s % 60;
  return rem && m < 10 ? `${m} min ${rem} s` : `${m} min`;
}

// state(projectId, folder?) -> what the UI needs: status, the live transcript, and the remembered one when idle
export function state(projectId, folder = null) {
  const r = runs.get(projectId);
  if (r) return {
    status: r.status, entries: r.entries, model: r.model, startedAt: r.startedAt, error: r.error || null, sessionId: r.sessionId,
    steps: r.steps || 0, eta: estimate({ status: r.status, startedAt: r.startedAt, steps: r.steps || 0, runTimes: (() => { try { return readMeta(folder).runTimes || []; } catch { return []; } })() }),
  };
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
    // housekeeping, not conversation: the tab shows nothing for it, but the film's record should be able to say it happened
    compactions: meta.compactions || 0,
  };
}

// ---- keeping the conversation short -----------------------------------------------------------------------------
// Compaction is turned over to the server OpenCode is already running. Two facts make this the right place, and both were
// checked against the live API rather than assumed:
//
//   GET  /api/session/:id/context   the conversation so far, one entry per message, each carrying its `tokens`
//   POST /api/session/:id/compact   shorten it (returns an inbox entry; works on a 200 with no body)
//
// Using that endpoint rather than a second `opencode run` matters in one specific way: a run would be a turn, and a turn
// calls the model with the whole tool set — slow, billable, and able to fail in every way a normal turn can. Compaction is
// housekeeping, so it uses the housekeeping route and touches nothing else.
//
// It also can't be done from `opencode run`'s own output: the CLI's stream carries no token counts. Guessing from
// character counts would be wrong in both directions — far too eager on a film with many tool calls, too late on one with
// a huge script or pasted image in it.

// opencodeServer(): { origin, auth } for the server the CLI talks to, or null.
//
// The CLI does not hold a URL. It reads a running service's address and password from OpenCode's own state file
// (~/.local/state/opencode/service.json on macOS/Linux), which is why a GUI-launched hub with nothing in its environment
// cannot reach the server by simply spawning a command. Reading that file is how this finds the same server the CLI uses.
// `auth` is Basic user:password, which is what the HTTP API expects. NODECUT_OPENCODE_SERVER / _AUTH override the file for
// anyone running their own server, and OPENCODE_STATE_DIR points at a different state directory.
export function opencodeServer(env = process.env) {
  const url = env.NODECUT_OPENCODE_SERVER || env.OPENCODE_SERVER_URL || '';
  const auth = env.NODECUT_OPENCODE_AUTH || env.OPENCODE_SERVER_AUTH || '';
  if (url) return { origin: url.replace(/\/+$/, ''), auth };
  // An explicit state directory REPLACES the defaults rather than being tried first: a caller that says where to look must
  // not silently get the real user's server when its own directory has nothing in it. The others are tried in order.
  const dirs = env.OPENCODE_STATE_DIR
    ? [env.OPENCODE_STATE_DIR]
    : [
      path.join(os.homedir(), '.local', 'state', 'opencode'),
      // XDG state on Linux, which is where the CLI puts it there
      path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'opencode'),
      path.join(os.homedir(), '.config', 'opencode'),
      // Windows: no ~/.local, and the CLI keeps its state under APPDATA. Built only when that variable exists, so an empty
      // one cannot turn into a path of '/opencode'.
      ...(env.APPDATA ? [path.join(env.APPDATA, 'opencode')] : []),
    ];
  for (const dir of dirs) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'service.json'), 'utf8'));
      if (!j || !j.url) continue;
      const auth = j.password ? Buffer.from('opencode:' + j.password).toString('base64') : '';
      return { origin: String(j.url).replace(/\/+$/, ''), auth };
    } catch { /* no file here: try the next place */ }
  }
  return null;
}

// sessionTokens(context): how full the conversation is, in tokens — the size of the next call, not the sum of every turn.
//
// `context` is the array from /context, and it is NOT a list of conversation messages: it is what will be sent as context,
// so an old compaction and the summary that replaced everything before it collapse into a single entry. That collapsed
// entry is exactly the conversation as it now stands, and it carries the usage of the call that produced it — which is the
// best evidence of size available. Measured live: after a compaction that replaced ~18k tokens of chat, this entry read
// 20,885, slightly over the original, which is what a summary plus the tool preamble costs. So the honest reading is "how
// big the context is now", and the honest check after compacting is "is the context bigger than before", not "smaller".
//
// The last entry carrying usage wins. Every message would be counted once per turn if they were summed, which would
// report a conversation as full when it is a small fraction of that.
export function sessionTokens(context) {
  if (!Array.isArray(context) || !context.length) return 0;
  for (let i = context.length - 1; i >= 0; i--) {
    const t = context[i] && context[i].tokens;
    if (t && typeof t.input === 'number') {
      const total = (t.input || 0) + (t.output || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
      if (total > 0) return total;
    }
  }
  return 0;
}

// shouldCompact(tokens, { at }) -> whether this conversation is over the line. Pure, so the rule is stated once and tested.
export function shouldCompact(tokens, { at = COMPACT_AT_TOKENS } = {}) {
  return Number.isFinite(tokens) && tokens >= at;
}

// GET and POST against the OpenCode server, with a timeout and the same Basic auth the CLI uses. Small on purpose: this
// file needs exactly two routes and does not want a client.
async function ocFetch(server, method, route, { timeout = 20000, body = undefined } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const headers = {};
    if (server.auth) headers.Authorization = 'Basic ' + server.auth;
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(server.origin + route, { method, headers, body: payload, signal: ctl.signal });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { }
    return { ok: res.ok, status: res.status, json, body: text };
  } finally { clearTimeout(timer); }
}

const compactedAt = new Map();   // sessionId -> ms of the last compaction attempt, so one session is not retried in a loop

// ---- keeping a session usable -------------------------------------------------------------------------------------
// A conversation can be left with a broken message at its end, and when it is, every later turn in that film hangs: the
// CLI produces no output at all, starts no message, and sits there until something kills it. Nothing about the prompt
// causes it and nothing about the model does either — the same prompt in a fresh session runs in a second. It happens
// when a run is killed mid-reply (the hub closing, Stop, a SIGKILL that cannot be caught), which leaves a half-written
// assistant turn behind, and from then on the film's tab is dead in a way no error explains.
//
// Measured on a real film: 279 entries, the last one an assistant message that never completed and whose only content
// was an empty text part. Forking that exact conversation up to the message before it — same 278 entries, same 227k tokens,
// same model — ran first try. So the repair is: find the newest message that is intact, fork the session through it, and
// point the film at the fork. The history is kept; only the broken tail is dropped.
//
// `brokenSessionIds` is the check, `healSession` is the repair. start() runs the check first and only pays for the repair
// when something is actually wrong.

// isBroken(message) -> whether this entry is a reply that cannot be continued from. One definition, used by both the
// tail check and the fork boundary, so the two can never disagree about which message is the damaged one.
function isBroken(m) {
  if (!m) return true;
  if (m.type === 'assistant') {
    if (!m.time?.completed) return true;                                   // cut off before it finished writing
    // A reply that finished but carries nothing at all — no text AND no tool call — is the shape left when a turn died at
    // the moment it was written. A reply with only tool calls is normal and must not be mistaken for it.
    if (Array.isArray(m.content) && m.content.length
      && m.content.every(c => c.type === 'text' && !String(c.text || '').trim())) return true;
    return false;
  }
  if (m.type === 'compaction' && m.status === 'failed') return true;
  return false;
}

// brokenTailIds(context) -> the ids of trailing messages that cannot be continued from, newest last.
//
// The tail only: a broken message in the middle of a conversation is history, and OpenCode reads past it. It is the LAST
// message that has to be intact, because that is what the next turn is appended after.
export function brokenTailIds(context) {
  if (!Array.isArray(context) || !context.length) return [];
  const broken = [];
  for (let i = context.length - 1; i >= 0; i--) {
    const m = context[i];
    // idle/system/user bookkeeping entries are not replies and are never the problem
    if (!m || (m.type !== 'assistant' && m.type !== 'compaction')) break;
    if (!isBroken(m)) break;
    broken.push(m.id || '(unnamed)');
  }
  return broken.reverse();
}

// lastGoodId(context) -> the id of the newest message a fork can safely end on, or null.
//
// Safe means intact: a message that was cut off is not a place to fork from, so the search walks back past any damaged
// entries. A message with no id cannot be named as a fork boundary, so those are skipped too rather than guessed at.
export function lastGoodId(context) {
  if (!Array.isArray(context)) return null;
  for (let i = context.length - 1; i >= 0; i--) {
    const m = context[i];
    if (!m || !m.id) continue;
    if (m.type !== 'assistant' && m.type !== 'compaction') continue;
    if (isBroken(m)) continue;
    return m.id;
  }
  return null;
}

// sessionIsBroken(sessionId, { server }) -> { broken, ids? , reason? }. Never throws: unreachable is not broken.
export async function sessionIsBroken(sessionId, { server = null } = {}) {
  const srv = server || opencodeServer();
  if (!srv || !sessionId) return { broken: false, reason: 'no server' };
  let ctx;
  try { ctx = await ocFetch(srv, 'GET', '/api/session/' + encodeURIComponent(sessionId) + '/context'); }
  catch { return { broken: false, reason: 'unreachable' }; }
  if (!ctx.ok || !Array.isArray(ctx.json?.data)) return { broken: false, reason: 'unreachable' };
  const ids = brokenTailIds(ctx.json.data);
  return { broken: ids.length > 0, ids };
}

// healSession(sessionId, { server }) -> { healed, sessionId, reason? }
//
// Forks the conversation through its last intact message and returns the NEW session to use. The caller decides when to
// persist it, so a film is only rewritten when start() is about to run with it.
export async function healSession(sessionId, { server = null } = {}) {
  const srv = server || opencodeServer();
  if (!srv || !sessionId) return { healed: false, sessionId, reason: 'no server' };
  let ctx;
  try { ctx = await ocFetch(srv, 'GET', '/api/session/' + encodeURIComponent(sessionId) + '/context'); }
  catch { return { healed: false, sessionId, reason: 'unreachable' }; }
  if (!ctx.ok || !Array.isArray(ctx.json?.data)) return { healed: false, sessionId, reason: 'unreachable' };
  const ids = brokenTailIds(ctx.json.data);
  if (!ids.length) return { healed: false, sessionId, reason: 'not broken' };
  const boundary = lastGoodId(ctx.json.data);
  if (!boundary) return { healed: false, sessionId, reason: 'nothing to keep' };   // no history worth forking
  let fork;
  try {
    fork = await ocFetch(srv, 'POST', '/api/session/' + encodeURIComponent(sessionId) + '/fork', {
      timeout: 60000, body: { boundary: { type: 'through', messageID: boundary } },
    });
  } catch { return { healed: false, sessionId, reason: 'fork failed' }; }
  const next = fork.json?.data?.id;
  if (!fork.ok || !next) return { healed: false, sessionId, reason: 'fork failed' };
  return { healed: true, sessionId: next, boundary, dropped: ids.length };
}

// The same two questions, asked without a promise. start() is synchronous — it must return whether a child was spawned
// before any await could run — so the pre-flight check cannot be async. The work is the same two HTTP calls, made the
// same way, and it is done at most once per turn. Both never throw: trouble here means the session is used as it was.
function ocJson(srv, method, route, body) {
  const args = ['-s', '-m', '60', '-X', method, '-H', 'Authorization: Basic ' + (srv.auth || '')];
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  args.push(srv.origin + route);
  const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  try { return out ? JSON.parse(out) : null; } catch { return null; }
}

// sessionIsBrokenSync(sessionId, { server }) -> true when the last message is a reply that was cut off.
export function sessionIsBrokenSync(sessionId, { server = null } = {}) {
  const srv = server || opencodeServer();
  if (!srv || !sessionId) return false;
  try {
    const j = ocJson(srv, 'GET', '/api/session/' + encodeURIComponent(sessionId) + '/context');
    return Array.isArray(j?.data) ? brokenTailIds(j.data).length > 0 : false;
  } catch { return false; }
}

// healSessionSync(sessionId, { server }) -> { healed, sessionId, boundary? } and never throws.
export function healSessionSync(sessionId, { server = null } = {}) {
  const srv = server || opencodeServer();
  if (!srv || !sessionId) return { healed: false, sessionId };
  try {
    const j = ocJson(srv, 'GET', '/api/session/' + encodeURIComponent(sessionId) + '/context');
    const data = Array.isArray(j?.data) ? j.data : null;
    if (!data || !brokenTailIds(data).length) return { healed: false, sessionId };
    const boundary = lastGoodId(data);
    if (!boundary) return { healed: false, sessionId };
    const f = ocJson(srv, 'POST', '/api/session/' + encodeURIComponent(sessionId) + '/fork', { boundary: { type: 'through', messageID: boundary } });
    const next = f?.data?.id;
    return next ? { healed: true, sessionId: next, boundary } : { healed: false, sessionId };
  } catch { return { healed: false, sessionId }; }
}

// compactIfNeeded(sessionId, { server, at, onEvent, force }) -> { compacted, tokensBefore, tokensAfter?, reason? }
//
// Never throws. Everything here is housekeeping: a conversation that could not be checked is a conversation that carries
// on as it was, which is exactly what happened before this existed.
export async function compactIfNeeded(sessionId, { server = null, at = COMPACT_AT_TOKENS, onEvent = null, force = false } = {}) {
  const srv = server || opencodeServer();
  if (!srv || !sessionId) return { compacted: false, reason: 'no server' };
  let ctx;
  try { ctx = await ocFetch(srv, 'GET', '/api/session/' + encodeURIComponent(sessionId) + '/context'); }
  catch { return { compacted: false, reason: 'unreachable' }; }
  if (!ctx.ok || !Array.isArray(ctx.json?.data)) return { compacted: false, reason: 'unreachable' };
  const tokens = sessionTokens(ctx.json.data);
  if (!force && !shouldCompact(tokens, { at })) return { compacted: false, tokensBefore: tokens };
  // one attempt per session every two minutes: a compaction that failed must not be retried in a loop, since every try is
  // a model call. Short enough that the next quiet moment tries again if it genuinely went wrong.
  const last = compactedAt.get(sessionId) || 0;
  if (!force && Date.now() - last < 120000) return { compacted: false, tokensBefore: tokens, reason: 'recently tried' };
  compactedAt.set(sessionId, Date.now());
  // The route requires a JSON body even though there is nothing to say in it. `queue` is the gentler of the two delivery
  // modes: `steer` would cut into a turn that is already running, and this runs when nothing is.
  //
  // The status is read, not ignored. A 200 here means "accepted, will run" — the compaction itself happens afterwards, in
  // the session's own flow — and a 400 means the request was refused outright. Measured live: two POSTs in a row returned
  // 200 both times, and the second produced a compaction entry with status `failed`, because there was nothing left to
  // summarise. So a 200 is the only honest verdict available from this side, and it is reported as what it is.
  let accepted = false;
  try { const res = await ocFetch(srv, 'POST', '/api/session/' + encodeURIComponent(sessionId) + '/compact', { timeout: 120000, body: { delivery: 'queue' } }); accepted = res.ok; }
  catch { return { compacted: false, tokensBefore: tokens, reason: 'compact failed' }; }
  if (!accepted) return { compacted: false, tokensBefore: tokens, reason: 'compact refused' };
  // What the context is afterwards, for the record and so a later reader can see it was actually shortened. This is NOT
  // the thing that decides success: a compaction leaves the summary plus the tool preamble in place, so the number after
  // it is routinely within a few thousand of the number before it (measured: 17,882 → 20,885) even though the old turns
  // are gone. Reading that as failure would have meant never once reporting a compaction that worked.
  let after = null;
  try {
    const re = await ocFetch(srv, 'GET', '/api/session/' + encodeURIComponent(sessionId) + '/context');
    if (re.ok && Array.isArray(re.json?.data)) after = sessionTokens(re.json.data);
  } catch { }
  onEvent && onEvent();
  return { compacted: true, tokensBefore: tokens, tokensAfter: after };
}

const compacting = new Set();

// maybeCompact(projectId, folder): the version the hub calls. It only runs between turns, so it can never interrupt a
// sentence being written, and nobody is told about it — that is the requirement, not an oversight.
export function maybeCompact(projectId, folder, { onEvent = null } = {}) {
  const r = runs.get(projectId);
  if (r && r.status === 'running') return Promise.resolve(null);   // mid-turn: the conversation is in use
  if (compacting.has(projectId)) return Promise.resolve(null);      // already doing it
  const meta = folder ? readMeta(folder) : {};
  const sessionId = meta.sessionId || sessionIdFor(projectId);
  compacting.add(projectId);
  return compactIfNeeded(sessionId, { onEvent })
    .then(res => { if (res && res.compacted) markCompacted(folder); return res; })
    .catch(() => null)
    .finally(() => compacting.delete(projectId));
}

// A compaction is housekeeping inside the film, and the film's own record should be able to say it happened even though
// nothing appeared in the chat. Last done: one counter for the tab, one line for a person reading the folder.
function markCompacted(folder) {
  if (!folder) return;
  let count = 1, when = new Date().toISOString();
  try {
    const meta = readMeta(folder);
    count = (meta.compactions || 0) + 1;
    writeMeta(folder, { compactions: count, lastCompactedAt: when });
  } catch { }
  try {
    const file = path.join(folder, 'AGENT-COMPACT.md');
    const line = `- ${when} · conversation shortened so it stays within the model's limit\n`;
    if (fs.existsSync(file)) fs.appendFileSync(file, line);
    else fs.writeFileSync(file, [
      '# Conversation compactions',
      '',
      'The agent\'s chat is shortened automatically when it gets long, so the film stays inside the model\'s limit. Each',
      'line below is one of those moments. Nothing appears in the chat for it; it is housekeeping.',
      '',
      line,
    ].join('\n'));
  } catch { }
}
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
  clearTimeout(r.timer);   // stopping on purpose must not also trip the stall watchdog
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
  const before = meta.sessionId || sessionIdFor(projectId);

  // A conversation whose last message was cut off mid-reply hangs every later turn with no output and no error, so the
  // session is checked BEFORE the turn and, if it is damaged, repaired by forking through its last intact message. The
  // repair costs one round trip and only on a film that is actually damaged; an unreachable server changes nothing here.
  // This is synchronous by necessity: the turn must run on the repaired session, not the dead one.
  let sessionId = before;
  try {
    const bad = sessionIsBrokenSync(before);
    if (bad) {
      const fix = healSessionSync(before);
      if (fix && fix.healed) {
        sessionId = fix.sessionId;
        try { writeMeta(folder, { sessionId }); } catch { }
      }
    }
  } catch { /* any trouble here leaves the session as it was, which is what happened before this existed */ }

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
  const r = { status: 'running', entries: [...remembered, { kind: 'you', text }], model, startedAt: Date.now(), child, onEvent, error: null, sessionId, folder, steps: 0 };
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
          // not shown: the transcript is the conversation, not the machine's turn markers. Counted, though: steps are the
          // only honest measure of how far through a run the agent is, and the ETA is built from them.
          if (entry.kind === 'step') r.steps = (r.steps || 0) + 1;
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
    clearTimeout(r.timer);   // the stall watchdog must not fire on a run that has already finished
    // An exit code is a verdict, and it used to be thrown away: `code === 0 && !r.error ? 'done' : (r.error ? 'failed' :
    // 'done')` decided BOTH branches of the false case as 'done', so a crash that printed no error text was recorded as a
    // finished job. That is the one thing the tab must never say. Now a non-zero exit with no error of its own gets one
    // written for it, and it lands in the transcript like any other failure.
    if (r.status === 'running') {
      if (code === 0) r.status = r.error ? 'failed' : 'done';
      else {
        r.status = 'failed';
        if (!r.error) r.error = 'The agent stopped unexpectedly (exit code ' + code + '). Press Send to carry on from here.';
      }
    }
    // Keep what this run actually took, so the next estimate for this film is measured rather than guessed. Only runs
    // that ended on their own count: a stopped or cut-off run says nothing about how long the work really needs.
    const tookMs = r.startedAt ? Date.now() - r.startedAt : null;
    const past = Array.isArray(meta.runTimes) ? meta.runTimes.slice(-9) : [];
    const runTimes = tookMs && r.status !== 'stopped' ? [...past, tookMs] : past;
    // The failure is written into the transcript before the transcript is saved, so it is there after a reload as well as
    // on screen now. (It used to be written after the save, which is why an exit-code failure could vanish on refresh.)
    if (r.status === 'failed' && r.error && !r.entries.some(e => e.kind === 'error' && e.text === r.error)) {
      push(r, { kind: 'error', text: r.error });
    }
    // A turn that ends in a question is the one failure the exit code cannot see: it succeeds, it just stops halfway and
    // waits for someone. The instruction not to do that is in the prompt, but a prompt is a request, so the result is
    // checked here and a short note is added when it happens. It is a note, not a failure: the work the turn did is real,
    // and the person can answer it.
    if (r.status === 'done') {
      const asked = lastTurnQuestion(r.entries);
      if (asked) push(r, { kind: 'meta', text: 'The agent ended this turn with a question instead of deciding it: "' + asked + '" — answer it below, and it will carry on.' });
    }
    // keep the conversation with the film, not with this browser tab. `interrupted` is cleared here and nowhere else, so
    // its absence is proof the run ended on its own terms.
    writeMeta(folder, { sessionId, model: model || meta.model || null, startedAt: r.startedAt, entries: r.entries.slice(-MAX_LOG), runTimes });
    // Between turns is the one moment compaction is safe: nothing is mid-sentence, and the next turn is minutes away at
    // worst. It is not awaited and its result is not shown — if it works the film simply stays inside its limit, and if it
    // cannot it says nothing and the run happens as it did before. A failed turn is left alone: the person may be about
    // to retry, and a compaction is not a fix for a provider error.
    if (r.status === 'done') {
      try { maybeCompact(projectId, folder, { onEvent: r.onEvent }); } catch { }
    }
  });

  // A stall watchdog, not a deadline. Every sign of life resets it; only silence ends the run. The message names the
  // real cause so the next person does not read it as "your film is too long".
  const armStall = () => {
    clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      if (r.status !== 'running') return;
      try { r.child.kill('SIGTERM'); } catch { }
      r.status = 'timeout';
      r.error = `The agent stopped responding: nothing for ${Math.round(STALL_MS / 60000)} minutes. It was not cut short for taking too long — it went quiet, which usually means the network dropped or a sign-in expired. Press Send to carry on from here.`;
      push(r, { kind: 'error', text: r.error });
    }, STALL_MS);
  };
  armStall();
  // every chunk of stdout, every line of stderr and every tool step counts as life
  child.stdout.on('data', armStall);
  child.stderr.on('data', armStall);

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
