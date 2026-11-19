// Tests for agent.js — the Agent tab's event parsing and its guards. The parser cases are real lines captured from
// `opencode run --format json`, including the two failures this machine actually produces (guardrail block, no credits).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLine, state, stop, forget, start, sessionIdFor, readMeta, writeMeta, SESSION_FILE } from './agent.js';

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
