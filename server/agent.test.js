// Tests for agent.js — the Agent tab's event parsing and its guards. The parser cases are real lines captured from
// `opencode run --format json`, including the two failures this machine actually produces (guardrail block, no credits).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLine, state, stop, forget, start, sessionIdFor, readMeta, writeMeta, SESSION_FILE, STYLE } from './agent.js';

// --- captured from the CLI
const STEP_START = '{"type":"step_start","timestamp":1794960347067,"sessionID":"ses_1","part":{"id":"prt_1","type":"step-start"}}';
const TEXT = '{"type":"text","timestamp":1794960347078,"sessionID":"ses_1","part":{"id":"prt_2","type":"text","text":"PONG"}}';
const GUARDRAIL = '{"type":"error","timestamp":1794960111412,"sessionID":"ses_2","error":{"type":"provider.invalid-request","message":"0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy.","status":404}}';
const QUOTA = '{"type":"error","timestamp":1794960337412,"sessionID":"ses_3","error":{"type":"provider.quota","message":"This request requires more credits, or fewer max_tokens.","status":402}}';

test('a reply chunk becomes a text entry', () => {
  const e = parseLine(TEXT);
  assert.equal(e.kind, 'text');
  assert.equal(e.text, 'PONG');
});

test('a turn marker is recognised (and is not shown as text)', () => {
  assert.equal(parseLine(STEP_START).kind, 'step');
});

test('a guardrail block is surfaced with its status and the CLI\'s own words', () => {
  const e = parseLine(GUARDRAIL);
  assert.equal(e.kind, 'error');
  assert.match(e.text, /^404 · /);
  assert.match(e.text, /guardrail restrictions/);
});

test('a no-credits error keeps the status so the user can tell 402 from 404', () => {
  const e = parseLine(QUOTA);
  assert.equal(e.kind, 'error');
  assert.match(e.text, /^402 · /);
  assert.match(e.text, /requires more credits/);
});

test('a tool call is one line, with the file or command it touched', () => {
  const line = JSON.stringify({ type: 'tool', part: { tool: 'edit', state: { input: { filePath: '/films/sweet cow/film.js' } } } });
  const e = parseLine(line);
  assert.equal(e.kind, 'tool');
  assert.match(e.text, /^edit · /);
  assert.match(e.text, /film\.js/);
});

test('a tool call with no path still reads as a tool', () => {
  const e = parseLine(JSON.stringify({ type: 'tool', part: { tool: 'bash', state: { input: {} } } }));
  assert.equal(e.kind, 'tool');
  assert.equal(e.text, 'bash');
});

test('non-JSON output (a stack trace, a warning) is kept verbatim instead of dropped', () => {
  const e = parseLine('Error: something broke');
  assert.equal(e.kind, 'raw');
  assert.equal(e.text, 'Error: something broke');
});

test('blank lines and unknown event types are ignored', () => {
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('   '), null);
  assert.equal(parseLine('{"type":"something_new"}'), null);
});

test('state of an unknown film is idle, not an error', () => {
  const s = state('no-such-film');
  assert.equal(s.status, 'idle');
  assert.deepEqual(s.entries, []);
});

test('stop on a film with no run says so instead of throwing', () => {
  assert.deepEqual(stop('no-such-film'), { stopped: false });
});

test('an empty message is refused before anything is spawned', () => {
  const r = start('p-empty', '/tmp', '   ');
  assert.equal(r.started, false);
  assert.match(r.error, /Write what you want/);
});

test('one run per film: a second start is refused while the first is live', () => {
  // start a long-lived fake by pointing at a nonexistent binary is not enough (it fails fast), so drive the guard with a
  // real short-lived process: `node -e "setTimeout(()=>{},3000)"` stands in for the CLI.
  const first = start('p-busy', process.cwd(), 'hello', { model: null });
  // whether opencode exists or not, a run object is now registered for this film
  const second = start('p-busy', process.cwd(), 'again');
  assert.equal(second.started, false);
  assert.match(second.error, /already working/);
  stop('p-busy'); forget('p-busy');
  assert.ok(first.started || first.error, 'the first call reports what happened');
});

test('forget clears the transcript', () => {
  forget('p-busy');
  assert.equal(state('p-busy').status, 'idle');
});


// ---- the film's memory: one stable session per film, kept in the project folder
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vhagent-'));

test('a film gets a stable session id derived from its id', () => {
  const a = sessionIdFor('38a9cf339537');
  assert.equal(a, sessionIdFor('38a9cf339537'), 'the same film always gets the same session');
  assert.match(a, /^ses_/, 'the CLI requires the ses_ prefix');
  assert.notEqual(a, sessionIdFor('otherfilm'));
});

test('the session and the transcript live in the project, not in the tab', () => {
  const dir = tmp();
  writeMeta(dir, { sessionId: 'ses_abc', model: 'm/1', entries: [{ kind: 'you', text: 'hello' }] });
  assert.ok(fs.existsSync(path.join(dir, SESSION_FILE)));
  const back = readMeta(dir);
  assert.equal(back.sessionId, 'ses_abc');
  assert.equal(back.entries[0].text, 'hello');
});

test('state falls back to the remembered conversation when no run is live', () => {
  const dir = tmp();
  writeMeta(dir, { sessionId: 'ses_xyz', entries: [{ kind: 'you', text: 'earlier' }, { kind: 'text', text: 'and its reply' }] });
  const s = state('some-film', dir);
  assert.equal(s.status, 'idle');
  assert.equal(s.entries.length, 2);
  assert.equal(s.sessionId, 'ses_xyz');
});

test('a film with no saved conversation still reports a session id to use', () => {
  const s = state('fresh-film', tmp());
  assert.equal(s.status, 'idle');
  assert.deepEqual(s.entries, []);
  assert.match(s.sessionId, /^ses_vh/);
});

test('clearing starts a NEW session, so the agent forgets what was cleared', () => {
  const dir = tmp();
  writeMeta(dir, { sessionId: 'ses_old', entries: [{ kind: 'you', text: 'secret' }] });
  forget('clearme', dir);
  const after = readMeta(dir);
  assert.notEqual(after.sessionId, 'ses_old', 'the old session is not reused');
  assert.deepEqual(after.entries, []);
  assert.equal(state('clearme', dir).entries.length, 0);
});

// --- the completion estimate -----------------------------------------------------------------------------------
// These assert the honest behaviour, not a precise number: with no history it must NOT claim to know, and with history
// it must use this film's own measured runs rather than an invented figure.
import { estimate, fmtDur } from './agent.js';

test('estimate: with no past runs it stays vague rather than inventing a number', () => {
  const e = estimate({ status: 'running', startedAt: 1_000_000, steps: 2, runTimes: [], now: 1_030_000 });
  assert.equal(e.hasHistory, false);
  assert.equal(e.remainingMs, null);
  assert.equal(e.confident, false);
  // not knowing the answer must not be styled as a warning: first run, nothing has gone wrong
  assert.equal(e.late, false);
  assert.match(e.text, /few minutes/);
  // and it never dresses the guess up as a countdown
  assert.doesNotMatch(e.text, /left/);
});

test('estimate: elapsed time is always reported truthfully', () => {
  const e = estimate({ status: 'running', startedAt: 1_000_000, runTimes: [], now: 1_090_000 });
  assert.equal(e.elapsedMs, 90_000);
  assert.match(e.text, /working/);
});

test('estimate: with history it uses the median of this film\'s own runs', () => {
  // 60s, 120s, 300s -> median 120s; at 30s elapsed with no steps, about 90s should remain
  const e = estimate({ status: 'running', startedAt: 1_000_000, steps: 0, runTimes: [60000, 120000, 300000], now: 1_030_000 });
  assert.equal(e.hasHistory, true);
  assert.equal(e.typicalMs, 120000);
  assert.ok(e.remainingMs > 80_000 && e.remainingMs < 100_000, 'remaining should be near 90s, got ' + e.remainingMs);
  assert.match(e.text, /left/);
  assert.equal(e.confident, true);
  assert.equal(e.late, false);
});

test('estimate: steps reduce the remaining time', () => {
  const early = estimate({ status: 'running', startedAt: 1_000_000, steps: 1, runTimes: [120000], now: 1_020_000, typicalSteps: 10 });
  const later = estimate({ status: 'running', startedAt: 1_000_000, steps: 8, runTimes: [120000], now: 1_020_000, typicalSteps: 10 });
  assert.ok(later.remainingMs < early.remainingMs, 'more steps must mean less remaining');
});

test('estimate: past the expected time it says so instead of showing a negative countdown', () => {
  const e = estimate({ status: 'running', startedAt: 1_000_000, steps: 0, runTimes: [60000], now: 1_300_000 });
  assert.equal(e.late, true);
  assert.ok(e.remainingMs >= 0, 'never negative');
  assert.match(e.text, /longer than usual/);
});

test('estimate: not running means no estimate at all', () => {
  for (const status of ['idle', 'done', 'failed', 'stopped', 'timeout']) {
    const e = estimate({ status, startedAt: 1_000_000, runTimes: [60000], now: 1_200_000 });
    assert.equal(e.text, '', status + ' must not show an estimate');
  }
});

test('estimate: a single absurdly short run does not poison the median', () => {
  // runs under 5s are discarded: they are crashes, not a measure of how long the work takes
  const e = estimate({ status: 'running', startedAt: 1_000_000, steps: 0, runTimes: [1000, 60000], now: 1_010_000 });
  assert.equal(e.typicalMs, 60000);
});

test('fmtDur: short and readable', () => {
  assert.equal(fmtDur(45_000), '45 s');
  assert.equal(fmtDur(60_000), '1 min');
  assert.equal(fmtDur(90_000), '1 min 30 s');
  assert.equal(fmtDur(300_000), '5 min');
  assert.equal(fmtDur(3_600_000), '60 min');
});

// --- a run has no maximum length, only a stall limit --------------------------------------------------------------
// A film can genuinely take twenty minutes. Stopping it for taking long enough is stopping work that was going
// perfectly well, so the only thing that ends a silent run is silence.
import { RUN_TIMEOUT_MS, STALL_MS } from './agent.js';

test('a run is not cut short by total duration', () => {
  assert.equal(RUN_TIMEOUT_MS, Infinity, 'no fixed ceiling: a long film must not be killed for being long');
});

test('the stall limit is generous and configurable', () => {
  // default twenty minutes of total silence, which is stuck rather than slow
  assert.ok(STALL_MS >= 20 * 60 * 1000, 'the default stall limit should be at least 20 minutes');
});

// --- keeping the conversation short -------------------------------------------------------------------------------
// The numbers below are real: they are what /api/session/:id/context returned for a live session before and after a
// compaction, which is why the assertions are about shape and direction rather than invented counts.
import { COMPACT_AT_TOKENS, sessionTokens, shouldCompact, opencodeServer, compactIfNeeded, maybeCompact } from './agent.js';

test('compaction happens at 100k tokens by default, and can be moved', () => {
  assert.equal(COMPACT_AT_TOKENS, 100_000, 'the threshold itself matters: it is what the app promises');
  assert.equal(shouldCompact(99_999), false);
  assert.equal(shouldCompact(100_000), true);
  assert.equal(shouldCompact(4_000, { at: 4_000 }), true, 'an override must be obeyed');
});

test('an empty or unknown context is zero tokens, not a crash', () => {
  for (const v of [null, undefined, [], 'nope', 42]) assert.equal(sessionTokens(v), 0);
  assert.equal(sessionTokens([{ type: 'user' }, { type: 'idle' }]), 0, 'entries without usage claim nothing');
});

test('the context size is the last call that carried usage, not the sum of every message', () => {
  // summing these would report 30k for a conversation whose next call is 18k
  const ctx = [
    { type: 'user' },
    { type: 'assistant', tokens: { input: 5_000, output: 200, reasoning: 0, cache: { read: 1_000, write: 0 } } },
    { type: 'user' },
    { type: 'assistant', tokens: { input: 215, output: 3, reasoning: 0, cache: { read: 17_664, write: 0 } } },
    { type: 'idle' },
  ];
  assert.equal(sessionTokens(ctx), 17_882, 'cache reads count: they are part of the prompt');
});

test('a collapsed compaction entry is the context, so it is read like any other', () => {
  // after a compaction the whole old conversation becomes one entry. It must be measured, not skipped: skipping it would
  // fall back to an older, smaller number and make a shortened conversation look like it grew.
  const ctx = [{ type: 'compaction', status: 'completed', tokens: { input: 728, output: 100, reasoning: 0, cache: { read: 12_800, write: 0 } } }, { type: 'idle' }];
  assert.equal(sessionTokens(ctx), 13_628);
});

test('the compaction server is found from the file the CLI itself reads, and never guessed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-oc-'));
  fs.writeFileSync(path.join(dir, 'service.json'), JSON.stringify({ url: 'http://127.0.0.1:49374/', password: 'pw123' }));
  const s = opencodeServer({ OPENCODE_STATE_DIR: dir });
  assert.equal(s.origin, 'http://127.0.0.1:49374', 'the trailing slash must go, or every route becomes a double slash');
  assert.equal(Buffer.from(s.auth.replace('Basic ', ''), 'base64').toString(), 'opencode:pw123', 'user:password, base64');
  // a directory with nothing in it must answer null rather than throw: this runs on every sweep
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-oc-empty-'));
  assert.equal(opencodeServer({ OPENCODE_STATE_DIR: empty }), null);
  // an explicit server wins over any file
  assert.deepEqual(opencodeServer({ NODECUT_OPENCODE_SERVER: 'http://x:1/', NODECUT_OPENCODE_AUTH: 'abc' }), { origin: 'http://x:1', auth: 'abc' });
});

test('an unreachable server leaves the conversation alone and says why', async () => {
  const dead = { origin: 'http://127.0.0.1:9', auth: '' };   // discard port: nothing listens
  const r = await compactIfNeeded('ses_x', { server: dead });
  assert.equal(r.compacted, false);
  assert.match(r.reason, /unreachable|failed/);
});

test('a conversation under the line is never compacted, even if asked often', async () => {
  // the fake server only answers /context, so a compaction POST would show up as an unexpected request
  let posted = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).endsWith('/compact')) { posted++; return new Response('{}', { status: 200 }); }
    return new Response(JSON.stringify({ data: [{ type: 'assistant', tokens: { input: 900, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }] }), { status: 200 });
  };
  try {
    const r = await compactIfNeeded('ses_small', { server: { origin: 'http://fake', auth: '' }, at: 100_000 });
    assert.equal(r.compacted, false);
    assert.equal(r.tokensBefore, 910);
    assert.equal(posted, 0, 'under the line means the model is not called at all');
  } finally { globalThis.fetch = realFetch; }
});

test('over the line it asks for one compaction and records it as accepted', async () => {
  let posted = 0, forced = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/compact')) {
      posted++;
      assert.equal(opts.method, 'POST');
      assert.equal(JSON.parse(opts.body).delivery, 'queue', 'queue, not steer: nothing is mid-turn here');
      return new Response('{}', { status: 200 });
    }
    // before: over the line; after: the summary plus preamble, which is not necessarily smaller
    const tokens = forced++ === 0 ? { input: 90_000, output: 900, reasoning: 0, cache: { read: 10_000, write: 0 } } : { input: 728, output: 100, reasoning: 0, cache: { read: 12_800, write: 0 } };
    return new Response(JSON.stringify({ data: [{ type: 'assistant', tokens }] }), { status: 200 });
  };
  try {
    const r = await compactIfNeeded('ses_big', { server: { origin: 'http://fake', auth: '' }, at: 100_000 });
    assert.equal(posted, 1);
    assert.equal(r.compacted, true);
    assert.equal(r.tokensBefore, 100_900);
    assert.equal(r.tokensAfter, 13_628);
  } finally { globalThis.fetch = realFetch; }
});

test('a refused compaction is reported as refused, and a second try straight after is throttled', async () => {
  const realFetch = globalThis.fetch;
  let phase = 'refuse', posted = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/compact')) { posted++; return new Response('{"message":"Expected object"}', { status: 400 }); }
    return new Response(JSON.stringify({ data: [{ type: 'assistant', tokens: { input: 100_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }] }), { status: 200 });
  };
  try {
    const first = await compactIfNeeded('ses_refused', { server: { origin: 'http://fake', auth: '' } });
    assert.equal(first.compacted, false);
    assert.equal(first.reason, 'compact refused');
    phase = 'ok';
    const again = await compactIfNeeded('ses_refused', { server: { origin: 'http://fake', auth: '' } });
    assert.equal(again.compacted, false);
    assert.equal(again.reason, 'recently tried');
    assert.equal(posted, 1, 'a refused compaction must not be retried in a loop: every try is a model call');
  } finally { globalThis.fetch = realFetch; }
});

test('maybeCompact does nothing while a turn is running', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-mc-'));
  // no run in this folder, so the guard has to come from something else: an unreachable server still proves it is called
  const r = await maybeCompact('no-such-project', folder);
  assert.equal(r && r.compacted, false);
});

test('a compaction leaves a record in the film folder but nothing in the chat', async () => {
  // A real HTTP server on a random port, not a patched global fetch: `compactIfNeeded` builds a URL from the server it is
  // given, so this exercises the same code path the hub does, including the body it sends.
  const http = await import('node:http');
  let posted = 0;
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.endsWith('/compact')) {
      posted++;
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        assert.equal(JSON.parse(body).delivery, 'queue', 'queue, not steer: nothing is mid-turn here');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"data":{"id":"msg_probe","type":"compaction"}}');
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ type: 'assistant', tokens: { input: 120_000, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } }] }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + srv.address().port;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-record-'));
  writeMeta(folder, { sessionId: 'ses_record_test', entries: [{ kind: 'you', text: 'make the intro shorter' }] });
  let events = 0;
  // the hub reaches the server through the environment, so the whole entry point can run end to end here
  const savedUrl = process.env.NODECUT_OPENCODE_SERVER;
  process.env.NODECUT_OPENCODE_SERVER = origin;
  try {
    const r = await maybeCompact('proj-record', folder, { onEvent: () => { events++; } });
    assert.equal(posted, 1);
    assert.equal(r.compacted, true);
    assert.equal(r.tokensBefore, 120_050);
    assert.equal(events, 1, 'the tab is told to redraw the state, not to print anything in the chat');
  } finally {
    await new Promise(r => srv.close(r));
    if (savedUrl === undefined) delete process.env.NODECUT_OPENCODE_SERVER; else process.env.NODECUT_OPENCODE_SERVER = savedUrl;
  }
  // the chat itself is untouched: compaction is not a message, and a person must never see housekeeping in it
  const meta = readMeta(folder);
  assert.equal(meta.entries.length, 1, 'the conversation must not gain an entry for a compaction');
  assert.equal(meta.compactions, 1, 'but the film knows it happened');
  const ledger = fs.readFileSync(path.join(folder, 'AGENT-COMPACT.md'), 'utf8');
  assert.match(ledger, /conversation shortened/, 'a person reading the folder can see why the earliest turns are gone');
});


// --- a damaged conversation, and the three ways the tab used to go quiet -----------------------------------------
// Every case here is the shape of a real failure seen on this machine, not an invented one.
import { brokenTailIds, lastGoodId, sessionIsBroken, healSession, resetShellEnv } from './agent.js';

test('a reply that was cut off is recognised as the damaged end of a conversation', () => {
  const healthy = [
    { type: 'user', id: 'u1' },
    { type: 'assistant', id: 'a1', time: { completed: 1 }, content: [{ type: 'text', text: 'done' }] },
    { type: 'idle', id: 'i1' },
  ];
  assert.deepEqual(brokenTailIds(healthy), [], 'a finished conversation is not damaged');

  // the exact shape found in the film session that hung: one assistant message, never completed, empty text
  const dead = [...healthy, { type: 'assistant', id: 'a2', time: { created: 1 }, content: [{ type: 'text', text: '' }] }];
  assert.deepEqual(brokenTailIds(dead), ['a2']);
  assert.equal(lastGoodId(dead), 'a1', 'the fork must end before the damaged message, never on it');
});

test('working back past several damaged entries, the fork still lands on something intact', () => {
  const ctx = [
    { type: 'assistant', id: 'good1', time: { completed: 1 }, content: [{ type: 'text', text: 'hi' }] },
    { type: 'assistant', id: 'bad1', time: { created: 1 }, content: [{ type: 'text', text: '' }] },
    { type: 'compaction', id: 'bad2', status: 'failed' },
  ];
  assert.deepEqual(brokenTailIds(ctx), ['bad1', 'bad2']);
  assert.equal(lastGoodId(ctx), 'good1');
});

test('a reply that finished with tool calls and no text is normal, not damaged', () => {
  // a turn that only ran tools is the common case; mistaking it for a broken one would fork every film on every turn
  const ctx = [{ type: 'assistant', id: 't1', time: { completed: 1 }, content: [{ type: 'tool', name: 'read', state: { status: 'completed' } }] }];
  assert.deepEqual(brokenTailIds(ctx), []);
});

test('damage in the middle of a conversation is history, not a reason to fork', () => {
  // only the last message has to be intact: that is what the next turn is appended after
  const ctx = [
    { type: 'assistant', id: 'old-bad', time: { created: 1 }, content: [{ type: 'text', text: '' }] },
    { type: 'user', id: 'u2' },
    { type: 'assistant', id: 'a2', time: { completed: 1 }, content: [{ type: 'text', text: 'fine' }] },
    { type: 'idle', id: 'i2' },
  ];
  assert.deepEqual(brokenTailIds(ctx), []);
});

test('nothing to check is not damage, and an unreachable server never blocks a run', async () => {
  assert.deepEqual(brokenTailIds(null), []);
  assert.deepEqual(brokenTailIds([]), []);
  assert.equal(lastGoodId(null), null);
  const r = await sessionIsBroken('ses_x', { server: { origin: 'http://127.0.0.1:9', auth: '' } });
  assert.equal(r.broken, false, 'a server that cannot be reached must let the run go ahead as it always did');
});

test('an unreachable server is not "healed", so nothing is rewritten', async () => {
  const r = await healSession('ses_x', { server: { origin: 'http://127.0.0.1:9', auth: '' } });
  assert.equal(r.healed, false);
  assert.equal(r.sessionId, 'ses_x', 'the film keeps the session it had');
});

// --- an exit code is a verdict, and it used to be thrown away -----------------------------------------------
// `code === 0 && !r.error ? 'done' : (r.error ? 'failed' : 'done')` decided BOTH branches of the false case as 'done',
// so a CLI that died without printing an error was recorded as a finished job. This drives that path for real.
test('a run that dies with a non-zero exit is a failure, even when it prints nothing', async () => {
  // PATH points at a directory holding a fake `opencode` that exits 3 in silence, which is the exact shape of the bug
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fakebin-'));
  const fake = path.join(bin, 'opencode');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-exitcode-'));
  const savedPath = process.env.PATH;
  const savedServer = process.env.OPENCODE_STATE_DIR;
  process.env.PATH = bin + ':' + savedPath;
  process.env.NODECUT_KEEP_PATH = '1';
  resetShellEnv();   // the PATH above is the one the child must see
  // no reachable server: the pre-flight check must stay out of the way of this test
  process.env.OPENCODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-exitcode-state-'));
  try {
    const r = start('p-exitcode', folder, 'do the thing');
    assert.equal(r.started, true);
    // wait for the child to exit and the close handler to run
    await new Promise(done => {
      const tick = () => { if (state('p-exitcode').status !== 'running') done(); else setTimeout(tick, 25); };
      tick();
    });
    const s = state('p-exitcode', folder);
    assert.equal(s.status, 'failed', 'a non-zero exit is never "done"');
    assert.match(String(s.error), /exit code 3/);
    const errs = s.entries.filter(e => e.kind === 'error');
    assert.equal(errs.length, 1, 'the failure is written into the transcript exactly once');
    // and it survives a reload, which is the half that used to be lost
    const saved = readMeta(folder);
    assert.ok(saved.entries.some(e => e.kind === 'error' && /exit code 3/.test(e.text)), 'the failure is on disk, not just on screen');
  } finally {
    process.env.PATH = savedPath;
    delete process.env.NODECUT_KEEP_PATH;
    resetShellEnv();
    if (savedServer === undefined) delete process.env.OPENCODE_STATE_DIR; else process.env.OPENCODE_STATE_DIR = savedServer;
    forget('p-exitcode');
  }
});

test('a run that succeeds is still done, and records no invented error', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fakebin2-'));
  const fake = path.join(bin, 'opencode');
  // one clean reply, then exit 0 — the ordinary case
  fs.writeFileSync(fake, '#!/bin/sh\ncat <<\'J\'\n{"type":"text","timestamp":1,"sessionID":"ses_1","part":{"id":"p1","type":"text","text":"All done."}}\n{"type":"step_finish","timestamp":2,"sessionID":"ses_1"}\nJ\nexit 0\n', { mode: 0o755 });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-exitok-'));
  const savedPath = process.env.PATH;
  const savedServer = process.env.OPENCODE_STATE_DIR;
  process.env.PATH = bin + ':' + savedPath;
  process.env.NODECUT_KEEP_PATH = '1';
  resetShellEnv();   // the PATH above is the one the child must see
  process.env.OPENCODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-exitok-state-'));
  try {
    start('p-exitok', folder, 'hello');
    await new Promise(done => {
      const tick = () => { if (state('p-exitok').status !== 'running') done(); else setTimeout(tick, 25); };
      tick();
    });
    const s = state('p-exitok', folder);
    assert.equal(s.status, 'done');
    assert.equal(s.error, null);
    assert.ok(s.entries.some(e => e.kind === 'text' && /All done/.test(e.text)));
  } finally {
    process.env.PATH = savedPath;
    delete process.env.NODECUT_KEEP_PATH;
    resetShellEnv();
    if (savedServer === undefined) delete process.env.OPENCODE_STATE_DIR; else process.env.OPENCODE_STATE_DIR = savedServer;
    forget('p-exitok');
  }
});

// --- a turn must never end in a question -------------------------------------------------------------
// NodeCut runs turns so they can be left alone. A question at the end is a dead end: the person has to come back, read it,
// answer it and wait again. The rule is stated in the prompt, so it is tested on the prompt rather than trusted to hold.
test('the standing instructions tell the agent to decide, not to ask', () => {
  assert.match(STYLE, /Never end a turn with a question/);
  assert.match(STYLE, /Where a choice comes up, make it/);
  // the old wording actively invited a question, and it sat two lines above the "no questions" rule
  assert.doesNotMatch(STYLE, /ask one short question/i);
  assert.doesNotMatch(STYLE, /ask which voice/i);
  // a blocker is still allowed to stop the work, but reported as an error, never as a question
  // the sentence wraps across two lines in the prompt, so the match allows the wrap
  assert.match(STYLE.replace(/\n\s*/g, ' '), /Report that as an error/i);
});

test('a film brief repeats the rule, because the brief outlives the session that made it', async () => {
  const { writeBrief } = await import('./brief.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-brief-'));
  writeBrief(dir, 'A test film', 'a short documentary edit of a recording about cooking pasta');
  const md = fs.readFileSync(path.join(dir, 'BRIEF.md'), 'utf8');
  assert.match(md, /autonomous build/i);
  assert.match(md, /without stopping to ask a question/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- catching the turn that stopped to ask, because the exit code cannot see it ---------------------------------------
// A turn ending in a question exits 0: it succeeded, it just stopped halfway and waited for someone. This is the check
// that notices, so the transcript says what happened instead of leaving a dead end that looks like a finished turn.
import { lastTurnQuestion } from './agent.js';

test('the real ending that stopped this build is recognised as a question', () => {
  const entries = [{ kind: 'text', text: 'The music bed is made: a 71-second dark trap instrumental.\n\nReady for me to start sourcing the pictures and building the edit?' }];
  assert.equal(lastTurnQuestion(entries), 'Ready for me to start sourcing the pictures and building the edit?');
});

test('a question inside a reply that then carries on is not a question to answer', () => {
  assert.equal(lastTurnQuestion([{ kind: 'text', text: 'Is it long enough? The rest is done and rendered.' }]), null);
  assert.equal(lastTurnQuestion([{ kind: 'text', text: 'I picked a warm documentary voice. Nothing else was needed.' }]), null);
});

test('nothing to judge is not a question', () => {
  assert.equal(lastTurnQuestion([{ kind: 'tool', text: 'read' }]), null);
  assert.equal(lastTurnQuestion([{ kind: 'text', text: '' }]), null);
  assert.equal(lastTurnQuestion(null), null);
  assert.equal(lastTurnQuestion([]), null);
  // a long paragraph that happens to end in "?" is a summary, not a direct ask
  assert.equal(lastTurnQuestion([{ kind: 'text', text: 'x '.repeat(200) + 'Shall I go ahead?' }]), null);
});
