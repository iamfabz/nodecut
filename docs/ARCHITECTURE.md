# NodeCut architecture

A local Node 22 server (ES modules, no build step, two npm dependencies plus `puppeteer-core` for render scripts),
a vanilla-JS UI, built-in Node render protection and MCP tools for Claude Code or OpenCode. Windows is established; Linux and macOS are new and await real-machine acceptance. There is no compiled helper program.
What film projects must look like is in [PROJECT-CONTRACT.md](PROJECT-CONTRACT.md).

## Processes and lifetime
- **Hub** — `server/hub.js`, HTTP on `127.0.0.1:7788` (UI + JSON API + server-sent events). It runs only while used:
  with no NodeCut window (SSE client), no queued/running job, no cleanup, no note pictures or review copies being made
  and no tracked render for 2 minutes (`NODECUT_IDLE_SEC`), it stops built-in protection and exits — unless
  "Start at login" is on (then it stays up). The `hub_*` tools start it again when needed.
- **Render protection** — `server/guard.js`, inside the hub. The queue reports the process it starts (`guardTrack`); `server/platform.js` applies priority and supported CPU limits to its tree. Windows keeps processor affinity and priority classes. Linux uses niceness and `taskset` with the original allowed mask; macOS uses niceness and background QoS (`taskpolicy`), with no core-affinity limit. Every 3 seconds the guard reads available memory (macOS uses `vm_stat`), slows the newest render below `PauseMB` and every render below `CriticalMB`, then attempts to restore normal settings as RAM frees. Unix priority restoration can fail without privileges, so it is best effort and never requests elevation. The guard does not freeze processes, has no hotkeys and tracks only queue renders. Windows retains `%APPDATA%/RenderGuard/settings.txt` and the legacy history; Linux uses `$XDG_CONFIG_HOME/nodecut` or `~/.config/nodecut`; macOS uses `~/Library/Application Support/NodeCut`. Recognized old compiled Windows helpers belonging to the target install are retired by update without being executed, never rebuilt.
- **MCP server** — `server/mcp.js` (stdio) exposes `server/tools.js`; `server/cli.js` runs the same tools from a shell;
  `server/mcp-selftest.js` checks the MCP wiring. Tools talk to the hub over HTTP (`NODECUT_PORT` overrides the port).

## Map
| File | Role |
|---|---|
| `server/platform.js` | Injectable OS layer: paths, browser/tools, system UI, reversible Trash, volumes, notifications, process trees, protection, capabilities and login startup. |
| `server/config.js` | `data/config.json`: the workspace (`baseDir`: `NODECUT_BASE_DIR` → `config.baseDir` → `Documents\NodeCut`; the folder defaults derive from it), roots, folders (outputs, sounds, archive, thumbnails, studio), `skipFolders`, render settings (`render.encoder`). First run: the films folder + discovered suggestions (off). An existing config keeps every value it has. |
| `scripts/init-config.mjs` | Setup's helper: what is decided already (`--state`), workspace checks, creating the workspace + README.txt and writing `config.json` (never overwriting a value), encoder detection (`--detect`), the example film (`--example`). The shared Node installer asks and passes answers (`data/setup-answers.json` remembers them). |
| `server/encoders.js` | Render encoders: which ones this PC can use (one tiny test encode each, cached in `data/encoders.json`; `GET /api/encoders`), their ffmpeg arguments (the template's `render.js` carries a copy, kept equal by a test), `NODECUT_ENCODER` for jobs. See RENDER-SPEED.md. |
| `server/legacy.js`, `ui/values.js` | Stored values (note/project/thumbnail statuses, note kinds) and the one place old Turkish values are mapped to English. |
| `server/scan.js` | Projects under the roots, video roles, duplicates, card thumbnails; root watchers so soft scans re-walk only changed projects. |
| `server/source-revision.js` | A project's code revision (live covers; 409 on stale covers). |
| `server/live.js` | Live preview: finds the page/fps/size/length/sound, serves `/live/<id>/…`, watches code → SSE `live-changed`. |
| `server/notes.js` | Review notes (`.nodecut/notes.json`), frame pictures cut by ffmpeg in one queue, the agent-directed copied note text. |
| `server/jobs.js` | Render queue (`data/jobs.json`): one at a time, partial re-renders, concat, sound, versions, `register()`. |
| `server/media.js` | Film strip, waveform/peaks, full frames, review copies (`data/proxy`). |
| `server/guard.js`, `ramhogs.js` | Built-in protection state/commands/settings/history; programs holding RAM next to a render (never closes anything). |
| `server/outputs.js`, `ciktilar.js`, `ciktilar-dir.js` | "Recent renders" list; the global outputs folder (hard links, one folder per day). |
| `server/janitor.js` | Cleanup candidates (safe/deep), reversible Trash / Recycle Bin, archive; one cleanup at a time. |
| `server/tools.js` | The `hub_*` tools. |
| `server/transcript.js`, `layers.js`, `scenes.js` | Narration text, sound stems + cues, scene lane. |
| `server/tweaks.js`, `sound.js`, `vhsound.mjs`, `soundedit.js`, `sfxlib.mjs`, `edit2d.js` | The film's `tweaks.json` (one writer), mix rebuilds, added sound clips, ready-made effects, 2D layers. |
| `server/example.js` | First-run helper that copies `examples/hello-film` into the films folder. |
| `ui/app.js` | Pages (Projects, project, Renders, Recent renders, Disk, Settings); `ui/review.js` + `ui/review/*` the review editor. Owns the shared `h()` / `api()` / `toast()` helpers, `confirmBox`, and `promptBox` (one text field; Enter submits, Escape cancels, `validate` reports a bad value before it is sent). |
| `POST /api/projects/new` (`server/hub.js`) | **New film** button. Copies `templates/new-film` into the first enabled `container` root and returns the new project, so the UI can open its live preview. The folder *is* the project: this is the only route that creates one on the user's behalf. |
| `engine-hooks/` | Page-side hooks for the scene editor (`vhtweaks.js`) and 2D layers (`vh2d.js`) that engines can include, the craft library (`vhcraft.js`) and the generated-clip atlas loader (`vhatlas.js`) — the last two also served from here when a film has no copy of its own. |
| `server/genapi.js` | Model generation: the two providers' wire bodies, the tunnel that publishes one still, the daily spend cap, and the poller that finishes a clip job (surviving a hub restart). Off unless Settings → Generation is on. |
| `server/gen.js`, `gen/` | Generated media: `gen/gen.json` (append-only asset records), plates, clips, and the bake that tiles a clip into sprite atlases so a film can draw one cell per moment and stay a pure function of `t`. `hub_gen_import` / `hub_gen_list`. |
| `server/contactsheet.js` | Contact sheet: `POST /api/contactsheet` runs it as its own process, which opens the live page in headless Chrome, calls `window.renderOut(t)` per frame and tiles the frames (with timecodes) into one PNG in the project's `snaps/`. The `hub_contact_sheet` tool uses it so an agent can look at its own edit. A child process, so a stuck browser cannot hold the hub. |

## Things that matter when changing the code
- **Never block the hub.** Folder walks yield every 300 entries (`breather` in scan.js), the cleanup scan is async;
  one big synchronous loop in a request path once froze every request for ~20 s on a 50k-file project.
- **The UI never imports from `server/`.** A browser cannot load server files or `node:` modules, and one broken module
  in `app.js`'s import graph blanks the whole UI. Shared code lives in `ui/` as plain modules (`ui/values.js`,
). Open the pages after a UI change.
- **Typography is two variables.** `ui/style.css` `:root` names every face once: `--head` (Montserrat) for headings,
  buttons, nav, pills and card titles, `--font` (Open Sans) for running text, `--mono` for timecodes and paths. Sizes come
  from the `--fs-xs … --fs-xl` scale and `--lh`. Change them there, never per-rule. The faces are **self-hosted** from
  `ui/fonts/*.woff2` (latin variable subsets, `@font-face` in `style.css`) so the studio renders offline with no CDN call;
  `server/hub.js` therefore serves `.woff2`/`.woff`/`.ttf` with font MIME types — add a MIME entry before serving any new
  file type, or the browser silently refuses the file (`application/octet-stream`).
- **The review CSS has two layers.** `ui/review.css` ends with a `polish` block that intentionally overrides earlier rules
  (transport height, tab padding, tip bar). Edit the late block or your change is silently beaten. The side-panel tab strip is
  narrow, so tabs shrink: `.rv2-tlab` uses `min-width: max-content` so a 1-pixel squeeze never turns "Notes" into "Not…"
  (the ellipsis is only for genuinely long names).
- **Per-frame code** (review `tick()`, the live loop) must not read layout: reading `clientWidth` after a text change
  reflowed ~100 note cards every frame (10.6 ms → 0.4 ms after the fix).
- **Never hard-delete.** Trash / Recycle Bin (Windows refuses items bigger than the Bin) or archive (copy, verify, then remove; never
  overwrite, `_2`). The user approves every cleanup in the UI.
- **Windows `fs.watch` reports reads as changes** (last-access time): count an event only when the mtime is really newer
  (`reallyChanged` in live.js, the same idea in scan.js).
- **Note pictures are cut by ffmpeg** from the original video by frame number, never from the browser's `<video>`
  (comes back black) or the review copy. Live-preview notes send their frame from the page's canvases.
- **One render at a time.** The queue also also respects tracked render work. Do not start
  renders in parallel to test something.
- **Render script speed** (`templates/new-film/render.js` = `examples/hello-film/render.js`, keep them equal): the raw
  canvas path is used only when it is pixel-identical to a screenshot; check with lossless renders (RENDER-SPEED.md)
  after changing it. Keep everything NodeCut reads from the script (PROJECT-CONTRACT.md §4).
- **Creating a film never overwrites one.** `POST /api/projects/new` uses `mkdirSync` (no `recursive`), so an existing
  folder throws `EEXIST` → 409 instead of merging into someone's film. The name is reduced to a single safe folder name
  (separators and `:*?"<>|` become `-`, leading/trailing dots and spaces go, 80-character cap) and `isInside` is checked
  before anything is written, so `../..` cannot escape the films folder. If copying the starter fails, the half-made folder
  is removed again. Only files are copied: no audio is generated, so a new film previews silently until `audio/mix.wav` exists.
- **Setup never moves or overwrites** the user's folders or an existing `config.json` value; a re-run keeps every answer.
- **Security:** the server listens on 127.0.0.1 only and refuses requests whose Host is not loopback (DNS rebinding),
  that a browser marks cross-site (`Sec-Fetch-Site`), and writes with a foreign `Origin`. The job queue can run shell
  commands (`mode:"command"`), so the port must never be exposed.
- UI details that bit before: `Element.append(null)` prints "null"; a focused `<select>` eats arrow keys; drawing must
  not move focus into the note box; letter shortcuts normalise Turkish `ı`/`İ` to `i`.

## Data
- `data/` (per machine, never in git): `config.json`, `setup-answers.json`, `encoders.json`, `index.json` (scan), `jobs.json`, `probe-cache.json`, `thumbs/`,
  `media/`, `proxy/`, `ciktilar.json` (outputs index), `seen-outputs.json`, `perf.jsonl`, `sfx-lib/`.
- Per project: `.nodecut/` (notes, versions, project.json, scenes, chats, autoscan, thumbnails) and `tweaks.json`,
  `vhaudio/`, `vh2d/` next to the film.

## Testing
- `npm test` runs `node:test` with fake home, temp, config, workspace and data inside `.test-tmp`. `node --check` covers changed source. OS-specific unit tests inject process, filesystem and command dependencies; no real dialogs, Trash or login startup changes are required.
- A scratch hub must use `NODECUT_PORT=7799`, `NODECUT_DATA_DIR=<scratch>`, `NODECUT_BASE_DIR=<scratch>`, `NODECUT_GUARD=off`, `NODECUT_JOBS=off`, `NODECUT_NO_WINDOW=1` and, when needed, `NODECUT_IDLE_SEC=600`. Set the same port on every CLI call. Never contact the user's port 7788 in development tests.
- Shell syntax is checked with `bash -n` when Bash is available, otherwise reported as skipped. CI includes Windows, Linux and macOS with Node 22; real desktop acceptance remains separate. Browser uploads cannot carry `.github/` workflows.
- Installer tests use dry-run or a fake home and injected agent registration. Never change the real agent configurations while testing.
- Film preview/review is required before rendering; application-page smoke tests need no film playback or render. Real Linux/macOS installation, sound render, protection, Stop, Trash restore and lifecycle acceptance are listed in [PLATFORMS.md](PLATFORMS.md).

## Operating-system integration
`server/platform.js` is the only module reading `process.platform`. Its injectable factory provides paths, tools/browser discovery, file opening/reveal, folder dialogs, reversible Trash, volumes, notifications, process enumeration/tree termination, render priority/CPU affinity, and login startup. The existing util exports and queue/guard/cleanup contracts remain. Windows retains registry, transparent PowerShell command and Explorer integrations. Runtime folder selection loads the installed WinForms folder dialog (`Add-Type -AssemblyName`, nothing compiled) with a topmost owner; Trash uses the installed .NET Recycle Bin API and refuses disabled/oversized/unavailable Bin operations. There is no inline C# compiler, custom P/Invoke, generated PowerShell runtime file, encoded command or execution-policy override. Normal launch, new shortcuts and login startup invoke the installed Node executable through `scripts/install.mjs open`; `open.cmd` is the clickable launcher. `open.vbs`/`open.ps1` are gone: update re-points owned shortcut/HKCU Run entries to Node before retiring those files (`install.mjs retire-legacy --launchers`). Unknown/unreadable references or migration failures retain old launchers and report a warning.

Linux reads `/proc` directly, falling back to `ps`. Queue children have separate process groups so Stop can terminate descendants; priority applies per process and affinity uses the original allowed taskset mask. Missing optional tools are capability data for the UI. Trash uses existing desktop tools or an atomic same-filesystem freedesktop move and metadata; unsafe locations are refused. Unix niceness restoration is best effort because raising priority can require privileges. Agent registration, skills/rules and ownership checks are shared in `scripts/agents.mjs`; Windows `.cmd` and Unix shell lifecycle entry points call `scripts/install.mjs` directly. The retained Windows `.ps1` files are policy-respecting compatibility forwarders; no lifecycle path adds an execution-policy override. The server remains loopback-only. Tests inject OS/filesystem/process dependencies and run with a fake home/temp/data under `.test-tmp`.

macOS discovers native browsers in `/Applications` and `~/Applications`, uses `open` / AppleScript for system UI, Finder for restorable Trash and a LaunchAgent plist for login startup. Finder Automation refusal leaves files untouched. The Desktop launcher is a `.command` file rather than an unsigned application bundle. Capabilities drive UI labels and hide unsupported CPU controls; browser modules do not inspect the host OS. VideoToolbox is tested by the same short encode probe as other hardware encoders, with Apple Silicon quality and Intel bitrate candidates.

## Distribution and Windows trust
The upload folder is built from committed source, excluding machine-local data and dependencies. Already distributed archives and installed copies remain unchanged until an explicit distribution/update. `scripts/distribution-safety.test.js` rejects compiled executable helper files and application bundles in the source tree. Installed Node, browsers and ffmpeg remain external runtime requirements. These checks describe packaging and behavior; they do not identify an antivirus verdict or confer publisher reputation. Distinguish a named malware detection from SmartScreen reputation, Smart App Control and PowerShell policy errors before investigating an alert. Do not work around an alert by disabling protection or adding blanket exclusions; any vendor submission requires the exact distributable and the user's authorization. See [WINDOWS-SECURITY.md](WINDOWS-SECURITY.md).
