# Routing — brief in, files to read out

Read this first. It answers two questions and nothing else: **which kind of film is this**, and **which craft files
matter for it**. Do not read files the table does not name; the point of the router is that a job needs three or four.

## Always read

- [`mediums.md`](mediums.md) — every film chooses a medium per beat, so this is never optional
- [`taste.md`](taste.md) — committing to a look before writing a beat

## Then match the brief

| the brief reads like | these files |
|---|---|
| brand film, trailer, mood, atmosphere, luxury, "cinematic", dramatic | [`pacing.md`](pacing.md), [`camera.md`](camera.md), [`sound.md`](sound.md) |
| explainer, "how X works", tutorial, teaching, breakdown | [`story.md`](story.md), [`pacing.md`](pacing.md), [`type.md`](type.md) |
| motion graphics, kinetic, logo sting, title, ident, showreel | [`type.md`](type.md), [`pacing.md`](pacing.md) |
| social, reels, TikTok, vertical, 9:16, short | [`formats.md`](formats.md), [`pacing.md`](pacing.md), [`type.md`](type.md) |
| product demo, app walkthrough, screen recording | [`camera.md`](camera.md), [`type.md`](type.md) |
| talking head, interview, presenter | [`camera.md`](camera.md), [`sound.md`](sound.md) |
| anything with narration or music | [`sound.md`](sound.md) always |

If the brief matches nothing, it is a brand film until it says otherwise.

## Reading the brief

A brief can be one sentence or ten. Pull out what it actually fixes:

| what to look for | why it matters |
|---|---|
| **length and shape** — "20 seconds", "a loop", "under a minute" | sets the beat count before anything else |
| **audience** — who is watching, and where | social vs. presentation changes pacing and type size |
| **what it must say** — the one claim | that claim is a beat, and usually the last held one |
| **what it must not look like** | goes straight into the ban list in `taste.md` |
| **assets that already exist** — footage, a jar, a logo | a beat built from real footage is often stronger than a generated one |

What the brief does **not** say, you decide. Do not ask the user to fill gaps a sensible director would fill: pick, say
what you picked in one line, and move on.

## After routing

1. Write the beat table: one entry per beat with a **medium** (see `mediums.md`) and one line of **why it exists**.
2. Score it with `hub_plan`. If it is refused, the refusal names the fix — take it.
3. Only then write `film.js`, one function per beat, in the order the plan gives.

## Length → beats

| length | beats | note |
|---|---|---|
| 6–10 s | 2–3 | a sting. One idea, no arc |
| 15–20 s | 4–6 | the standard short ad. Every beat earns its ~3 s |
| 30–45 s | 8–12 | room for a turn: setup, complication, landing |
| 60–90 s | 15–25 | needs a real story structure, not a longer ad |
| 2 min+ | 30+ | a different craft entirely; consider whether this is the right tool |
