// vhrisk.js — the plan checker.
//
// A film that looks generated is almost never badly rendered. It is a plan that repeated itself: the same medium every
// beat, movement with no reason, text where an image should speak. This scores a plan for those patterns BEFORE a line
// of film.js is written, so the fix costs nothing.
//
// Ported from OpenMontage's lib/slideshow_risk.py and lib/variation_checker.py, plus one rule that did not exist
// upstream: media variety. A NodeCut film chooses a medium per beat (kinetic type, diagram, image_to_video, motion
// graphics, footage, chart). Three beats in a row on the same medium is the single clearest tell of a generated video.
//
// Pure functions, no browser, no clock. Same plan in, same score out.
//
//   import { scorePlan, gate } from './vhrisk.js';
//   const r = scorePlan(plan);        // r.verdict, r.average, r.dimensions, r.problems

// The mediums a beat can be built in. Keep in sync with the `medium` enum in the plan schema.
const MEDIA = ['kinetic_type', 'diagram', 'image_to_video', 'motion_graphics', 'footage', 'chart', 'none'];

// How different two mediums feel to a viewer. Used by the variety rule: a kinetic-type beat next to a diagram beat reads
// as a change, an image_to_video beat next to a footage beat does not (both are moving photographs).
const MEDIUM_FAMILY = {
  kinetic_type: 'type',
  chart: 'type',
  diagram: 'graphic',
  motion_graphics: 'graphic',
  image_to_video: 'live',
  footage: 'live',
  none: 'none',
};

// scores are 0-5, not 0-1: a clamp that defaults to [0,1] silently caps every dimension at 1
const clamp = (x, a = 0, b = 5) => Math.max(a, Math.min(b, x));
const round1 = (x) => Math.round(x * 10) / 10;

// ---- helpers ---------------------------------------------------------------------------------------------

function beatsOf(plan) {
  if (Array.isArray(plan)) return plan;
  return (plan && Array.isArray(plan.beats)) ? plan.beats : [];
}

const mediumOf = (b) => {
  const m = b.medium || (b.type === 'text_card' ? 'kinetic_type' : b.type) || 'none';
  return MEDIA.includes(m) ? m : 'none';
};

// what the beat is FOR. A beat with none of these is decoration.
const hasPurpose = (b) => !!(b.why || b.payoff || b.shot_intent || b.narrative_role || b.information_role);

const durationOf = (b) => {
  const d = (b.t1 ?? b.end_seconds) - (b.t0 ?? b.start_seconds);
  return Number.isFinite(d) ? d : 0;
};

// ---- the six dimensions (ported) -------------------------------------------------------------------------

// 1. repetition: the same medium / the same description shape, over and over
function scoreRepetition(beats) {
  if (beats.length < 3) return { score: 0, reason: 'Too few beats to assess repetition' };
  const n = beats.length;
  const reasons = [];
  let score = 0;

  const media = beats.map(mediumOf);
  const counts = media.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {});
  const [topMedia, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const mediaRatio = topCount / n;
  if (mediaRatio > 0.7) {
    score += 2.0;
    reasons.push(`${topCount}/${n} beats use "${topMedia}"`);
  } else if (mediaRatio > 0.55) {
    score += 1.0;
    reasons.push(`${topCount}/${n} beats use "${topMedia}"`);
  }

  // descriptions that all start the same way read as one template
  const descs = beats.map((b) => String(b.description || b.payoff || '').toLowerCase().trim().slice(0, 40));
  const named = descs.filter(Boolean);
  if (named.length >= 3) {
    const unique = new Set(named).size / named.length;
    if (unique < 0.6) {
      score += 1.5;
      reasons.push(`Only ${Math.round(unique * 100)}% of beat descriptions are distinct`);
    }
  }

  // the same camera move every beat
  const cams = beats.map((b) => (b.shot_language && b.shot_language.camera_movement) || b.camera || 'unspecified');
  const camCounts = cams.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {});
  const camRatio = Math.max(...Object.values(camCounts)) / n;
  // 'static' repeated is not repetition — a held shot is a choice. Only movement counts here.
  const movingCams = cams.filter(c => c !== 'static' && c !== 'unspecified');
  const movingRatio = movingCams.length ? Math.max(...Object.values(movingCams.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {}))) / movingCams.length : 0;
  if (movingRatio > 0.8 && movingCams.length >= 3) {
    score += 1.5;
    reasons.push(`The same camera move in ${Math.round(movingRatio * 100)}% of moving beats`);
  }

  return { score: round1(clamp(score, 0, 5)), reason: reasons.join('; ') || 'Good variety' };
}

// 2. decorative: a beat with no stated purpose is decoration
function scoreDecorative(beats) {
  if (!beats.length) return { score: 0, reason: 'No beats' };
  const bare = beats.filter((b) => !hasPurpose(b)).length;
  const ratio = bare / beats.length;
  const reason = ratio > 0.5
    ? `${bare}/${beats.length} beats state no purpose (no why, payoff or shot intent)`
    : ratio > 0.2 ? `${bare}/${beats.length} beats lack a stated purpose` : 'Most beats have a clear purpose';
  return { score: round1(clamp(ratio * 6.7)), reason };   // 3/4 beats bare = ~5, not 3.75
}

// 3. weak motion: movement with no reason behind it
function scoreWeakMotion(beats) {
  const moving = beats.filter((b) => {
    const m = (b.shot_language && b.shot_language.camera_movement) || b.camera;
    return m && m !== 'static' && m !== 'unspecified' && m !== 'none';
  });
  if (!moving.length) return { score: 1.5, reason: 'No camera movement defined (fine for a static style)' };
  const pointless = moving.filter((b) => !hasPurpose(b)).length;
  const ratio = pointless / moving.length;
  const reason = ratio > 0.5
    ? `${pointless}/${moving.length} moving beats have no stated reason for moving`
    : pointless > 0 ? `${pointless}/${moving.length} moving beats have no stated reason` : 'Camera movement appears purposeful';
  return { score: round1(clamp(ratio * 5, 0, 5)), reason };
}

// 4. weak intent: how many beats say what the shot is FOR
function scoreWeakIntent(beats) {
  if (!beats.length) return { score: 0, reason: 'No beats' };
  const withWhy = beats.filter((b) => b.why || b.shot_intent).length;
  const ratio = withWhy / beats.length;
  const reason = ratio < 0.3
    ? `Only ${withWhy}/${beats.length} beats say why they exist`
    : ratio < 0.6 ? `${withWhy}/${beats.length} beats carry an intent line` : 'Strong intent coverage';
  return { score: round1(clamp((1 - ratio) * 5)), reason };
}

// 5. typography overreliance: too much of the film is words
function scoreTypography(beats) {
  if (!beats.length) return { score: 0, reason: 'No beats' };
  const texty = beats.filter((b) => ['kinetic_type', 'chart'].includes(mediumOf(b))).length;
  const ratio = texty / beats.length;
  if (ratio > 0.6) return { score: 4.0, reason: `${texty}/${beats.length} beats are text-led — the film is animated slides` };
  if (ratio > 0.4) return { score: 2.5, reason: `${texty}/${beats.length} beats are text-led — balance with a visual beat` };
  if (ratio > 0.2) return { score: 1.0, reason: 'Balanced text and visual content' };
  return { score: 0.0, reason: 'Visual-first approach' };
}

// 6. unsupported cinematic claims: "cinematic" with no cinematic structure behind it
function scoreCinematicClaims(beats, opts) {
  const family = String(opts.renderer || opts.renderer_family || '').toLowerCase();
  if (!family.includes('cinematic')) return { score: 0, reason: 'Not claiming cinematic treatment' };
  const issues = [];
  if (!beats.some((b) => b.hero_moment)) issues.push('Claims cinematic but names no hero moment');
  const moving = beats.filter((b) => {
    const m = (b.shot_language && b.shot_language.camera_movement) || b.camera;
    return m && m !== 'static' && m !== 'unspecified';
  }).length;
  if (moving < beats.length * 0.3) issues.push(`Claims cinematic but only ${moving}/${beats.length} beats move`);
  const lit = beats.filter((b) => b.shot_language && b.shot_language.lighting_key).length;
  if (lit < beats.length * 0.3) issues.push(`Claims cinematic but only ${lit}/${beats.length} beats define lighting`);
  return { score: round1(clamp(issues.length * 1.8, 0, 5)), reason: issues.join('; ') || 'Cinematic claims supported by structure' };
}

// ---- the rule that did not exist upstream: media variety -------------------------------------------------

// Three beats in a row on the same medium family is the clearest tell of a generated film. Scored 0-5 so it drops into
// the same table as the other dimensions.
function scoreMediaVariety(beats) {
  if (beats.length < 3) return { score: 0, reason: 'Too few beats to assess variety' };
  const fams = beats.map((b) => MEDIUM_FAMILY[mediumOf(b)] || 'none');
  let worst = 0, worstAt = -1, runs = 0;
  for (let i = 0, run = 1; i < fams.length; i++) {
    run = i > 0 && fams[i] === fams[i - 1] ? run + 1 : 1;
    if (run > worst) { worst = run; worstAt = i - run + 1; }
  }
  const distinct = new Set(fams).size;
  const reasons = [];
  let score = 0;
  if (worst >= 3) {
    score += worst >= 4 ? 3.5 : 2.5;
    reasons.push(`${worst} beats in a row are the same medium (from beat ${worstAt + 1})`);
  }
  if (fams.length >= 5 && distinct <= 2) {
    score += 1.5;
    reasons.push(`Only ${distinct} different mediums across ${fams.length} beats`);
  }
  // count non-overlapping runs of 3+
  for (let i = 2; i < fams.length; i++) if (fams[i] === fams[i - 1] && fams[i] === fams[i - 2] && (i < 3 || fams[i - 3] !== fams[i])) runs++;
  if (runs >= 2) {
    score += 1.5;
    reasons.push(`${runs} separate runs of three beats on one medium`);
  }
  return { score: round1(clamp(score, 0, 5)), reason: reasons.join('; ') || 'The film changes medium across its beats' };
}

// ---- verdict ---------------------------------------------------------------------------------------------

function verdictFor(avg) {
  if (avg < 2.0) return 'strong';
  if (avg < 3.0) return 'acceptable';
  if (avg < 4.0) return 'revise';
  return 'fail';
}

// The three worst dimensions, as sentences an agent can act on. Always says what to do, never only what is wrong.
function problemsFor(dims) {
  const advice = {
    repetition: 'Vary the medium and the camera move between beats.',
    decorative_visuals: 'Give every beat a stated purpose: one line of "why this beat exists".',
    weak_motion: 'Either give each moving beat a reason to move, or hold it still.',
    weak_shot_intent: 'Write a shot intent line for each beat (what the shot is for, not what it shows).',
    typography_overreliance: 'Replace a text-led beat with a visual one: diagram, motion graphics or footage.',
    unsupported_cinematic_claims: 'Either add cinematic structure (hero moment, movement, lighting) or drop the label.',
    media_variety: 'Break the run of same-medium beats: a diagram, a chart, a motion-graphics beat.',
  };
  // a dimension scored under 1.5 is reading well; listing it under "worst" sends the agent to fix something that is fine
  return Object.entries(dims)
    .filter(([, d]) => d.score >= 1.5)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 3)
    .map(([k, d]) => ({ dimension: k, score: d.score, problem: d.reason, fix: advice[k] || '' }));
}

// scorePlan(plan, opts) -> { average, verdict, dimensions, problems, beats }
// opts.renderer: 'cinematic' | 'explainer' | ... (used only by the cinematic-claims dimension)
function scorePlan(plan, opts = {}) {
  const beats = beatsOf(plan);
  if (!beats.length) return { average: 5, verdict: 'fail', dimensions: {}, problems: [], beats: 0, reason: 'The plan has no beats', empty: true };

  const dimensions = {
    repetition: scoreRepetition(beats),
    decorative_visuals: scoreDecorative(beats),
    weak_motion: scoreWeakMotion(beats),
    weak_shot_intent: scoreWeakIntent(beats),
    typography_overreliance: scoreTypography(beats),
    unsupported_cinematic_claims: scoreCinematicClaims(beats, opts),
    media_variety: scoreMediaVariety(beats),
  };
  // A plain mean is wrong here: three dimensions that are not applicable (no cinematic claim, no camera movement,
  // no text) score 0 and outvote the two that actually detect a slideshow. Variety and repetition ARE the test, so they
  // carry double weight — a film that never changes medium cannot average its way to "strong".
  const WEIGHT = { media_variety: 2, repetition: 2 };
  let sum = 0, total = 0;
  for (const [k, d] of Object.entries(dimensions)) { const w = WEIGHT[k] || 1; sum += d.score * w; total += w; }
  const average = round1(sum / total);
  return { average, verdict: verdictFor(average), dimensions, problems: problemsFor(dimensions), beats: beats.length };
}

// ---- variation checker (ported): generic language that reads as template copy ----------------------------

const GENERIC = [
  'a person', 'a beautiful', 'modern', 'futuristic', 'cutting-edge', 'state-of-the-art',
  "in today's world", 'sleek design', 'innovative', 'next-generation', 'revolutionary',
  'a professional', 'dynamic', 'game-changing', 'world-class', 'seamless experience',
];

// scanText(text) -> the generic phrases it uses. Used on a plan's descriptions and on a voice-over script.
function scanText(text) {
  const low = String(text || '').toLowerCase();
  return GENERIC.filter((g) => low.includes(g));
}

// checkVariation(plan) -> layout/description repetition that will show up in the film
function checkVariation(plan) {
  const beats = beatsOf(plan);
  const issues = [];
  if (!beats.length) return { ok: true, issues };

  const media = beats.map(mediumOf);
  for (let i = 2; i < media.length; i++) {
    if (media[i] === media[i - 1] && media[i] === media[i - 2]) {
      issues.push({ kind: 'medium_run', at: i - 1, detail: `beats ${i - 1}-${i + 1} are all "${media[i]}"` });
      i += 2;
    }
  }

  const generic = [];
  beats.forEach((b, i) => {
    const hits = scanText(b.description || b.payoff || b.why || '');
    if (hits.length) generic.push({ kind: 'generic_language', at: i, detail: hits.join(', ') });
  });
  issues.push(...generic);

  // a beat too short to read anything on it
  beats.forEach((b, i) => {
    const d = durationOf(b);
    if (d > 0 && d < 1.2 && ['kinetic_type', 'chart', 'diagram'].includes(mediumOf(b))) {
      issues.push({ kind: 'too_short', at: i, detail: `${d.toFixed(2)}s is too short to read "${(b.description || '').slice(0, 40)}"` });
    }
  });

  return { ok: issues.length === 0, issues };
}

// ---- the gate --------------------------------------------------------------------------------------------

// gate(plan, opts) -> { pass, score, reasons }. A plan at or above `maxAverage` does not get built.
function gate(plan, opts = {}) {
  const max = opts.maxAverage ?? 4.0;
  const score = scorePlan(plan, opts);
  const variation = checkVariation(plan);
  const reasons = [];
  if (score.empty) return { pass: false, score, variation, reasons: ['The plan has no beats'] };
  if (score.average >= max) reasons.push(`Slideshow risk ${score.average} is at or above the limit (${max})`);
  // an average can be argued down by inapplicable dimensions; a hard variety failure cannot
  if (score.dimensions.media_variety.score >= 2.5) reasons.push(`The film does not change medium: ${score.dimensions.media_variety.reason}`);
  if (score.dimensions.repetition.score >= 3) reasons.push(`Too repetitive: ${score.dimensions.repetition.reason}`);
  if (score.verdict === 'fail') reasons.push('Verdict: fail — the plan repeats itself in a way a viewer will notice');
  if (!variation.ok) reasons.push(`${variation.issues.length} variation issue(s): ` + variation.issues.slice(0, 3).map((i) => i.detail).join('; '));
  return { pass: reasons.length === 0, score, variation, reasons };
}

const VHRISK = {
  MEDIA,
  MEDIUM_FAMILY,
  scorePlan,
  checkVariation,
  scanText,
  gate,
  verdictFor,
  // exported for tests
  _internals: { scoreRepetition, scoreDecorative, scoreWeakMotion, scoreWeakIntent, scoreTypography, scoreCinematicClaims, scoreMediaVariety },
};

// Also reachable as a global, so a classic <script> film can use it after a one-time dynamic import.
if (typeof window !== 'undefined') window.VHRISK = VHRISK;
export default VHRISK;
export { MEDIA, MEDIUM_FAMILY, scorePlan, checkVariation, scanText, gate, verdictFor };
