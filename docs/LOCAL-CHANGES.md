# Local changes

NodeCut is its own repository, maintained by **Fabio (iamfabz)**. It began as a fork of
[VideoHub](https://github.com/iamfabz/Videohub); the upstream VideoHub authors retain full credit and copyright for the
original work (see [LICENSE](../LICENSE)), and everything here is an addition to it. This page is the record of those
additions, so the debt to upstream is always visible.

History note: during development the work lived on a branch called `fabio-ui`, and older entries below still mention it.
That branch is now this repository's default branch, `main`.

## What was added, and why

| Change | Files | Reason |
|---|---|---|
| Projects page **＋ New film** button | `ui/app.js`, `server/hub.js` | There was no way to start a project from the app: creating a film folder was left to the agent. |
| `promptBox()` text-field dialog | `ui/app.js` | The UI only had `confirmBox` (yes/no), so the button had nothing to ask a name with. |
| Montserrat + Open Sans, self-hosted | `ui/style.css`, `ui/fonts/*.woff2`, `server/hub.js` | The studio's typography was a system-font fallback and read cramped; fonts are served locally so it works offline. |
| Roomier type scale and spacing | `ui/style.css`, `ui/review.css` | Controls and tables were tight; sizes now come from `--fs-*` instead of per-rule numbers. |
| Font MIME types | `server/hub.js` | `.woff2` was served as `application/octet-stream`, which a browser refuses for `@font-face`. |
| Hub port 7791 | `data/config.json`, `~/.config/opencode/opencode.jsonc` | Port 7788 is already used by the NCU dashboard on this machine, so NodeCut silently failed to start. |
| macOS Trash without Finder | `server/platform.js`, `server/platform.darwin.test.js` | Deleting a thumbnail failed with `-1728 Can't get POSIX file`: `POSIX file (item 1 of argv)` sat *inside* the `tell application "Finder"` block, so AppleScript resolved it against Finder and could not coerce it. The "allow Automation permission" message was a red herring. Moving to Trash is now a plain same-volume rename into `~/.Trash` (or `/.Trashes/<uid>` on another volume) with Finder-style `name 2` collision naming. It needs no Automation permission, cannot hang on an unanswered permission prompt, and stays reversible. |
| **Craft library** `engine-hooks/vhcraft.js` | new file, `templates/new-film/{film.js,vhcraft.js}`, `engine-hooks/vhcraft.test.js` | Every film was re-inventing `clamp`, easing, transitions and text layout, so quality started from zero each time. Now there is one deterministic set of primitives (22 curves, keyframe tracks, beat pulses, crossfade/wipe/slide/iris, scrim/vignette/grain/letterbox, captions and kinetic type) that the starter demonstrates. It cannot break the golden rule: a test greps the source for `Date.now`, `new Date` and `Math.random` and fails if one appears. |
| **Generated media** `gen/`, `server/gen.js`, `hub_gen_import`, `engine-hooks/vhatlas.js` | new files, `server/hub.js`, `server/tools.js`, `server/live.js`, `server/gen.test.js`, `engine-hooks/vhatlas.test.js`, `templates/new-film/{film.js,vhatlas.js}` | A clip made by a model cannot be drawn like a film (a `<video>` cannot be seeked inside a synchronous `renderOut`), so it is baked into sprite atlases and the film draws one cell per moment — still a pure function of `t`. This step is offline on purpose: importing a file the user already has exercises the whole path (copy → record in `gen.json` → bake → draw) before a single API call is written. `gen/` is NodeCut's folder, like `vh2d/`, and is excluded from the live-reload watcher. |
| **Generation** `server/genapi.js`, `hub_generate_plate`, `hub_generate_clip`, Settings → Generation, ✦ Assets tab | new files, `ui/app.js`, `ui/review/gen.js`, `ui/review.js`, `server/hub.js`, `server/tools.js`, `server/genapi.test.js`, `server/genapi.tunnel.test.js` | The models the user asked for (DeepInfra FLUX for stills, OpenRouter for still→clip), behind four gates: off by default, the price on screen before the submit, a daily cap enforced with 402, and a one-still tunnel that closes at submit. A clip is a job that survives a hub restart. Corrects the two things that would have failed silently: OpenRouter needs `frame_images` (not `image`) and is asynchronous; DeepInfra returns base64 when asked, so there is no expiring URL to chase. |
| **The craft reference** `docs/craft/` (10 files) | new folder, `server/plan.js`, `engine-hooks/vhrisk.js` | A film used to jump straight from "the user asked" to "write `film.js`", so the *thinking* — what medium each beat should be, what the film is for — lived only in the chat. Ten short notes now cover it, and a brief routes to the three or four that apply. |
| **The slideshow gate** `engine-hooks/vhrisk.js`, `server/plan.js`, `hub_plan` | new files | The failure this fork kept shipping: every beat a clip with a caption on it. Seven dimensions ported from OpenMontage plus one that did not exist upstream — **media variety**: three beats in a row on one medium is refused whatever the average says. A VERDANT rebuild went from **1.9/refused** to **0.3/strong** and from six clip beats to five different mediums. |
| **New film asks for a brief** `server/brief.js`, `ui/app.js` `newFilmBox()` | new files, `server/hub.js`, `ui/review.js` | A name alone made a folder somebody had to interrogate later. The brief is now required, written to `BRIEF.md` + `plan/route.json` at creation, and `hub_plan({project})` reads it back — so the brief typed once is the brief the film is built from. |
| **◈ Agent tab** `server/agent.js`, `ui/review/agentpanel.js` | new files, `ui/review.js`, `ui/review/sidepanel` slot, `ui/app.js` `onSse` | The user had to leave NodeCut to talk to the agent. One turn at a time to `opencode run` in the film's own folder, with a model picker and the CLI's errors shown verbatim. Each film owns **one stable session**, and the conversation is kept in `AGENT.md` so it survives restarts and other projects — proven by recalling a fact after a full hub restart. No PTY, no WebSocket, no new dependency. |
| **Contact sheet** `server/contactsheet.js`, `POST /api/contactsheet`, `hub_contact_sheet` | new file, `server/hub.js`, `server/tools.js`, `server/contactsheet.test.js` | No way to *see* an edit without a render, so "review your work" was guesswork. One PNG grid of N labelled frames now comes back in about a second, from the live page alone (works on `code` films with no render script), with a frozen-film warning. Runs as a child process with a hard timeout, so a hung browser cannot wedge the hub. |

Nothing in the film contract, the render queue, the review data model or the built-in protection was changed. Films,
notes, outputs and settings are untouched.

## New film: how it behaves

`POST /api/projects/new` copies `templates/new-film` into the first enabled `container` root, then the page opens
`#/review/<id>/~live`.

- **Copies files only.** No `audio/mix.wav` is generated, so the new film previews silently until you add one
  (`node make-audio.js` inside the film folder writes the placeholder tone bed).
- **Never overwrites.** An existing folder gives a 409 and the dialog says so; nothing is merged or replaced.
- **Names are made safe.** `/ \ : * ? " < > |` become `-`, leading/trailing dots and spaces are stripped, the name is
  capped at 80 characters, and `isInside` is checked before writing, so a traversal attempt cannot leave the films folder.
- **Failures clean up.** If copying the starter fails, the folder it just made is removed.
- **It is not a wizard.** The folder is the project; the film itself is still written in `film.js` by the agent.

## The Agent tab: talk to OpenCode from inside NodeCut

The review page's right-hand panel now opens on **◈ Agent**, before Notes. It sends one message at a time to
`opencode run` in the film's own folder and shows what comes back — so a film can be planned, built and fixed without
leaving NodeCut for a terminal.

- **`server/agent.js`** — spawns `opencode run --format json`, parses the event stream into transcript entries, keeps
  one run per film, and enforces a 10-minute ceiling. `parseLine()` is pure and tested against real captured CLI output.
- **API** — `GET/POST /api/project/:id/agent`, `POST …/agent/stop`, `POST …/agent/clear`, `GET /api/agent/models`.
  Events go out on the existing SSE stream as `agent`.
- **`ui/review/agentpanel.js`** — the pane: transcript, model picker, send (⌘Enter), stop, and the CLI's own errors shown
  verbatim with their HTTP status. The chosen model is remembered in `localStorage`; the other players are unchanged.

### The film's memory

A tab-local transcript was useless: ask a question in another project and the agent had forgotten the film. So each film
owns **one stable OpenCode session** (`ses_vh<filmId>`, passed as `--session`), and the conversation is written to
**`AGENT.md` in the project root** after every turn.

- Verified across a **full hub restart**: a colour told to the agent in one process is recalled, correctly, by the next.
- `AGENT.md` is markdown a person can read (the conversation) with the machine state in an HTML comment at the bottom, so
  there is one file, not a JSON sidecar. It sits at the project root with a visible name because this repo forbids
  dot-prefixed paths (GitHub's browser upload silently drops them).
- **Clear starts a new session.** Keeping the old one would leave the agent remembering exactly what the user asked it to
  forget.

### Two failures that cost a debug round each

- **`stdio` must be `['ignore','pipe','pipe']`.** With an open stdin pipe, `opencode run` waits for input and exits
  **130 with no output at all** — no error, no message, a silently dead tab. Ignoring stdin makes it run the prompt.
- **A GUI-launched hub has a thin PATH.** `opencode` is found but dies unless `~/.opencode/bin` is on PATH, so the child
  gets the environment of a login shell (`shellEnv()`, cached), not `process.env`.

### How it answers

Every turn carries a short style preamble (`STYLE` in `server/agent.js`): two or three sentences, plain words a 17-year-old
would follow, no jargon, no file paths unless the person needs one, no explaining its own process, one question instead of
a menu. It is re-sent each turn because a session's instructions drift over a long conversation. Verified on real runs: the
answers read like a person talking about the film, not a log.

### What it deliberately is not

Not a terminal and not a PTY: no new dependencies (`node-pty`, `ws`, `xterm.js` were all rejected). It is a conversation
with the agent, which is the part that matters inside a film review page.

## New film: the brief

The New film dialog used to ask for a name and nothing else, so a folder was created and then sat there until an agent
came along and asked what it was for. It now asks **and requires a brief**.

- **`ui/app.js`** — `newFilmBox()` (a sibling of `promptBox`, which keeps its other callers): a name field and a required
  textarea. Enter submits from the name; ⌘/Ctrl+Enter submits from the brief; Escape closes.
- **`server/brief.js`** — `cleanBrief()` (empty, under 20 characters and over 4000 are refused with a sentence that says
  which), `folderName()` (the one implementation of the safe-name rule, shared with the tests), `writeBrief()`,
  `readBrief()`. Both files are pure and tested (`brief.test.js`).
- **`POST /api/projects/new`** now takes `{ name, brief }` and writes two files into the new folder: **`BRIEF.md`** (the
  brief verbatim, the date, the chosen pipeline and the team files to read) and **`plan/route.json`** (the same routing
  as JSON, so an agent does not have to parse markdown).
- **`GET /api/project/:id/brief`** feeds the **`¶ Brief`** button in the review toolbar. The button only appears when the
  film has a brief, so films made before this change are untouched.
- **`hub_plan({project})`** with no brief reads `BRIEF.md` from the folder, so the brief typed at creation is the brief
  the plan is built from — nobody retypes it.

If writing the brief fails, the whole new folder is deleted: a half-made project that looks finished is worse than none.

### Not done on purpose

No model call. NodeCut still has no LLM and no API key; the brief is routed by `plan.route()`, which is a lookup table,
and the thinking stays with the agent that reads the team files.

## Planning, and the slideshow gate

NodeCut now has a planning stage between "the user asks for a film" and "write `film.js`". The reference it reads is
`docs/craft/`, written for this project (see the licence note at the end of this section).

- **`docs/craft/`** — ten short notes, written for NodeCut: `routing` (brief → what to read), `mediums` (what each beat
  is made of), `pacing`, `story`, `type`, `sound`, `camera`, `taste` (looks and ban lists), `review` (scoring your own
  work) and `formats` (9:16, 16:9 and what each changes). `routing.md` is the entry point; nothing else should be read
  blindly.
- **`engine-hooks/vhrisk.js`** — the plan checker. Six dimensions (repetition, decorative-only visuals, weak motion, weak
  shot intent, typography overreliance, unsupported cinematic claims) and a seventh that is NodeCut's own: **media
  variety**. Three beats in a row on one medium family fails, whatever the average says. Every problem it carries a
  one-line fix.
- **`server/plan.js`** — `route(brief)` picks the kind of film and the 5–6 craft notes to read; `validate(plan)` enforces the
  NodeCut contract (every beat needs a `medium`, a `why`, ordered times); `save()` writes `plan.json` and **refuses** a
  plan the checker would refuse.
- **`hub_plan`** MCP tool — brief in, routing out; plan in, score + saved `plan.json` out.

### A licence note, and why `team/` was removed

An earlier version of NodeCut copied 158 markdown files and a set of JSON schemas from
[OpenMontage](https://github.com/alfredfrancis/OpenMontage) into `team/`. OpenMontage is **AGPL-3.0**; NodeCut is MIT, and
distributing a work derived from AGPL code under MIT is not permitted.

That folder has been deleted, and nothing from it is shipped. `docs/craft/` replaces it: original notes that carry the same
craft knowledge in NodeCut's own words. Where a rule came from public craft writing — Kurzgesagt's production notes, Mayer's
multimedia learning principles, 3Blue1Brown's technique, Murch on editing — the source is named, which is a citation and not a
copy. `docs/craft/README.md` records the provenance.

The checker (`vhrisk.js`) is likewise original: it was written from the *problem* (a film whose beats all look alike), and
the scoring, the thresholds, the media-variety rule and the fix text are NodeCut's own.

If this repository is ever re-merged with upstream VideoHub, this is the one decision to keep: **nothing AGPL in the tree.**

### Two lessons that cost a debug round each

- **A plain mean is the wrong aggregate.** Six dimensions that do not apply (`no cinematic claim`, `no camera movement`,
  `no text`) score 0 and outvote the two that detect a slideshow. Variety and repetition carry double weight, *and* the
  gate refuses on a hard variety/repetition threshold regardless of the average. Verified on the VERDANT film: it scored
  **1.2/"strong"** on the plain mean while being six identical clip beats.
- **`force` overrides the checker, never the schema.** A missing `why` is a broken plan; a repetitive one is a scored
  plan. The first is refused even with `force`.

### What it did to a real film

VERDANT was rebuilt against a plan: risk **1.9 → 0.3**, and the film went from six clip-plus-caption beats to five
different mediums (footage, image-to-video, kinetic type, motion graphics, chart, diagram).

## The live/editor view keeps the full sidebar

The review page (`#/review/<id>`, including `~live`) used to collapse the hub sidebar to a 48 px icon strip with ☰ as an
overlay. It no longer does: the sidebar keeps its normal width, logo, labels, counts and the RAM/live status line, so the
nav reads the same here as on every other page. The only editor-specific rule left is a transparent right border, because
the editor paints its own dark surface right up against it.

- `ui/review.css`: the `.app.app-editor` icon-strip rules (grid column, emoji `::before` glyphs, hidden `.live`) are
  gone. `.app.app-editor > .side { border-right-color: transparent; }` is what remains.
- `ui/review.js`: the ☰ button and the `.side-peek` overlay still exist; they now only matter in a narrow window.

## Updating from upstream

`update.sh` replaces program files and is **not** compatible with this fork. To take an upstream change:

1. `git fetch origin`
2. `git checkout main && git pull` — confirm the change on clean upstream code
3. `git checkout fabio-ui && git merge main` — resolve conflicts in `ui/style.css`, `ui/review.css` and
   `server/hub.js`, where the fork adds rules and routes
4. `npm test` (expect the pre-existing `open.vbs` failure, see below), restart the hub, and open the pages

## Verification

- `npm test` → **436 of 438 pass, 1 skipped**. The single failure is **pre-existing upstream**, not this fork:
  `scripts/windows-safety.test.js` asserts `open.vbs` and `open.ps1` are absent, but upstream ships both. Confirmed on a
  clean `main` checkout.
- New this round: `engine-hooks/vhrisk.test.js` (16), `server/plan.test.js` (15), `server/brief.test.js` (10) and
  `server/agent.test.js` (18). The agent's parser is tested against **real captured CLI output**, including the guardrail
  block and the no-credits error this machine actually produces.
- After UI changes, open Projects, Renders, Recent renders, Disk, Settings and a review page at both ~1600 px and
  ~1280 px wide; the review top bar and transport hide items by priority when space runs out.

## Port

`data/config.json` sets `"port": 7791`. The OpenCode MCP registration in `~/.config/opencode/opencode.jsonc` pins
`NODECUT_PORT=7791` so the tools cannot drift back to 7788. Change both together or the `hub_*` tools will silently talk
to the NCU dashboard instead.
