// Tests for plan.js — the planning stage: routing, validation, and the refusal gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { route, validate, save, read, summary, TEAM_DIR, clipQuote, pricePlan, priceLine } from './plan.js';

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


// the same film with six generated clips: still structurally readable, but now over the cap
const MONTAGE = {
  title: 'Verdant v1 (clips)',
  duration: 18,
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
  const r = save(dir, MONTAGE);   // six generated clips: refused on the cap before the checker even runs
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
  const mixed = { duration: 18, beats: [
    beat({ id: 'b1', t0: 0, t1: 3, medium: 'footage', name: 'a', why: 'x' }),
    beat({ id: 'b2', t0: 3, t1: 6, medium: 'kinetic_type', name: 'b', why: 'x' }),
    beat({ id: 'b3', t0: 6, t1: 9, medium: 'image_to_video', name: 'c', why: 'x' }),
    beat({ id: 'b4', t0: 9, t1: 12, medium: 'diagram', name: 'd', why: 'x' }),
    beat({ id: 'b5', t0: 12, t1: 15, medium: 'chart', name: 'e', why: 'x' }),
    beat({ id: 'b6', t0: 15, t1: 18, medium: 'motion_graphics', name: 'f', why: 'x' }),
  ] };
  const r = save(dir, mixed, { force: true });
  assert.equal(r.ok, true);
  assert.equal(r.written, true);
  // the point of force: it is written even though the checker refused it, and the refusal is kept on the record
  assert.ok(r.score.verdict);
  assert.ok(r.score.dimensions.media_variety.score >= 0);
});

test('summary tells the agent the score and what to fix, never only what is wrong', () => {
  // one moving beat clears the stills rule, so what is left is repetition — which is the checker's job, not the schema's.
  const dir = tmp();
  const plan = { duration: 18, beats: [
    beat({ id: 'b1', name: 'a', t0: 0, t1: 3, medium: 'footage', why: 'the place' }),
    beat({ id: 'b2', name: 'b', t0: 3, t1: 6, medium: 'footage', why: 'the place again' }),
    beat({ id: 'b3', name: 'c', t0: 6, t1: 9, medium: 'footage', why: 'the place once more' }),
    beat({ id: 'b4', name: 'd', t0: 9, t1: 12, medium: 'image_to_video', why: 'the plate comes alive' }),
    beat({ id: 'b5', name: 'e', t0: 12, t1: 15, medium: 'kinetic_type', why: 'the word' }),
    beat({ id: 'b6', name: 'f', t0: 15, t1: 18, medium: 'kinetic_type', why: 'the word again' }),
  ] };
  const r = save(dir, plan, { force: true });
  assert.equal(r.written, true, 'a valid plan is written even when the checker refuses it: ' + (r.errors || []).join('; '));
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
  // the shipped film: the same still repeated, and the same word repeated (one beat moves, so the plan is schema-valid
  // and it is the checker, not the schema, that has to catch it)
  const shipped = { duration: 18, beats: [
    { id: 'b1', name: 'shot', t0: 0, t1: 3, medium: 'footage', why: 'another shot of the product', camera: 'slow push' },
    { id: 'b2', name: 'shot', t0: 3, t1: 6, medium: 'footage', why: 'another shot of the product', camera: 'slow push' },
    { id: 'b3', name: 'shot', t0: 6, t1: 9, medium: 'image_to_video', why: 'another shot of the product', camera: 'slow push' },
    { id: 'b4', name: 'word', t0: 9, t1: 12, medium: 'kinetic_type', why: 'another shot of the product', camera: 'slow push' },
    { id: 'b5', name: 'word', t0: 12, t1: 15, medium: 'kinetic_type', why: 'another shot of the product', camera: 'slow push' },
    { id: 'b6', name: 'word', t0: 15, t1: 18, medium: 'kinetic_type', why: 'another shot of the product', camera: 'slow push' },
  ] };
  const a = save(dirA, shipped, { force: true });
  const b = save(dirB, GOOD);
  assert.ok(a.score, 'the shipped film must be schema-valid so the score exists: ' + (a.errors || []).join('; '));
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

// --- generated video: a medium the planner can now choose on its own, and a price the person sees first -------------
// Before this, `text_to_video` was a real tool but not a real medium: the plan schema had no such value, so the planner
// physically could not say "this beat should be a generated clip". These pin the choice, the price and the guard rails.

test('text_to_video is a medium the plan accepts, and a generated clip is priced before it is made', () => {
  const plan = {
    duration: 6,
    beats: [
      beat({ id: 'b1', t0: 0, t1: 3, medium: 'kinetic_type' }),
      beat({ id: 'b2', t0: 3, t1: 6, medium: 'text_to_video', why: 'the sizzle is the point' }),
    ],
  };
  const v = validate(plan);
  assert.equal(v.ok, true, 'a generated clip beat is a valid beat: ' + v.errors.join(' '));
  const priced = pricePlan(plan);
  assert.equal(priced.clips, 1);
  assert.ok(priced.total > 0, 'a clip with no price would be a clip nobody agreed to pay for');
  assert.match(v.warnings.join(' '), /Spends about \$/, 'the spend is stated on the plan, not discovered from a bill');
});

test('a beat longer than one clip is priced as several, because half a clip is not a thing you can buy', () => {
  assert.equal(clipQuote('text_to_video', 3).clips, 1, 'a short beat still needs one whole clip');
  assert.equal(clipQuote('text_to_video', 5).clips, 1, 'exactly five seconds is one clip, not two');
  assert.equal(clipQuote('text_to_video', 5.1).clips, 2);
  assert.equal(clipQuote('text_to_video', 11).clips, 3);
  assert.equal(clipQuote('diagram', 12).clips, 0, 'a drawn beat costs nothing and is not counted');
});

test('image_to_video and text_to_video are the same family, so alternating them is not variety', () => {
  // The point of the family map: a film cannot fill its variety quota by alternating two generated clips.
  const plan = {
    beats: [
      beat({ id: 'b1', t0: 0, t1: 3, medium: 'text_to_video' }),
      beat({ id: 'b2', t0: 3, t1: 6, medium: 'image_to_video' }),
      beat({ id: 'b3', t0: 6, t1: 9, medium: 'text_to_video' }),
    ],
  };
  const s = summary(plan);
  assert.match(s, /does not change medium|same medium/i, 'three generated clips in a row must read as one medium');
});

test('a plan that is mostly bought shots is refused, and a four-clip film is called a montage', () => {
  const many = { beats: [
    beat({ id: 'b1', t0: 0, t1: 4, medium: 'text_to_video' }),
    beat({ id: 'b2', t0: 4, t1: 8, medium: 'kinetic_type' }),
    beat({ id: 'b3', t0: 8, t1: 12, medium: 'text_to_video' }),
    beat({ id: 'b4', t0: 12, t1: 16, medium: 'diagram' }),
    beat({ id: 'b5', t0: 16, t1: 20, medium: 'text_to_video' }),
    beat({ id: 'b6', t0: 20, t1: 24, medium: 'motion_graphics' }),
    beat({ id: 'b7', t0: 24, t1: 28, medium: 'text_to_video' }),
  ] };
  const v = validate(many);
  // the cap is a hard rule now, not a warning: the warning version was ignored for as long as it existed
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /4 generated clips is a montage/);
  assert.match(v.errors.join(' '), /More than half the beats are generated clips/);
  assert.equal(summary(many).includes('4 generated clips is a montage') || v.errors.length > 0, true);
});

test('a plan with no generated clips says nothing about money', () => {
  const plain = { beats: [beat({ id: 'b1' }), beat({ id: 'b2', t0: 3, t1: 6, medium: 'diagram' })] };
  const v = validate(plain);
  assert.doesNotMatch(v.warnings.join(' '), /\$/);
  assert.equal(priceLine(pricePlan(plain)), '', 'no clip means no line, not a line saying zero');
});

test('a food brief is routed to the notes that explain when a generated clip earns its place', () => {
  const r = route('a short video about cooking for LinkedIn');
  assert.equal(r.pipeline, 'food');
  assert.ok(r.read.includes('mediums.md'), 'the generated-clip rules live in mediums.md and are always read');
  assert.ok(r.read.includes('camera.md'), 'a cooking film is about how the food is shot');
});

// --- stills must not sit still ------------------------------------------------------------------------------------
// The failure this pins: a film built entirely from photographs, each held while the voice does the talking. Every beat
// was "valid" and the plan saved, so nothing caught it. A still that was already on screen is the cheapest beat in the
// film to animate, so a long film with no moving beat is now refused outright.

test('a long film where every picture is a still is refused, and names the beats to animate', () => {
  const plan = { beats: [
    beat({ id: 'b1', t0: 0, t1: 4, medium: 'footage' }),
    beat({ id: 'b2', t0: 4, t1: 8, medium: 'kinetic_type' }),
    beat({ id: 'b3', t0: 8, t1: 12, medium: 'footage' }),
    beat({ id: 'b4', t0: 12, t1: 16, medium: 'diagram' }),
  ] };
  const v = validate(plan);
  assert.equal(v.ok, false, 'sixteen seconds of held photographs is a slideshow');
  assert.match(v.errors.join(' '), /All 2 picture beats are stills \(b1, b3\)/);
  assert.match(v.errors.join(' '), /image_to_video|text_to_video/, 'the fix must say which medium to use');
});

test('a short sting is allowed to be all stills, because there is no room for a move to pay for itself', () => {
  const plan = { beats: [beat({ id: 'b1', t0: 0, t1: 4, medium: 'footage' }), beat({ id: 'b2', t0: 4, t1: 8, medium: 'kinetic_type' })] };
  const v = validate(plan);
  assert.equal(v.ok, true, v.errors.join('; '));
});

test('one moving beat is enough to clear the stills rule, so the rule asks for a film that moves, not a montage', () => {
  const plan = { beats: [
    beat({ id: 'b1', t0: 0, t1: 4, medium: 'footage' }),
    beat({ id: 'b2', t0: 4, t1: 8, medium: 'image_to_video', why: 'the plate comes alive' }),
    beat({ id: 'b3', t0: 8, t1: 12, medium: 'kinetic_type' }),
    beat({ id: 'b4', t0: 12, t1: 16, medium: 'diagram' }),
  ] };
  assert.equal(validate(plan).ok, true);
});

test('the cap is refused, not warned: six generated clips cannot be saved', () => {
  const dir = tmp();
  const r = save(dir, MONTAGE, { force: true });
  assert.equal(r.ok, false, 'force overrides the checker, never the schema');
  assert.match(r.errors.join(' '), /6 generated clips is a montage, not a film/);
});

test('an image_to_video beat warns that its plate does not exist yet, so the still is not discovered at build time', () => {
  const plan = { duration: 12, beats: [
    beat({ id: 'b1', t0: 0, t1: 3, medium: 'footage' }),
    beat({ id: 'b2', t0: 3, t1: 6, medium: 'image_to_video', why: 'the plate comes alive' }),
    beat({ id: 'b3', t0: 6, t1: 9, medium: 'kinetic_type' }),
    beat({ id: 'b4', t0: 9, t1: 12, medium: 'diagram' }),
  ] };
  const v = validate(plan);
  assert.match(v.warnings.join(' '), /no still is recorded yet/);
  assert.match(v.warnings.join(' '), /hub_generate_still/);

  const withPlate = { ...plan, plates: [{ id: 'still_0001' }] };
  assert.doesNotMatch(validate(withPlate).warnings.join(' '), /no still is recorded yet/);
});

test('the summary counts stills against moving beats, so the number is visible while planning', () => {
  const plan = { beats: [
    beat({ id: 'b1', t0: 0, t1: 4, medium: 'footage' }),
    beat({ id: 'b2', t0: 4, t1: 8, medium: 'image_to_video' }),
    beat({ id: 'b3', t0: 8, t1: 12, medium: 'kinetic_type' }),
  ] };
  const s = summary(plan);
  assert.match(s, /Picture beats: 2 still, 1 moving/);
});
