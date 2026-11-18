// plan.js — the planning stage: brief in, checked plan.json out.
//
// NodeCut used to jump straight from "the user asked for a film" to "write film.js". This inserts a planning step
// between them. The reference it routes to is docs/craft/ — NodeCut's own craft notes, written for this project. It is
// deliberately small (ten short files) so an agent reads three or four, not everything.
//
//   1. route(brief)  picks the film kind and the craft files that matter for it.
//   2. validate(plan) checks plan.json against the NodeCut contract before it is saved.
//   3. save(project, plan) writes plan.json, and refuses a plan the checker would refuse.
//
// The film still has to be a pure function of t. plan.json is what the agent reads when writing that function.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scorePlan, gate, checkVariation, MEDIA } from '../engine-hooks/vhrisk.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEAM_DIR = path.join(HERE, '..', 'docs', 'craft');

// ---- routing: "what am I making" -> "which files to read" ------------------------------------------------
// Two files are never optional: a film chooses a medium per beat, and it commits to a look before anything else.
const ALWAYS = ['mediums.md', 'taste.md'];

// Each entry: how to recognise the job, and the craft files worth reading for it. Almost every film also wants pacing.
const KINDS = [
  {
    id: 'cinematic',
    when: /trailer|brand film|cinematic|mood|atmosphere|dramatic|luxury|film noir|short film/i,
    craft: ['pacing.md', 'camera.md', 'sound.md'],
  },
  {
    id: 'explainer',
    when: /explainer|how .* works|tutorial|educational|teach|breakdown|walkthrough|intro to/i,
    craft: ['story.md', 'pacing.md', 'type.md'],
  },
  {
    id: 'screen-demo',
    when: /demo|product tour|screen|app\b|software|ui walkthrough|screencast/i,
    craft: ['camera.md', 'type.md', 'formats.md'],
  },
  {
    id: 'animation',
    when: /motion graphics|kinetic|logo sting|title|showreel|ident|typography/i,
    craft: ['type.md', 'pacing.md'],
  },
  {
    id: 'short-form',
    when: /tiktok|reel|vertical|9:16|instagram|social|story|shorts/i,
    craft: ['formats.md', 'pacing.md', 'type.md'],
  },
  {
    id: 'talking-head',
    when: /talking head|interview|presenter|to camera|vlog|testimonial/i,
    craft: ['camera.md', 'sound.md', 'pacing.md'],
  },
];

// anything with sound wants the sound notes, whatever kind of film it is
const SOUND = /music|voice|narrat|sound|audio|score|song/i;

// route(brief) -> { pipeline, read: [paths relative to docs/craft/], note }
export function route(brief) {
  const text = String(brief || '');
  const hit = KINDS.find((k) => k.when.test(text)) || KINDS[0];
  const craft = [...new Set([...ALWAYS, ...hit.craft, ...(SOUND.test(text) ? ['sound.md'] : [])])];
  // never hand back a file that is not actually there
  const present = craft.filter((f) => fs.existsSync(path.join(TEAM_DIR, f)));
  return {
    pipeline: hit.id,
    read: present,
    note: `Kind of film: ${hit.id}. Read these ${present.length} files, then write the beats.`,
  };
}

// ---- validation -------------------------------------------------------------------------------------------

const ID_RE = /^b\d+$/;

// validate(plan) -> { ok, errors, warnings }. A plan is beats with a medium and a reason, spanning the film.
export function validate(plan) {
  const errors = [];
  const warnings = [];
  const beats = (plan && Array.isArray(plan.beats)) ? plan.beats : [];
  if (!beats.length) return { ok: false, errors: ['The plan has no beats.'], warnings };

  let prevEnd = 0;
  beats.forEach((b, i) => {
    const at = `beat ${i + 1}${b.id ? ` (${b.id})` : ''}`;
    if (!b.id) errors.push(`${at}: no id (use b1, b2, …)`);
    else if (!ID_RE.test(b.id)) warnings.push(`${at}: id "${b.id}" is not of the form b1, b2, …`);
    if (!Number.isFinite(b.t0) || !Number.isFinite(b.t1)) errors.push(`${at}: t0 and t1 must be numbers`);
    else {
      if (b.t1 <= b.t0) errors.push(`${at}: t1 (${b.t1}) must be after t0 (${b.t0})`);
      if (Math.abs(b.t0 - prevEnd) > 0.05) warnings.push(`${at}: starts at ${b.t0.toFixed(2)}s but the previous beat ends at ${prevEnd.toFixed(2)}s (a gap or overlap)`);
      prevEnd = b.t1;
    }
    if (!MEDIA.includes(b.medium)) errors.push(`${at}: medium "${b.medium}" is not one of ${MEDIA.join(', ')}`);
    if (!b.name || !String(b.name).trim()) warnings.push(`${at}: no name (the timeline shows it)`);
    if (!b.why || !String(b.why).trim()) errors.push(`${at}: no "why" — one line saying what this beat is for`);
    if (!b.payoff || !String(b.payoff).trim()) warnings.push(`${at}: no payoff — what the viewer gets at the end of it`);
    if (b.medium !== 'none' && !b.description) warnings.push(`${at}: no description`);
  });
  if (Number.isFinite(prevEnd) && prevEnd > 0) {
    for (const k of ['duration', 'dur', 'length']) if (Number.isFinite(plan[k]) && Math.abs(plan[k] - prevEnd) > 0.1) {
      warnings.push(`The plan says ${plan[k]}s but its beats end at ${prevEnd.toFixed(2)}s`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ---- saving ------------------------------------------------------------------------------------------------

export const PLAN_FILE = 'plan.json';

function projectDir(projectId) {
  // the hub passes an absolute folder; callers without one get an error rather than a file in the wrong place
  if (!projectId) throw new Error('no project folder');
  return projectId;
}

// save(folder, plan, opts) -> { ok, score, file, reasons }
// The plan is NOT written when the checker refuses it, unless opts.force is set. A refused plan is the point: it is
// cheaper to fix a beat table than a rendered film.
export function save(folder, plan, opts = {}) {
  const v = validate(plan);
  if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings, written: false };
  const g = gate(plan, { maxAverage: opts.maxAverage ?? 4.0, renderer: opts.renderer || plan.renderer });
  if (!g.pass && !opts.force) {
    return { ok: false, errors: g.reasons, warnings: v.warnings, written: false, score: g.score, variation: g.variation };
  }
  const out = {
    version: 1,
    title: plan.title || '',
    renderer: opts.renderer || plan.renderer || null,
    taste_profile: plan.taste_profile || null,
    duration: plan.duration ?? (plan.beats.at(-1)?.t1 ?? 0),
    beats: plan.beats.map((b) => ({
      id: b.id, name: b.name || '', t0: b.t0, t1: b.t1, medium: b.medium,
      description: b.description || '', why: b.why, payoff: b.payoff || '',
      support: b.support || '', camera: b.camera || b.shot_language?.camera_movement || '',
      shot_language: b.shot_language || null, hero_moment: !!b.hero_moment,
    })),
    score: { average: g.score.average, verdict: g.score.verdict, dimensions: g.score.dimensions },
  };
  const dir = projectDir(folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PLAN_FILE), JSON.stringify(out, null, 2) + '\n');
  return { ok: true, written: true, file: path.join(dir, PLAN_FILE), score: g.score, warnings: v.warnings };
}

// read(folder) -> the saved plan, or null
export function read(folder) {
  const f = path.join(folder, PLAN_FILE);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

// summary(folder) -> the line an agent can act on: score, verdict, and the three worst problems with their fixes
export function summary(planOrFolder) {
  const plan = typeof planOrFolder === 'string' ? read(planOrFolder) : planOrFolder;
  if (!plan) return 'No plan.json yet.';
  const s = scorePlan(plan, { renderer: plan.renderer });
  const g = gate(plan, { renderer: plan.renderer });
  // The average is one number and the hard gates outrank it, so the verdict shown is the gate's, not the average's.
  // A plan that averages "strong" but repeats one medium must never be described as strong.
  const verdict = g.pass ? s.verdict : (s.verdict === 'strong' || s.verdict === 'acceptable' ? 'refused on a hard rule' : s.verdict);
  const lines = [
    `Plan: ${plan.beats.length} beats over ${plan.duration ?? plan.beats.at(-1)?.t1}s · risk ${s.average} (${verdict}) · ${g.pass ? 'ready to build' : 'REFUSED'}`,
  ];
  const media = plan.beats.map((b) => b.medium);
  lines.push(`Mediums: ${media.join(' → ')}`);
  // a dimension can score high for a GOOD reason ("no camera movement" is a valid choice); listing that under "worst"
  // sends the agent off to fix something that is fine, so only actionable dimensions appear here
  const actionable = s.problems.filter((p) => p.dimension !== 'weak_motion' || /no stated reason/.test(p.problem));
  if (actionable.length) {
    lines.push('Worst three:');
    for (const p of actionable) lines.push(`- ${p.problem} → ${p.fix}`);
  } else {
    lines.push('No blocking problems.');
  }
  const v = checkVariation(plan);
  if (!v.ok) lines.push(`Variation: ${v.issues.slice(0, 4).map((i) => i.detail).join('; ')}`);
  return lines.join('\n');
}
