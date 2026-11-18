# New film starter

Copy this folder into one of NodeCut's watched folders (default `<workspace>\films\<film-name>`, the workspace chosen in
setup, usually `Documents\NodeCut`) and build the
film in `film.js`. It already follows NodeCut's project contract (`docs/PROJECT-CONTRACT.md` in the NodeCut folder):

| File | What it is | Adapt |
|---|---|---|
| `index.html` | the page: one 1920×1080 canvas `#c` + `film.js` | another size: change the canvas, `W`/`H` in `film.js` and `VW`/`VH` in `render.js` (e.g. 1080×1920 for Shorts) |
| `film.js` | `window.renderOut(t)`, `window.READY`, `window.VH_SCENES` | everything — keep the three names and the "pure function of t" rule |
| `make-audio.js` | writes `audio/mix.wav` (a placeholder tone bed synthesized in code) | replace with your own mix: any `audio/mix.wav` works (voice-over, music, effects mixed together) |
| `vhcraft.js` | the craft library: easing curves, keyframe tracks, beat pulses, transitions, vignette/grain/letterbox, captions, kinetic type (`docs/PROJECT-CONTRACT.md` §5.6). Already loaded by `film.js` | use more of it — do not copy it into a film from anywhere else, and do not hand-roll an easing curve it already has |
| `vhatlas.js` | draws a generated clip from NodeCut's `gen/` folder, one atlas cell per moment (§5.8). Already loaded by `film.js` | nothing, unless the film grows generated clips — then `GEN.get('<id>').drawFit(g, localT, …)` |
| `render.js` | chunked renderer (Edge/Chrome + ffmpeg), 2-second chunks, `ONLY=` partial re-renders; frames straight from the canvas, graphics-card encoder (`NODECUT_ENCODER`) | `FPS` (30 → 60), `CH` (frames per chunk, e.g. 120 at 60 fps), `VW`/`VH`, `PAGE` |
| `package.json` | `"type": "commonjs"` and an optional `puppeteer-core` | — |
| `BRIEF.md` | what this film is for, written by the New film dialog (only films created there have one) | never rewrite it to match the film — rewrite the film to match it |
| `plan.json` | the beat table the film is built from: `medium`, `why`, camera, payoff per beat (written by `hub_plan`) | regenerate with `hub_plan`, not by hand, so it is scored |
| `AGENT.md` | this film's conversation with the agent (written by the ◈ Agent tab) | read it before asking the user to repeat themselves |

Then:
1. `node make-audio.js` (or put your own `audio/mix.wav` there).
2. Tell NodeCut the length once (and 2 parallel workers, the fastest setting measured): `hub_project({project: "<folder>", set: {title: "…", status: "in-progress", render: {workers: 2, env: {DUR: "10"}}}})`.
3. `hub_live({project: "<folder>"})` — the film plays in NodeCut's live preview, no render.
4. If there is a `BRIEF.md`, `hub_plan({project: "<folder>"})` reads it and names the few craft notes in
   `docs/craft/` to read. Fill in the beats, and let the checker refuse a plan that puts one medium on every beat.
5. The user leaves notes and presses **Send to Claude**; fix them in code; render (`hub_render({mode: "full"})`) only
   when the user asks for it. Later fixes: `hub_render({mode: "partial", notes: [ids]})` re-renders only those chunks.
6. `hub_contact_sheet({project: "<folder>"})` returns one PNG of N labelled frames — look at it before rendering (and
   after a fix) to catch a wrong composition, a muddy frame or a stretch that does not change at all.

`render.js` loads `puppeteer-core` from this folder (`npm install`) or from NodeCut's own `node_modules` (the render
queue passes `NODECUT_DIR`), finds Edge or Chrome by itself (`CHROME` env overrides) and needs `ffmpeg` on PATH
(`FFMPEG` env overrides). Run by hand: `node render.js 2` → `render/<folder>.mp4` with sound.

Speed without quality loss: when the page is one `VW`×`VH` canvas with nothing over it (like this template), frames
are read straight from the canvas (lossless); otherwise they are PNG screenshots (lossless too, slower). Keep the whole
picture on the canvas — draw captions on it, not as HTML over it. The encoder is `NODECUT_ENCODER` = `auto` (graphics
card when it can, else x264) | `nvenc` | `amf` | `qsv` | `x264`. Every frame must depend only on `t`: two browser copies
render different chunks at the same time. Details: `docs/RENDER-SPEED.md` in the NodeCut folder.
