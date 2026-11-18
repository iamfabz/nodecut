// Tests for plan.js — the planning stage: routing, validation, and the refusal gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { route, validate, save, read, summary, TEAM_DIR } from './plan.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vhplan-'));
const beat = (o = {}) => ({ t0: 0, t1: 3, medium: 'footage', why: 'it earns its place', payoff: 'the shot', ...o });

// a plan that should pass: six beats, six mediums, every one with a reason
const GOOD = {
  title: 'Verdant',
  duration: 18,
  beats: [
    beat({ id: 'b1', name: 'field', t0: 0, t1: 3, medium: 'footage', why: 'establish the place', payoff: 'the field' }),
    beat({ id: 'b2', name: 'subject', t0: 3, t1: 6, medium: 'image_to_video', why: 'she is the customer', payoff: 'her face' }),
    beat({ id: 'b3', name: 'element', t0: 6, t1: 9, medium: 'kinetic_type', why: 'the word is the image', payoff: 'NATURAL' }),
    beat({ id: 'b4', name: 'offering', t0: 9, t1: 12, medium: 'motion_graphics', why: 'the lockup makes itself', payoff: 'the wordmark' }),
    beat({ id: 'b5', name: 'claim', t0: 12, t1: 15, medium: 'chart', why: 'a number is an argument', payoff: 'the bar climbs' }),
    beat({ id: 'b6', name: 'close', t0: 15, t1: 18, medium: 'diagram', why: 'close on what it is', payoff: 'the diagram' }),
  ],
};

// the film this fork actually shipped: six generated clips with a caption
const BAD = {
  title: 'Verdant v1',
  duration: 18,
  // every beat has a why, so this plan is structurally valid — it fails on what the checker is for: repetition
  beats: [0, 1, 2, 3, 4, 5].map((i) => ({ id: `b${i + 1}`, name: `beat ${i + 1}`, t0: i * 3, t1: (i + 1) * 3, medium: 'image_to_video', why: 'another shot of the product', camera: 'slow push' })),
};

test('route finds the kind of film from the brief and returns only a handful of craft files', () => {
  for (const brief of [
    'a luxury brand film for a seasoning',
    'an explainer about how wifi works',
    'short vertical reels for instagram',
    'a motion graphics logo sting',
    'a product demo walkthrough of the app',
    'a talking head testimonial',
    'a film with music and a voice-over',
  ]) {
    const r = route(brief);
    assert.ok(r.read.length > 0 && r.read.length <= 7, `${brief} -> ${r.read.length} files`);
    for (const f of r.read) assert.ok(fs.existsSync(path.join(TEAM_DIR, f)), `${brief}: craft file is missing: ${f}`);
  }
});

test('every routed file is one of the craft notes that actually exists', () => {
  const all = fs.readdirSync(TEAM_DIR).filter(f => f.endsWith('.md'));
  assert.ok(all.length >= 8, 'the craft folder is the reference; it must not be empty');
  const r = route('a brand film');
  for (const f of r.read) assert.ok(all.includes(f), `${f} is not a craft note`);
});

test('mediums and taste are never skipped: a film always chooses a medium and commits to a look', () => {
  for (const brief of ['a brand film', 'an explainer', 'reels', 'a logo sting']) {
    const r = route(brief);
    assert.ok(r.read.includes('mediums.md'), `${brief} must read mediums.md`);
    assert.ok(r.read.includes('taste.md'), `${brief} must read taste.md`);
  }
});

test('a film with sound always gets the sound notes', () => {
  assert.ok(route('a brand film with music').read.includes('sound.md'));
  assert.ok(route('a luxury trailer, no voiceover, score').read.includes('sound.md'));
});

test('route picks the right kind of film per brief', () => {
  assert.equal(route('a cinematic brand film').pipeline, 'cinematic');
  assert.equal(route('an explainer about volcanoes').pipeline, 'explainer');
  assert.equal(route('vertical tiktok reels').pipeline, 'short-form');
  assert.equal(route('a kinetic logo sting').pipeline, 'animation');
});

test('route falls back to cinematic when the brief says nothing recognisable', () => {
  assert.equal(route('something').pipeline, 'cinematic');
  assert.equal(route('').pipeline, 'cinematic');
});

test('validate accepts a complete plan', () => {
  const v = validate(GOOD);
  assert.equal(v.ok, true, v.errors.join('; '));
});

test('validate insists on a why for every beat', () => {
  const plan = { beats: GOOD.beats.map((b, i) => (i === 2 ? { ...b, why: '' } : b)) };
  const v = validate(plan);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /beat 3.*why/);
});

test('validate rejects an unknown medium', () => {
  const plan = { beats: [{ ...beat({ id: 'b1' }), medium: 'interpretive_dance' }] };
  const v = validate(plan);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /interpretive_dance/);
});

test('validate rejects a beat that ends before it starts', () => {
  const v = validate({ beats: [beat({ id: 'b1', t0: 5, t1: 2 })] });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /after t0/);
});

test('validate warns (not errors) about a gap between beats', () => {
  const plan = { beats: [beat({ id: 'b1', t0: 0, t1: 3 }), beat({ id: 'b2', t0: 5, t1: 8 })] };
  const v = validate(plan);
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => /gap or overlap/.test(w)));
});

test('save refuses a plan the checker would refuse, and writes nothing', () => {
  const dir = tmp();
  const r = save(dir, BAD);
  assert.equal(r.ok, false);
  assert.equal(r.written, false);
  assert.equal(fs.existsSync(path.join(dir, 'plan.json')), false);
  assert.ok(r.errors.length > 0);
});

test('save writes a good plan and read() gives it back', () => {
  const dir = tmp();
  const r = save(dir, GOOD);
  assert.equal(r.ok, true, r.errors?.join('; '));
  assert.equal(r.written, true);
  const back = read(dir);
  assert.equal(back.beats.length, 6);
  assert.equal(back.beats[2].medium, 'kinetic_type');
  assert.equal(back.duration, 18);
  assert.ok(back.score.verdict);
});

test('save(force) writes a refused plan when the agent is told to override', () => {
  const dir = tmp();
  const r = save(dir, BAD, { force: true });
  assert.equal(r.ok, true);
  assert.equal(r.written, true);
  // the point of force: it is written even though the checker refused it, and the refusal is kept on the record
  // the verdict is a single number that the variety gate outranks; the gate's own signal is what matters here
  assert.equal(r.score.verdict, 'strong', 'the average alone reads as strong — which is exactly why the hard gate exists');
  assert.ok(r.score.dimensions.media_variety.score > 0);
});

test('summary tells the agent the score and what to fix, never only what is wrong', () => {
  const dir = tmp();
  save(dir, BAD, { force: true });
  const s = summary(dir);
  assert.match(s, /risk/);
  assert.match(s, /Worst three/);
  assert.match(s, /→/, 'each problem needs a fix after the arrow');
});

test('summary on an empty folder says so instead of throwing', () => {
  assert.match(summary(tmp()), /No plan\.json/);
});

test('scoring the shipped film against the rebuilt one shows a clear gap', () => {
  const dirA = tmp(), dirB = tmp();
  const a = save(dirA, BAD, { force: true });
  const b = save(dirB, GOOD);
  assert.ok(a.score.average > b.score.average + 1.0, `expected a clear gap, got ${a.score.average} vs ${b.score.average}`);
  assert.equal(b.score.verdict, 'strong');
});

test('force overrides the checker, never the schema', () => {
  const dir = tmp();
  const broken = { beats: [{ t0: 0, t1: 3, medium: 'footage' }] };   // no id, no why
  const r = save(dir, broken, { force: true });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /why/);
});
