// Tests for brief.js — the text of a new film's brief, and the routing written beside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanBrief, folderName, briefMarkdown, writeBrief, readBrief, BRIEF_MIN, BRIEF_MAX } from './brief.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vhbrief-'));
const GOOD = 'A 20 second luxury brand film for a candle that smells of old libraries. Dark, slow, no voiceover.';

test('an empty brief is refused with a sentence that says why', () => {
  const r = cleanBrief('');
  assert.equal(r.ok, false);
  assert.match(r.error, /Describe what the film/);
  assert.equal(cleanBrief('   \n  ').ok, false, 'whitespace is not a brief');
  assert.equal(cleanBrief(null).ok, false);
});

test('a brief too short to build from is refused, and says how short', () => {
  const r = cleanBrief('a film');
  assert.equal(r.ok, false);
  assert.match(r.error, /too short/);
  assert.match(r.error, new RegExp(String(BRIEF_MIN)));
});

test('a real brief passes and keeps the user\'s own words', () => {
  const r = cleanBrief('  ' + GOOD + '  ');
  assert.equal(r.ok, true);
  assert.equal(r.brief, GOOD, 'trimmed, but not rewritten');
});

test('an absurdly long brief is refused rather than silently truncated', () => {
  const r = cleanBrief('x'.repeat(BRIEF_MAX + 1));
  assert.equal(r.ok, false);
  assert.match(r.error, /very long/);
});

test('folder names are made safe exactly as the API always did', () => {
  assert.equal(folderName('Spring sale 30s'), 'Spring sale 30s');
  assert.equal(folderName('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i');
  assert.equal(folderName('  ..dots..  '), 'dots');
  assert.equal(folderName('x'.repeat(200)).length, 80);
  assert.equal(folderName(null), '');
});

test('BRIEF.md carries the brief verbatim and names the pipeline', () => {
  const md = briefMarkdown('Library Candle', GOOD, { pipeline: 'cinematic', read: ['mediums.md', 'pacing.md'] }, '2026-11-17 22:00');
  assert.match(md, /^# Library Candle/);
  assert.ok(md.includes(GOOD), 'the brief is in the file, unchanged');
  assert.match(md, /Pipeline: \*\*cinematic\*\*/);
  assert.match(md, /`docs\/craft\/pacing\.md`/);
  assert.match(md, /plan\.json/);
});

test('writeBrief puts both files in the folder, and readBrief gets them back', () => {
  const dir = tmp();
  const info = writeBrief(dir, 'Library Candle', GOOD);
  assert.ok(fs.existsSync(path.join(dir, 'BRIEF.md')));
  assert.ok(fs.existsSync(path.join(dir, 'plan', 'route.json')));
  assert.ok(info.pipeline);
  assert.ok(info.files.length > 0 && info.files.length <= 12);

  const back = readBrief(dir);
  assert.equal(back.brief, GOOD);
  assert.equal(back.pipeline, info.pipeline);
  assert.deepEqual(back.files, info.files);
});

test('the route file is JSON an agent can read without parsing markdown', () => {
  const dir = tmp();
  writeBrief(dir, 'X', GOOD);
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'plan', 'route.json'), 'utf8'));
  assert.deepEqual(Object.keys(r).sort(), ['at', 'files', 'pipeline']);
  assert.ok(Array.isArray(r.files) && r.files.every(f => typeof f === 'string' && !f.startsWith('/')), 'paths are relative to docs/craft/');
});

test('readBrief on a folder with no brief returns null instead of throwing', () => {
  assert.equal(readBrief(tmp()), null);
});

test('a brief with markdown in it survives the round trip', () => {
  const dir = tmp();
  const tricky = 'A film about # headings and `code` and **bold** — 20 seconds, for the client.';
  writeBrief(dir, 'Tricky', tricky);
  assert.equal(readBrief(dir).brief, tricky);
});
