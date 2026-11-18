# Contributing to NodeCut

Thanks for looking. NodeCut is a local studio for films that an AI agent writes as code. It is MIT, it runs entirely on
your machine, and it would rather have three good contributions than thirty vague ones.

Read [ROADMAP.md](ROADMAP.md) first if you want to know what is actually wanted right now.

## Before you write code

**Open an issue first** for anything bigger than a typo or a one-line fix. Say what you want to change and why. It saves
you from finishing something that does not fit, which is the most common way a first contribution gets wasted.

That is not gatekeeping, it is scheduling. Someone may already be on it, or the idea may conflict with a decision
recorded in [docs/LOCAL-CHANGES.md](docs/LOCAL-CHANGES.md).

Small things — a broken link, a wrong number in the docs, a typo in a message — just send the pull request.

## Getting it running

You need **Node.js 22 or newer** and **ffmpeg on PATH**. A native Chrome, Chromium or Edge browser is only needed to
render; preview and review work without it.

```bash
git clone https://github.com/iamfabz/nodecut.git
cd nodecut
npm install
bash setup.sh          # Windows: setup.cmd
npm start
```

The hub listens on `127.0.0.1:7791` and opens the app. If it does not, say why rather than going quiet — it prints the
reason, and a run that fails loudly is more useful than one that appears to work.

`setup.sh` writes into your own home folder. To keep a test run away from your real films, point it elsewhere:

```bash
NODECUT_PORT=7801 NODECUT_BASE_DIR=/tmp/nodecut-scratch npm start
```

### Linux and macOS

Support is implemented and covered by tests, but nobody has finished a real film on either yet. See
[docs/PLATFORMS.md](docs/PLATFORMS.md) for the exact state of each system call. **Bug reports here are worth more than
code right now** — your distribution, the exact error text, and what you were doing.

## Tests

```bash
npm test          # every suite
npm run check     # syntax check on the hub and the MCP entry point
```

Tests must pass locally before a pull request. The expected output is:

```
ℹ tests 387
ℹ pass 385
ℹ fail 1
```

That one failure — `Windows clickable lifecycle entry points invoke Node directly without policy overrides` — is known
and predates this repository. It asserts a Windows installer behaviour that cannot hold on a development machine. Do
not "fix" it to make the number green, and do not let it hide a second failure.

If you add behaviour, add a test that would fail without it. The suites live next to what they test, as `*.test.js`.

## What this codebase cares about

A few rules are load-bearing. Breaking them is easy, and the tests will not always catch it.

- **The picture is a pure function of `t`.** No date, no random seed, no frame-to-frame state, no `Math.random()` in a
  film. That is what lets the preview play any moment instantly and frame-accurate, and what makes a partial re-render
  honest. If a change makes a frame depend on when it was drawn, it is wrong however good it looks.
- **Nothing leaves the machine on its own.** The hub binds `127.0.0.1` only, no telemetry, no upload, and API keys are
  never returned by an endpoint — they are reported as booleans. If you add a route, assume it is reachable by any page
  the user has open.
- **MIT, and nothing from AGPL projects.** Ideas are fine and welcome. Copied code from an AGPL source is not, and would
  poison the licence for everyone. Say where an idea came from in the pull request.
- **Do not hide a failure to make output look clean.** A warning that says what went wrong beats a silent success. This
  applies to render steps, platform probes and the UI alike.
- **Credit stays.** The [LICENSE](LICENSE) and [README](README.md) name the upstream project whose foundation this is
  built on. Do not remove it.

## Style

Match the file you are editing. The code leans on plain functions, small modules and comments that explain *why* a thing
is the way it is, not what the line does. No build step, no bundler, no framework — the UI is plain DOM and the server is
plain Node.

Two conventions worth knowing:

- Comments describe intent and trade-offs. If a line needs a comment to say what it does, consider a better name first.
- Tests that stub the DOM are stricter than the browser. Production code must not assume a stubbed element has
  `dataset`, `classList`, `append` or other browser-only helpers unless another test already provides them.

## Sending a pull request

1. Branch from `main`.
2. One concern per pull request. A refactor plus a feature is two pull requests, because one of them will be wrong.
3. Say what you changed and **what you actually ran** to check it. "Tests pass" is weaker than "I rendered a 12-second
   film on Linux with VAAPI and watched the output".
4. If you could not test something — a Windows-only path, a real GPU encoder, a Mac — say so plainly. Untested is fine.
   Claimed-tested-but-not is not.

There is no CLA to sign and no form to fill in.

## Reporting a bug

A useful report has:

- **What you did**, in the order you did it.
- **What you expected** and **what happened** instead. Quote the exact text, not a paraphrase.
- **Your OS**, and for rendering on Linux or macOS, which encoder and whether a GPU was involved.
- **The log.** The hub prints to its terminal; a render writes its own log. Copy the lines around the failure.

If a render came out wrong, the film project is worth attaching if you are willing to share it. A picture is nearly
undiagnosable without the code that drew it.

## Security

Do not open a public issue for a vulnerability. Message the maintainer directly through the profile at
[@iamfabz](https://github.com/iamfabz). There is a section in the README on what NodeCut deliberately does not do
(no elevation, no security-tool exclusions, no policy changes), which narrows what counts as a bug.

## Code of conduct

Be straightforward and be kind. Critique the work, not the person. A confident wrong answer is more useful than a
silent one, as long as it can be corrected without drama.
