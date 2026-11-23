// The tools agents use (through mcp.js, or `node server/cli.js <tool> '<json>'` without MCP).
// They talk to the hub over http://127.0.0.1:7788 and start it when it is not running.
// Status inputs accept the English values and, as aliases, the Turkish words older versions used.
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { HUB_DIR, DATA_DIR, readJson } from './util.js';
import { NOTE_STATUSES, NOTE_STATUS_ALIASES, PROJECT_STATUSES, PROJECT_STATUS_ALIASES, noteStatus, projectStatus, isOpenNote, normalizeNote } from '../ui/values.js';
import * as planning from './plan.js';
import { readBrief } from './brief.js';

// renders and versions made through these tools are labelled "Claude"; the tools never look at which chat called them
const BY_AGENT = { title: (readJson(path.join(DATA_DIR, 'config.json'), {}) || {}).agentName || 'Claude' };
const PORT = +process.env.NODECUT_PORT || (readJson(path.join(DATA_DIR, 'config.json'), {}) || {}).port || 7788;   // env: talk to a test hub
const BASE = `http://127.0.0.1:${PORT}`;

async function ping() { try { const r = await fetch(BASE + '/api/ping', { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } }
async function ensureHub() {
  if (await ping()) return;
  const child = spawn(process.execPath, [path.join(HUB_DIR, 'server', 'hub.js')], { cwd: HUB_DIR, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 500)); if (await ping()) return; }
  throw new Error('Could not start the NodeCut server (' + BASE + ').');
}
async function call(method, p, body, timeoutMs = 120e3) {
  await ensureHub();
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

const TC = s => { const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r.toFixed(2).padStart(5, '0')}`; };
const GB = b => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB';
async function resolve(projectArg) {
  const q = projectArg || process.cwd();
  const p = await call('GET', '/api/find?q=' + encodeURIComponent(q));
  if (Array.isArray(p.notes)) p.notes.forEach(normalizeNote);
  return p;
}
const FAM = { A: 'chunked (partial re-renders available)', B: 'worker parts', C: 'segments', studio: '3D studio scene', otomasyon: 'text-to-video pipeline', snipp: 'Snipp', media: 'video folder', code: 'code (no chunked render script)', other: 'other' };
const isOpen = n => isOpenNote({ status: noteStatus(n.status) });

export const TOOLS = {
  hub_live: {
    description: 'Open the film in NodeCut\'s live preview WITHOUT RENDERING: it plays straight from its code, the user watches and leaves notes, and the preview reloads itself when the code changes. Call this as soon as a new film (or a big change) plays, BEFORE any render; then stop and wait for the user\'s notes. Render only when the user asks. If the page lacks window.renderOut(t) + window.READY, it says why.',
    schema: {
      project: z.string().optional().describe('Project folder, name or id. Default: the working folder.'),
      open: z.boolean().optional().describe('false = only check, do not open a window'),
    },
    run: async a => {
      const p = await resolve(a.project);
      const li = await call('GET', `/api/project/${p.id}/live`);   // also starts watching the code for changes
      if (!li.ok) return `The live preview could not open: ${li.reason}\nWhat it needs (docs/PROJECT-CONTRACT.md): the page defines window.renderOut(t), which draws second t synchronously on fixed-size canvases, and sets window.READY = true when ready; the sound in audio/mix.wav. Anything different goes in .nodecut/project.json → live: {page, audio, dur, fps}.`;
      let how = 'none';
      if (a.open !== false) how = (await call('POST', '/api/show', { hash: `#/review/${p.id}/~live` })).how;
      return [
        `Live preview ready: "${p.title}" · ${li.page} · ${li.fps} fps · ${TC(li.dur)} (length from: ${li.durFrom}) · sound: ${li.audioName || 'none'}`,
        how === 'window' ? 'The open NodeCut window switched to this film.' : how === 'opened' ? 'A NodeCut window opened.' : '',
        'Now STOP, do not render. Tell the user (in their language): watch it in NodeCut, leave notes on the frames, then press "Send to agent" and paste the message here. Get the notes with hub_notes, fix the code (the preview reloads itself), mark each with hub_note_update. Render with hub_render only when the user asks for a render.',
        li.durFrom === 'default' ? 'The film length is unknown (60 s assumed): save it with hub_project({set:{render:{env:{DUR:"…"}}}}).' : '',
      ].filter(Boolean).join('\n');
    },
  },
  hub_contact_sheet: {
    description: 'SEE the edit without rendering: draws N frames of the film into one labelled grid PNG (a contact sheet) with a timecode under each frame, so you can judge pacing, composition, contrast and whether the film is actually changing between moments. Works on any live-capable project, including `code` films with no render script. Look at the file it returns (Read the PNG), critique it, fix the code, and take another sheet. Use it before rendering, and again after a fix.',
    schema: {
      project: z.string().optional().describe('Project folder, name or id. Default: the working folder.'),
      count: z.number().optional().describe('How many frames to sample evenly across the film (default 12, max 48).'),
      at: z.array(z.number()).optional().describe('Exact moments in seconds instead of even sampling (max 48), for checking one beat.'),
      cols: z.number().optional().describe('Columns in the grid (default 4, max 8).'),
      cellW: z.number().optional().describe('Width of one frame in the PNG, in pixels (default 480, max 960).'),
    },
    run: async a => {
      const p = await resolve(a.project);
      const r = await call('POST', '/api/contactsheet', { id: p.id, count: a.count, times: a.at, cols: a.cols, cellW: a.cellW }, 240e3);
      if (!r.ok) return `The contact sheet failed: ${r.error}`;
      const tooLong = r.durFrom === 'default' ? '\nThe film length is unknown (60 s assumed), so the sampling is a guess: save it with hub_project({set:{render:{env:{DUR:"…"}}}}) and take the sheet again.' : '';
      return [
        `Contact sheet: ${r.w}×${r.h}, ${r.cols}×${r.rows} frames of ${r.srcW}×${r.srcH}, sampled at ${r.times.map(t => TC(t)).join(', ')}`,
        `File: ${r.file}`,
        `In NodeCut: http://127.0.0.1:${PORT}${r.url}`,
        r.errors?.length ? `renderOut(t) threw at: ${r.errors.slice(0, 5).join(' · ')}` : '',
        r.frozen ? 'WARNING: every sampled frame is identical — the film does not change between these moments. Sample more frames (count: 24) or check that renderOut(t) reads t.' : '',
        r.pageErrors?.length ? `Page errors: ${r.pageErrors.join(' · ')}` : '',
        'Read the PNG now and critique it against the brief: does every frame say what it should, does the picture change between samples, is anything off-frame, muddy, or frozen? Fix the code, then take another sheet.',
      ].filter(Boolean).join('\n') + tooLong;
    },
  },
  hub_gen_import: {
    description: 'Bring a picture or a clip INTO a film as generated media, without any API: it is copied into the film\'s gen/ folder, recorded in gen/gen.json, and a clip is baked into frame atlases the film can draw with engine-hooks/vhatlas.js. Use it to add a still you already have, or to make a model-made clip drawable. Nothing already in the film is touched.',
    schema: {
      project: z.string().optional().describe('Project folder, name or id. Default: the working folder.'),
      file: z.string().describe('Absolute path of a PNG/JPEG/WEBP still or an MP4/MOV/WEBM clip to add.'),
      name: z.string().optional().describe('A short name for it (default: the file name).'),
      prompt: z.string().optional().describe('What it is or the prompt that made it, kept with the asset for later.'),
    },
    run: async a => {
      const p = await resolve(a.project);
      const r = await call('POST', `/api/gen/${p.id}/import`, { file: a.file, name: a.name, prompt: a.prompt }, 300e3);
      const at = r.atlasInfo;
      return [
        `Added ${r.kind} ${r.id} to "${p.title}": ${r.file}`,
        at ? `Baked: ${at.total} frames (${at.fps} fps, ${at.cellW}×${at.cellH} cells, ${at.pages} sheet${at.pages > 1 ? 's' : ''}, ${(at.bytes / 1048576).toFixed(1)} MB)` : '',
        r.bakeError ? `NOT BAKED: ${r.bakeError}` : '',
        `Draw it in film.js with engine-hooks/vhatlas.js: at READY \`const GEN = await VIHATLAS.load('./gen/atlas')\`, then \`${r.kind === 'clip' ? `GEN.get('${r.id}').draw(g, t - <its start>, x, y, w, h)` : `GEN.get('${r.id}').draw(g, 0, x, y, w, h)`}\` — a pure function of t.`,
      ].filter(Boolean).join('\n');
    },
  },
  hub_generate_plate: {
    description: 'Make a still with a text-to-image model (DeepInfra FLUX) and store it in the film\'s gen/ folder. It costs money: the tool refuses unless generation is switched on in Settings > Generation and today\'s spend is under the cap. Use it for a background plate, a character still, or the starting frame of a clip.',
    schema: {
      project: z.string().optional().describe('Project folder, name or id. Default: the working folder.'),
      prompt: z.string().describe('What the still shows. Be specific: subject, light, lens, mood.'),
      size: z.string().optional().describe('WIDTHxHEIGHT, default 1024x1024. A 1920x1080 film wants 16:9 or the film will crop it.'),
    },
    run: async a => {
      const p = await resolve(a.project);
      const cfg = await call('GET', '/api/gen/config');
      if (!cfg.enabled) return 'Generation is off. Ask the user to switch it on in NodeCut > Settings > Generation (it spends money, so the tool will not do it for them).';
      const r = await call('POST', `/api/gen/${p.id}/plate`, { prompt: a.prompt, size: a.size }, 240e3);
      return `Made still ${r.id} in "${p.title}": ${r.file}\nPrompt: "${r.prompt}"\nDraw it in film.js with vhatlas.js (a plate is one cell): GEN.get('${r.id}').draw(g, 0, x, y, w, h), or animate it with hub_generate_clip.`;
    },
  },
  hub_generate_audio: {
    description: 'Make audio for the film with ElevenLabs: a voice-over line, a music bed, or a sound effect. Needs only the ElevenLabs key in Settings > Generation — it does NOT need generation switched on, because audio is not the image/clip pipeline and has its own key. The file lands in the film\'s audio/ folder (and a WAV copy beside it for mixing).',
    schema: {
      project: z.string().optional().describe('Project folder, name or id. Default: the working folder.'),
      kind: z.enum(['voiceover', 'music', 'sfx']).describe('voiceover = spoken text on a chosen voice; music = a described music bed; sfx = one described sound.'),
      text: z.string().optional().describe('For voiceover: the words to speak. For music and sfx: what it should sound like.'),
      voiceId: z.string().optional().describe('For voiceover: an id from hub_voices. Ask the user which voice instead of guessing.'),
      name: z.string().optional().describe('File name without extension. Keep it descriptive (vo_line_03, bed, door_close).'),
      lengthMs: z.number().optional().describe('For music: how long, in milliseconds. Default 30000. The film\'s own length is the right answer.'),
      durationSec: z.number().optional().describe('For sfx: roughly how long, in seconds.'),
    },
    run: async a => {
      const p = await resolve(a.project);
      const st = await call('GET', `/api/project/${p.id}/audio`);
      if (!st.hasKey) return 'No ElevenLabs key is saved. Ask the user to add one in NodeCut > Settings > Generation (ElevenLabs key). Do not ask them for the key itself.';
      if (a.kind === 'voiceover' && !a.voiceId) return 'A voiceover needs a voiceId. Run hub_voices to see what the account has, then ask the user which one before generating.';
      const body = { name: a.name, text: a.text || a.prompt, lengthMs: a.lengthMs, durationSec: a.durationSec };
      if (a.kind === 'voiceover') body.voiceId = a.voiceId;
      const r = await call('POST', `/api/project/${p.id}/audio/${a.kind}`, body, 240e3);
      return `Made ${a.kind} in "${p.title}": ${r.rel}${r.wav ? ' (WAV: ' + r.wav + ')' : ''}\nPut it in the film\'s mix — the bed and voice are combined by the film\'s own audio script, so add it there rather than drawing it.`;
    },
  },
  hub_voices: {
    description: 'List the ElevenLabs voices the saved key can use. Run this before a voice-over and ask the user which voice they want; do not pick one silently.',
    schema: {},
    run: async () => {
      const r = await call('GET', '/api/audio/voices');
      if (!r.hasKey) return 'No ElevenLabs key is saved. Ask the user to add one in NodeCut > Settings > Generation.';
      if (r.error) return 'Could not list voices: ' + r.error;
      if (!r.voices.length) return 'The account has no voices.';
      return r.voices.map(v => `${v.id} · ${v.name}${v.category ? ' · ' + v.category : ''}`).join('\n');
    },
  },
  hub_generate_clip: {
    description: 'Make a video clip and bake it into atlases the film can draw. Give plateId to animate an existing still (image-to-video); leave it out and describe the whole shot to generate it from text alone (text-to-video). Costs money per second and the price is shown before it submits. image-to-video is the normal way to make a moving beat: generate the still first with hub_generate_still, then animate it, because you can see and pose the picture before spending money on motion. text-to-video has no picture to match, so a second text_to_video clip will not continue the first one — for a multi-shot idea, animate plates instead. The job runs for minutes, so this returns immediately with an asset id; the clip lands in gen/ when it finishes.',
    schema: {
      project: z.string().optional().describe('Project folder, name or id. Default: the working folder.'),
      plateId: z.string().optional().describe('The still to animate (image-to-video). Leave it out for text-to-video. Use the id hub_generate_still returned.'),
      prompt: z.string().describe('The motion, for image-to-video: which way the camera pushes, what changes, what the light does. Do NOT re-describe the picture — the plate already is the picture, and describing it again fights the model. For text-to-video: the whole shot, since there is no still to look at — subject, action, camera, light, mood.'),
      duration: z.number().optional().describe('Seconds (default from Settings, usually 5).'),
      resolution: z.string().optional().describe('480p (default, cheapest), 768p, 1080p, 2K. Price scales with it.'),
      aspect: z.string().optional().describe('16:9 for a landscape film, 9:16 for vertical.'),
      model: z.string().optional().describe('An OpenRouter video model id. Default heygen/heygen-video-1.'),
    },
    run: async a => {
      const p = await resolve(a.project);
      const cfg = await call('GET', '/api/gen/config');
      if (!cfg.enabled) return 'Generation is off. Ask the user to switch it on in NodeCut > Settings > Generation.';
      // No still means text-to-video, and that goes to DeepInfra's cheap model rather than the OpenRouter queue: about two
      // cents for five seconds and back in a few seconds, so a shot can be tried and thrown away. A still means the
      // existing image-to-video path, which is the only one that can animate a specific picture.
      if (!a.plateId) {
        const t = await call('POST', `/api/gen/${p.id}/t2v`, { prompt: a.prompt, resolution: a.resolution, orientation: /9:16/.test(a.aspect || '') ? 'portrait' : 'landscape' }, 300e3);
        return [
          `Made a clip from text for "${p.title}": asset ${t.id}, 5s at ${t.resolution}, $${(+t.cost || 0).toFixed(4)}.`,
          `It is on disk now (${t.file}) and drawn like any other clip — GEN.get('${t.id}') in film.js.`,
          'It is a five-second shot; if the beat is longer, split it across more than one clip rather than stretching one.',
          `For the next beat of the same idea, animate a plate instead: hub_generate_still to make the still (or reuse this clip's last frame), then hub_generate_clip with its id. Two text_to_video clips share nothing — different subject, different light — and that reads as a montage, not a sequence.`,
        ].join('\n');
      }
      const r = await call('POST', `/api/gen/${p.id}/clip`, { plateId: a.plateId, prompt: a.prompt, duration: a.duration, resolution: a.resolution, aspect: a.aspect, model: a.model }, 180e3);
      const how = a.plateId ? 'animating still ' + a.plateId : 'from text (no starting still)';
      return [
        `Submitted clip job ${r.jobId} for "${p.title}" — ${how}, ${r.model}, ${r.duration}s at ${r.resolution}, $${(+r.cost || 0).toFixed(2)}.`,
        `It runs for minutes on OpenRouter. Asset id ${r.id}; it lands in gen/clips/ and gen/atlas/ when it finishes (hub_gen_list shows the state).`,
        'Do not wait for it in this conversation: check hub_gen_list later, or keep working on the rest of the film.',
      ].join('\n');
    },
  },
  hub_gen_list: {
    description: 'What generated media a film has: id, kind, size on disk, whether its atlas is baked, and the prompt it was made from. Call it before generating more, so the same shot is not made twice.',
    schema: { project: z.string().optional().describe('Project folder, name or id. Default: the working folder.') },
    run: async a => {
      const p = await resolve(a.project);
      const r = await call('GET', `/api/gen/${p.id}`);
      if (!r.assets.length) return `"${p.title}" has no generated media yet (gen/ is empty).`;
      return [
        `Generated media in "${p.title}" (${(r.bytes / 1048576).toFixed(1)} MB of atlases):`,
        ...r.assets.map(x => `- ${x.id} · ${x.kind}${x.atlasInfo ? ` · ${x.atlasInfo.total} frames @ ${x.atlasInfo.fps} fps` : ''} · ${x.state}${x.name ? ' · ' + x.name : ''}${x.prompt ? '\n    "' + x.prompt.slice(0, 160) + '"' : ''}`),
      ].join('\n');
    },
  },
  hub_plan: {
    description: 'THE PLANNING STAGE — call this before writing film.js on any new film, and before rebuilding an existing one. NodeCut ships a small craft reference (docs/craft/: ten short notes on pacing, mediums, type, sound, camera, story and review). This tool does three things: (1) with only a brief it says which kind of film this is and WHICH FEW craft files to read — never read the whole folder; (2) with a plan, it validates it, scores it for slideshow risk, AND PRICES any generated video in it, so the person sees the cost before a single clip is made; (3) it saves plan.json into the project, which is what film.js is then built from. A plan must give every beat a MEDIUM (kinetic_type, diagram, image_to_video, text_to_video, motion_graphics, footage, chart) and one line of WHY. A film that puts the same medium on every beat is refused — that is the single clearest tell of an AI-generated video. TWO HARD RULES ABOUT STILLS: a film 12 s or longer where every picture beat is a still (footage) is refused — pick one beat and more and make them move, image_to_video when you already have the still and text_to_video when you do not, because a still that was already on screen is the cheapest beat in the film to animate; and more than three generated clips, or more than half the beats, is refused as a montage. Workflow: hub_plan({brief}) -> read the files it names -> hub_plan({plan}) -> fix what it flags -> build film.js from the saved plan.',
    schema: {
      project: z.string().optional().describe('Project folder, name or id. Default: the working folder.'),
      brief: z.string().optional().describe('What the film is: "a 20s luxury brand film for a seasoning", "an explainer about wifi", "vertical reels for instagram". Used to pick the pipeline and the team files to read.'),
      plan: z.object({
        title: z.string().optional(),
        duration: z.number().optional().describe('Length in seconds. Should match the last beat\'s t1.'),
        renderer: z.string().optional().describe('"cinematic", "explainer", … — only used to check cinematic claims.'),
        beats: z.array(z.object({
          id: z.string().describe('b1, b2, …'),
          name: z.string().optional().describe('Short name the timeline shows.'),
          t0: z.number().describe('Start in seconds.'),
          t1: z.number().describe('End in seconds.'),
          medium: z.enum(['kinetic_type', 'diagram', 'image_to_video', 'text_to_video', 'motion_graphics', 'footage', 'chart', 'none']).describe('How this beat is BUILT. Vary it: three beats in a row on one medium reads as a slideshow. Use text_to_video or image_to_video when the beat needs REAL MOTION that cannot be drawn or typed — a place, a person, food, weather, a hand doing something. These two cost money per clip, so they are for beats that earn it, never as a filler background.'),
          description: z.string().optional().describe('What is on screen.'),
          why: z.string().describe('One line: what this beat is FOR. Required — a beat with no reason is decoration.'),
          payoff: z.string().optional().describe('What the viewer gets at the end of it.'),
          support: z.string().optional().describe('A secondary element that keeps the beat from being flat (a rule, a counter, a second layer).'),
          camera: z.string().optional().describe('Camera intent in one line: "slow push, deep focus".'),
          hero_moment: z.boolean().optional(),
        })).optional().describe('The beat table. Omit to get routing only.'),
      }).optional(),
      save: z.boolean().optional().describe('Write plan.json into the project (default true when a plan is given and it passes).'),
      force: z.boolean().optional().describe('Save even if the checker refuses it. The score is saved with it either way.'),
    },
    run: async a => {
      // 1. routing only
      if (!a.plan) {
        // The brief lives in the project (BRIEF.md, written by the New film dialog), so an agent working on an existing
        // folder never has to ask the user to retype it.
        let brief = a.brief, fromDisk = false;
        if (!brief) {
          try { const p0 = await resolve(a.project); const b = readBrief(p0.path); if (b?.brief) { brief = b.brief; fromDisk = true; } } catch { }
        }
        if (!brief) return 'Give me a brief ("a 20s luxury brand film for a seasoning") — I will say which pipeline fits and which team files to read. Or pass a plan to score it. If this project has a BRIEF.md, call hub_plan({project}) and I will read it from the folder.';
        const r = planning.route(brief);
        const teamDir = planning.TEAM_DIR;
        return [
          `Brief: "${brief}"${fromDisk ? '  (read from this project\'s BRIEF.md)' : ''}`,
          `Pipeline: ${r.pipeline}`,
          r.note,
          '',
          'Read these craft notes (and only these):',
          ...r.read.map(f => `- ${path.join(teamDir, f)}`),
          '',
          'Then write the beat table and pass it back as `plan`. Rules:',
          '- every beat has a medium and one line of why;',
          '- DO NOT put three beats in a row on the same medium — kinetic type, a diagram, motion graphics, a chart and footage all count as different;',
          '- a text beat shorter than 1.2 s cannot be read;',
          '- plan.json is what film.js is built from, so the plan is the film.',
        ].join('\n');
      }

      // 2. plan given: validate, score, optionally save
      const p = a.save === false ? null : await resolve(a.project);
      const v = planning.validate(a.plan);
      if (!v.ok) {
        return [`The plan is not valid yet — ${v.errors.length} error${v.errors.length === 1 ? '' : 's'}:`, ...v.errors.map(e => `- ${e}`),
          v.warnings.length ? `\nAlso worth fixing:\n${v.warnings.slice(0, 6).map(w => '- ' + w).join('\n')}` : ''].filter(Boolean).join('\n');
      }
      const wantSave = a.save !== false && !!p;
      if (!wantSave) {
        // score only, nothing written
        const summary = planning.summary({ beats: a.plan.beats, duration: a.plan.duration, renderer: a.plan.renderer });
        return summary + (v.warnings.length ? `\n\nWarnings:\n${v.warnings.map(w => '- ' + w).join('\n')}` : '');
      }
      const r = planning.save(p.path, a.plan, { force: a.force, renderer: a.plan.renderer });
      if (!r.ok) {
        return [`REFUSED — the plan was not saved, and that is the point: fixing a beat table costs minutes, fixing a rendered film costs a day.`, ...r.errors.map(e => `- ${e}`), '', planning.summary({ ...a.plan, beats: a.plan.beats })].join('\n');
      }
      return [
        `Saved: ${r.file}`,
        planning.summary(r.file),
        '',
        'Build film.js from this plan: one function per beat, the medium it names, the payoff it promises. Then hub_live and let the user watch it — do NOT render.',
      ].join('\n');
    },
  },
  hub_workspace: {
    description: 'Where this PC keeps its video work: the workspace folder and, inside it, the films folder (make every new film there, one folder per film), the outputs folder (finished renders are collected there by NodeCut; never write there yourself) and the other watched folders. Call it before creating a new film.',
    schema: {},
    run: async () => {
      const c = await call('GET', '/api/config');
      const roots = (c.roots || []).filter(r => r.enabled !== false);
      const films = (roots.find(r => r.type === 'container') || {}).path;
      return [
        `Workspace: ${c.workspace}`,
        films ? `New films go in: ${films}\\<film-name>  (one folder per film; copy templates\\new-film from the NodeCut folder)` : 'No films folder is set: ask the user to add one in NodeCut > Settings > Folders.',
        `Finished renders are collected in: ${c.outputsDir}  (NodeCut links every render there by day; do not write there)`,
        `Sounds: ${c.soundLibDir}  ·  Archive: ${c.archiveDir}`,
        roots.length > 1 ? 'Other watched folders: ' + roots.filter(r => r.path !== films).map(r => `${r.path} (${r.type})`).join(', ') : '',
        'Keep each film self-contained in its own folder (code, audio, render/); never put one film\'s files into another film\'s folder.',
      ].filter(Boolean).join('\n');
    },
  },
  hub_project: {
    description: 'Find this project in NodeCut (project folder, name or id). Gives its status, versions, open notes and render recipe (DUR, chunk length). `set` saves title / status / render recipe; render.mux is an ffmpeg argument array with {video} and {out} placeholders.',
    schema: {
      project: z.string().optional().describe('Project folder, name or id. Default: the working folder.'),
      set: z.object({ title: z.string().optional(), status: z.enum([...PROJECT_STATUSES, ...PROJECT_STATUS_ALIASES]).optional().describe('in-progress | review | revision | approved | published | archived | done'), render: z.object({ script: z.string().optional(), workers: z.number().optional(), env: z.record(z.string(), z.string()).optional(), mux: z.array(z.string()).optional() }).optional() }).optional(),
    },
    run: async a => {
      let p = await resolve(a.project);
      if (a.set) { const set = { ...a.set }; if (set.status) set.status = projectStatus(set.status); await call('POST', `/api/project/${p.id}/meta`, set); p = await resolve(p.id); }
      const rc = await call('GET', `/api/project/${p.id}/recipe`).catch(() => null);
      const vs = (p.versionsLog || []).slice(-5);
      const open = (p.notes || []).filter(isOpen);
      return [
        `Project: ${p.title} (id ${p.id})  ·  ${p.path}`,
        `Kind: ${FAM[p.family] || p.family}  ·  status: ${projectStatus(p.status)}${p.statusAuto ? ' (automatic)' : ''}`,
        rc ? `Render: ${rc.script || 'make.mjs'}, ${rc.fps} fps${rc.chunkSec ? `, ${rc.chunkSec} s chunks (${rc.chunks ?? '?'} chunks)` : ''}${rc.env?.DUR ? `, DUR=${rc.env.DUR}${rc.durInferred ? ' (worked out from the chunks)' : ''}` : ''}${rc.mux ? ', own sound recipe (render.mux)' : ', sound: the previous final\'s track, else the film\'s own audio file'}` : '',
        `Latest video: ${p.latest || '—'}  ·  folder ${GB(p.sizes?.total || 0)}`,
        vs.length ? 'Latest versions: ' + vs.map(v => `v${v.v} ${v.file}${v.changedRanges ? ` (changed: ${v.changedRanges.map(([x, y]) => TC(x) + '–' + TC(y)).join(', ')})` : ''}`).join(' | ') : '',
        `Notes: ${open.length} open / ${(p.notes || []).length} total${open.length ? ' → get them with hub_notes' : ''}`,
      ].filter(Boolean).join('\n');
    },
  },

  hub_notes: {
    description: 'The notes the user left on frames in NodeCut\'s review: time, frame, the render chunks it touches, text, and the paths of the annotated pictures. Open the pictures with Read (the crop first, the annotated frame if needed). Default: open + reopened notes; they are marked "claude" (taken).',
    schema: {
      project: z.string().optional(),
      status: z.enum(['all', ...NOTE_STATUSES, ...NOTE_STATUS_ALIASES]).optional().describe('open = open + reopened (default)'),
      take: z.boolean().optional().describe('Mark the returned open notes "claude" (default true)'),
    },
    run: async a => {
      const p = await resolve(a.project);
      const st = a.status ? (a.status === 'all' ? 'all' : noteStatus(a.status)) : 'open';
      const notes = (p.notes || []).filter(n => st === 'all' || (st === 'open' ? isOpen(n) : n.status === st)).sort((x, y) => x.t - y.t);
      if (!notes.length) return `No ${st === 'open' ? 'open ' : ''}notes on "${p.title}".`;
      if (a.take !== false) for (const n of notes) if (isOpen(n)) await call('POST', `/api/project/${p.id}/note/${n.id}`, { status: 'claude', by: 'claude' });
      const lines = [`"${p.title}" (${p.path}) — ${notes.length} note${notes.length === 1 ? '' : 's'}:`];
      for (const n of notes) {
        const fr = n.frames || (n.t2 != null && n.fps ? [Math.floor(n.t * n.fps + 1e-6), Math.floor(n.t2 * n.fps + 1e-6)] : null);
        lines.push(`#${n.id} [${n.status === 'reopened' ? 'STILL THERE (the previous fix did not work)' : n.status}] ${TC(n.t)}${n.t2 != null ? '–' + TC(n.t2) : ''}  ${fr ? `RANGE frames ${fr[0]}–${fr[1]}${n.frame != null && n.frame !== fr[0] ? ` (drawing on frame ${n.frame})` : ''}` : `frame ${n.frame ?? '?'}`}${n.chunks ? `  chunks ${n.chunks.join(',')}` : ''}  ${n.kind}${n.layer ? '  layer: ' + n.layer : ''}  ${n.file === '~live' ? 'LIVE PREVIEW (no render — fix the code, do not render)' : 'file: ' + (n.file || '?')}`);
        if (n.text) lines.push(`   "${n.text}"`);
        if (n.say) lines.push(`   narration at that moment: «${n.say}»`);
        if (n.images?.crop) lines.push(`   close-up: ${n.images.crop}`);
        if (n.images?.annotated) lines.push(`   full frame + drawing: ${n.images.annotated}`);
        if (n.images?.start) lines.push(`   first frame of the range: ${n.images.start}`);
        if (n.images?.end) lines.push(`   last frame of the range: ${n.images.end}`);
        if (n.reply) lines.push(`   your previous reply: ${n.reply}`);
      }
      const liveN = notes.filter(n => n.file === '~live').length;
      if (liveN) lines.push('', `LIVE PREVIEW notes (${liveN}): fix the code, do NOT render — the user's open preview reloads itself when the code changes and shows the fix at once. Then for each note hub_note_update(status:"fixed", reply:"what you did, 1 sentence"). The user asks for the render at the end.`);
      if (liveN < notes.length) lines.push('', 'Notes on a rendered video: after fixing, mark each with hub_note_update(status:"fixed", reply:"what you did, 1 sentence"). Render only when the user asks; then hub_render({mode:"partial", notes:[...]}) re-renders just those chunks. Do not re-review the whole film yourself — the user checks the changed ranges in NodeCut.');
      return lines.join('\n');
    },
  },

  hub_note_update: {
    description: 'Save a note\'s status and a short reply (the user sees it in NodeCut). After fixing: status "fixed" + reply.',
    schema: { project: z.string().optional(), id: z.number(), status: z.enum(['claude', 'fixed', 'open', ...NOTE_STATUS_ALIASES]).optional(), reply: z.string().optional() },
    run: async a => { const p = await resolve(a.project); const n = await call('POST', `/api/project/${p.id}/note/${a.id}`, { status: a.status ? noteStatus(a.status) : undefined, reply: a.reply, by: 'claude' }); return `#${n.id} → ${n.status}${n.reply ? ' · ' + n.reply : ''}`; },
  },

  hub_render: {
    description: 'Put a render in NodeCut\'s queue (one render at a time on this computer; CPU/RAM protection on when the agent is installed). Only when the user asked for a render. mode "partial": only the chunks the notes/seconds/chunks touch are rendered again, the film is joined, the previous final\'s sound is put back, and a new version (…_vN.mp4) is saved with the changed ranges. "full": the whole film. "preview": PREVIEW=1 (projects that support it). "command": your own command (cmd) + output file; the user has to approve it in NodeCut before it runs. wait=true waits until it ends (at most ~9 min). Options: workers (parallel workers / Chrome copies for 3D), env.FPS (if the script reads FPS, full only), env.CODEC (3D: x264|nvenc|amf); what a project supports: GET /api/project/<id>/render-options.',
    schema: {
      project: z.string().optional(),
      mode: z.enum(['partial', 'full', 'preview', 'command']).optional(),
      notes: z.array(z.number()).optional().describe('Note numbers (partial)'),
      seconds: z.array(z.tuple([z.number(), z.number()])).optional().describe('[[start,end]] in seconds (partial)'),
      chunks: z.array(z.number()).optional().describe('Chunk numbers (partial)'),
      env: z.record(z.string(), z.string()).optional(),
      copyTo: z.string().optional().describe('Also copy the result into this folder when done (full path); the original stays in the project'),
      workers: z.number().optional(),
      cmd: z.string().optional().describe('mode command: the command line (runs in the project folder)'),
      output: z.string().optional().describe('mode command: the video it makes (relative to the project folder)'),
      note: z.string().optional().describe('Version description'),
      wait: z.boolean().optional(),
    },
    run: async a => {
      const p = await resolve(a.project);
      const j = await call('POST', '/api/jobs', { project: p.id, mode: a.mode || 'partial', notes: a.notes, seconds: a.seconds, chunks: a.chunks, env: a.env, workers: a.workers, cmd: a.cmd, output: a.output, note: a.note, copyTo: a.copyTo, session: BY_AGENT });
      const head = `Job ${j.id} queued (position ${j.position}) · ${j.mode}${j.chunks ? ` · ${j.chunks.length} chunk${j.chunks.length === 1 ? '' : 's'} (${j.chunks.join(',')}) = ${j.changedRanges.map(([x, y]) => TC(x) + '–' + TC(y)).join(', ')}` : ''}` +
        (j.ramNote ? `\n${j.ramNote} → Tell the user this in one sentence; never close the program yourself.` : '');
      if (j.needsApproval) return head + '\nThis is a custom command, so it does NOT run until the user approves it in NodeCut (Renders page: it shows the command with Approve / Cancel). Tell the user that now, in one sentence, then check with hub_job({id:"' + j.id + '", wait:true}).';
      if (!a.wait) return head + '\nWait with hub_job({id:"' + j.id + '", wait:true}).';
      return head + '\n' + await TOOLS.hub_job.run({ id: j.id, wait: true });
    },
  },

  hub_job: {
    description: 'The state of a render job. wait=true waits until it ends (at most ~9 min); call again if it has not ended.',
    schema: { id: z.string(), wait: z.boolean().optional() },
    run: async a => {
      const j = await call('GET', `/api/jobs/${a.id}` + (a.wait ? '?wait=540' : ''), null, 600e3);
      const parts = [`Job ${j.id}: ${j.state}${j.state === 'running' ? ` ${Math.round((j.progress || 0) * 100)}%` : ''}${j.state === 'queued' && j.waiting ? ` (waiting: ${j.waiting})` : ''}`];
      if (j.output) parts.push(`Output: ${j.output} (v${j.version})${j.changedRanges ? ` · changed: ${j.changedRanges.map(([x, y]) => TC(x) + '–' + TC(y)).join(', ')}` : ''}${j.durationSec ? ` · took ${j.durationSec} s` : ''}`);
      if (j.ramNote && j.state !== 'done') parts.push(j.ramNote);
      if (j.error) parts.push('Error: ' + j.error);
      if (j.log) parts.push('Log: ' + j.log);
      if (j.state === 'done') parts.push('The user checks the new version in NodeCut with "Watch only the changes"; do not re-review the whole film.');
      if (j.state === 'done' && j.outputPath) parts.push(`Full path: ${j.outputPath}${j.copiedTo ? ` (copy: ${j.copiedTo})` : ''}${j.linkedTo ? `\nIn the outputs folder: ${j.linkedTo}` : ''}\nIt is listed in NodeCut > Renders > "Recent renders" (▶ Watch / 📂 Show in folder); no need to show the video in the chat, the path is enough.`);
      return parts.join('\n');
    },
  },

  hub_register_version: {
    description: 'Register a video made outside NodeCut\'s queue as this project\'s new version (with the seconds that changed).',
    schema: { project: z.string().optional(), file: z.string(), note: z.string().optional(), changedRanges: z.array(z.tuple([z.number(), z.number()])).optional(), notes: z.array(z.number()).optional(), kind: z.enum(['final', 'preview']).optional() },
    run: async a => { const p = await resolve(a.project); const r = await call('POST', `/api/project/${p.id}/version`, { ...a, session: BY_AGENT }); return `Registered: v${r.v} ${r.file}`; },
  },

  hub_cleanup: {
    description: 'List the files of this project that can safely be removed (a list only; the user decides on NodeCut\'s Disk page).',
    schema: { project: z.string().optional() },
    run: async a => {
      const p = await resolve(a.project); const d = await call('GET', `/api/project/${p.id}`);
      if (!d.cleanup.length) return 'Nothing to clean up.';
      return [`"${p.title}" — ${GB(d.cleanup.reduce((s, c) => s + c.size, 0))} can be cleaned up:`, ...d.cleanup.map(c => `- ${GB(c.size)} ${c.path} — ${c.reason}`), 'Tell the user to approve it on NodeCut\'s Disk page (Recycle Bin / archive). Never delete these yourself.'].join('\n');
    },
  },

};
