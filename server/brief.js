// The brief: what a new film is for, written down before anything is built.
//
// A folder created without a brief is a folder somebody has to interrogate later. A folder with one can start. This
// module owns the text of the brief and of the routing that goes with it, so the API route stays thin and the whole
// thing can be tested without an HTTP server.
import fs from 'node:fs';
import path from 'node:path';
import { route } from './plan.js';

export const BRIEF_MAX = 4000;
export const BRIEF_MIN = 20;

// cleanBrief(raw) -> { ok, brief, error }. Trims, refuses empty, refuses something so short it cannot be a brief, and
// keeps the user's own words (no rewriting: it is their brief, not ours).
export function cleanBrief(raw) {
  const brief = String(raw == null ? '' : raw).trim();
  if (!brief) return { ok: false, brief: '', error: 'Describe what the film should be. The brief is what the film is built from.' };
  if (brief.length < BRIEF_MIN) return { ok: false, brief, error: `That is too short to build from (${brief.length} of ${BRIEF_MIN} characters). Say what it is, who watches it and how long it should be.` };
  if (brief.length > BRIEF_MAX) return { ok: false, brief, error: `That brief is very long (${brief.length} characters). Keep it under ${BRIEF_MAX}.` };
  return { ok: true, brief, error: '' };
}

// the folder name, exactly as it has always been made: no separators, nothing Windows or macOS refuse
export function folderName(raw) {
  return String(raw == null ? '' : raw)
    .normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80);
}

// briefMarkdown(name, brief, routed, stamp) -> the BRIEF.md text. Kept as a pure function so its shape can be asserted.
export function briefMarkdown(name, brief, routed, stamp) {
  return [
    `# ${name}`,
    '',
    `_${stamp}_`,
    '',
    '## What this film is',
    '',
    brief,
    '',
    '## Routed by the NodeCut team',
    '',
    `Pipeline: **${routed.pipeline}**`,
    '',
    'Read these team files (and only these):',
    '',
    ...routed.read.map(f => `- \`docs/craft/${f}\``),
    '',
    'Then fill in the beats and save them as `plan.json` (`hub_plan` does this). The film is built from the plan.',
    '',
  ].join('\n');
}

// writeBrief(dest, named, brief) -> { pipeline, files, at }. Writes BRIEF.md and plan/route.json into a folder that
// already exists. Throws on a write failure: the caller deletes the half-made folder.
export function writeBrief(dest, name, brief) {
  const routed = route(brief);
  const stamped = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const info = { pipeline: routed.pipeline, files: routed.read, at: stamped, brief };
  fs.writeFileSync(path.join(dest, 'BRIEF.md'), briefMarkdown(name, brief, routed, stamped));
  fs.mkdirSync(path.join(dest, 'plan'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'plan', 'route.json'), JSON.stringify({ pipeline: info.pipeline, files: info.files, at: info.at }, null, 2) + '\n');
  return info;
}

// readBrief(dest) -> { brief, pipeline, files } or null. The review page and hub_plan both read it from here, so the
// brief on disk is the only copy that matters.
export function readBrief(dest) {
  let raw = null;
  try { raw = fs.readFileSync(path.join(dest, 'BRIEF.md'), 'utf8'); } catch { return null; }
  let routeInfo = null;
  try { routeInfo = JSON.parse(fs.readFileSync(path.join(dest, 'plan', 'route.json'), 'utf8')); } catch { }
  // the brief is everything under "## What this film is" up to the next "## "
  const m = raw.match(/## What this film is\n\n([\s\S]*?)\n\n## /);
  return {
    brief: (m ? m[1] : raw).trim(),
    pipeline: routeInfo?.pipeline || null,
    files: Array.isArray(routeInfo?.files) ? routeInfo.files : [],
    at: routeInfo?.at || null,
  };
}
