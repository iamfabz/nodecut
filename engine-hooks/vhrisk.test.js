// Tests for vhrisk.js — the plan checker. Every case is a real failure mode this fork has shipped at least once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scorePlan, checkVariation, gate, scanText, MEDIA, GENERATED_MEDIA, verdictFor } from './vhrisk.js';

const beat = (o = {}) => ({ t0: 0, t1: 3, medium: 'image_to_video', why: 'it earns its place', payoff: 'the jar', ...o });

// the shape of the VERDANT film before this checker existed: six generated clips with a caption on each
const REPETITIVE = [0, 1, 2, 3, 4, 5].map(i => beat({
  t0: i * 3.33, t1: (i + 1) * 3.33, medium: 'image_to_video',
  description: `shot ${i}`, why: '', payoff: '', camera: 'slow push',
}));

// six beats, six different mediums, each with a purpose line
const VARIED = [
  beat({ medium: 'footage', why: 'establish the field', description: 'misty pasture', camera: 'drift' }),
  beat({ medium: 'image_to_video', why: 'portrait the subject', description: 'the cow', camera: 'push' }),
  beat({ medium: 'kinetic_type', why: 'the word carries the claim', description: 'NATURAL', camera: 'static' }),
  beat({ medium: 'motion_graphics', why: 'the lockup assembling', description: 'stamp', camera: 'static' }),
  beat({ medium: 'chart', why: 'years not pounds, plotted', description: 'bar chart', camera: 'static' }),
  beat({ medium: 'diagram', why: 'the three stages', description: 'process diagram', camera: 'static' }),
];

test('a film of six identical clip beats scores badly and is refused', () => {
  // a bare beat, so the fixture cannot smuggle in a purpose line and score better than a real one would
  const bare = (o = {}) => ({ t0: 0, t1: 3, medium: 'image_to_video', ...o });
  const plan = [0, 1, 2, 3, 4, 5].map(i => bare({ description: `shot ${i}`, camera: 'slow push' }));
  const r = scorePlan(plan);
  assert.ok(r.average >= 3, `expected a bad score, got ${r.average}`);
  assert.ok(['revise', 'fail'].includes(r.verdict), `expected revise/fail, got ${r.verdict}`);
  const g = gate(plan);
  assert.equal(g.pass, false);
  assert.ok(g.reasons.length > 0);
});

test('a film that changes medium every beat scores strong', () => {
  const r = scorePlan(VARIED);
  assert.ok(r.average < 2.0, `expected a good score, got ${r.average}`);
  assert.equal(r.verdict, 'strong');
  assert.equal(gate(VARIED).pass, true);
});

test('the media-variety rule fires on three beats in a row of one family', () => {
  const plan = [
    beat({ medium: 'footage' }),
    beat({ medium: 'footage' }),
    beat({ medium: 'footage' }),
    beat({ medium: 'kinetic_type' }),
  ];
  const r = scorePlan(plan);
  assert.ok(r.dimensions.media_variety.score > 0);
  assert.match(r.dimensions.media_variety.reason, /3 beats in a row/);
});

test('image_to_video followed by footage does NOT count as variety (both are live)', () => {
  const plan = [beat({ medium: 'image_to_video' }), beat({ medium: 'footage' }), beat({ medium: 'image_to_video' })];
  const r = scorePlan(plan);
  assert.ok(r.dimensions.media_variety.score > 0, 'three live beats in a row should be flagged');
});

test('a beat with no stated purpose is scored as decorative', () => {
  const plan = [
    beat({ why: '', payoff: '', description: 'sky' }),
    beat({ why: '', payoff: '', description: 'moon' }),
    beat({ why: '', payoff: '', description: 'cloud' }),
    beat({ why: 'x', payoff: 'y', description: 'sun' }),
  ];
  const r = scorePlan(plan);
  assert.ok(r.dimensions.decorative_visuals.score > 1.5);
});

test('text-led films are flagged before they become animated slides', () => {
  const plan = [beat({ medium: 'kinetic_type' }), beat({ medium: 'kinetic_type' }), beat({ medium: 'chart' }), beat({ medium: 'kinetic_type' })];
  const r = scorePlan(plan);
  assert.ok(r.dimensions.typography_overreliance.score >= 2.5);
});

test('camera movement without a reason scores weak motion', () => {
  // a bare beat: no why and no payoff, so the movement has nothing to justify it
  const bare = (o = {}) => ({ t0: 0, t1: 3, medium: 'image_to_video', ...o });
  const plan = [bare({ camera: 'push' }), bare({ camera: 'push' }), bare({ camera: 'static', why: 'held' })];
  const r = scorePlan(plan);
  assert.ok(r.dimensions.weak_motion.score > 2, `got ${r.dimensions.weak_motion.score}`);
});

test('cinematic claims with no hero moment or lighting are penalised', () => {
  const plan = VARIED.map(b => ({ ...b, shot_language: { camera_movement: 'static' } }));
  const r = scorePlan(plan, { renderer: 'cinematic' });
  assert.ok(r.dimensions.unsupported_cinematic_claims.score > 0);
  assert.match(r.dimensions.unsupported_cinematic_claims.reason, /hero moment/);
});

test('checkVariation catches a run and generic language, and says where', () => {
  const plan = [
    beat({ medium: 'kinetic_type' }),
    beat({ medium: 'kinetic_type' }),
    beat({ medium: 'kinetic_type' }),
    beat({ medium: 'diagram', description: 'a beautiful modern dashboard' }),
  ];
  const v = checkVariation(plan);
  assert.equal(v.ok, false);
  assert.ok(v.issues.some(i => i.kind === 'medium_run'));
  assert.ok(v.issues.some(i => i.kind === 'generic_language' && /modern|beautiful/.test(i.detail)));
});

test('a text beat shorter than 1.2s is flagged as unreadable', () => {
  const plan = [beat({ medium: 'kinetic_type', t0: 0, t1: 0.8, description: 'EXTREMELY HEALTHY' }), beat({ medium: 'diagram' })];
  const v = checkVariation(plan);
  assert.ok(v.issues.some(i => i.kind === 'too_short'));
});

test('scanText finds generic filler', () => {
  assert.deepEqual(scanText('A beautiful, state-of-the-art platform'), ['a beautiful', 'state-of-the-art']);
});

test('every problem carries a fix, never only a diagnosis', () => {
  const r = scorePlan([0, 1, 2, 3, 4, 5].map(i => ({ t0: 0, t1: 3, medium: 'image_to_video', description: `shot ${i}`, camera: 'push' })));
  assert.ok(r.problems.length > 0);
  for (const p of r.problems) {
    assert.ok(p.fix && p.fix.length > 10, `problem "${p.dimension}" has no fix`);
  }
});

test('an empty plan fails rather than passing silently', () => {
  const r = scorePlan({ beats: [] });
  assert.equal(r.verdict, 'fail');
  assert.equal(gate({ beats: [] }).pass, false);
});

test('scoring is deterministic: the same plan twice gives the same score', () => {
  const a = scorePlan(VARIED), b = scorePlan(VARIED);
  assert.deepEqual(a, b);
});

test('verdict thresholds are the upstream ones', () => {
  assert.equal(verdictFor(1.9), 'strong');
  assert.equal(verdictFor(2.5), 'acceptable');
  assert.equal(verdictFor(3.5), 'revise');
  assert.equal(verdictFor(4.0), 'fail');
});

test('the medium list is the closed set the plan schema allows', () => {
  assert.deepEqual(MEDIA, ['kinetic_type', 'diagram', 'image_to_video', 'text_to_video', 'motion_graphics', 'footage', 'chart', 'none']);
});

test('every generated medium is one the plan knows how to build', () => {
  // The price list and the schema have to agree: a medium that costs money but cannot be planned is a feature nobody can
  // reach, and a medium that can be planned but has no price is a spend the person is never shown.
  for (const m of GENERATED_MEDIA) assert.ok(MEDIA.includes(m), `${m} is priced but not plannable`);
});

test('the patterns the craft doc recommends all survive the variety checker', () => {
  // A recommended pattern that its own checker refuses is worse than no pattern: the planner would be told to do
  // something the next call rejects. This is the exact order the four patterns in docs/craft/mediums.md print.
  const patterns = {
    'reveal ladder': ['text_to_video', 'diagram', 'kinetic_type', 'motion_graphics'],
    argument: ['kinetic_type', 'chart', 'text_to_video', 'diagram'],
    portrait: ['text_to_video', 'motion_graphics', 'image_to_video', 'kinetic_type'],
    recipe: ['text_to_video', 'diagram', 'kinetic_type'],
  };
  for (const [name, media] of Object.entries(patterns)) {
    const beats = media.map((medium, i) => ({ id: 'b' + (i + 1), medium, t0: i * 3, t1: (i + 1) * 3, why: 'x' }));
    const v = checkVariation(beats);
    assert.equal(v.ok, true, `the ${name} pattern is refused: ${v.issues.map((i) => i.detail).join('; ')}`);
  }
});
