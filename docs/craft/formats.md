# Formats — what changes with the frame

The same film in a different shape is not the same film. These are the changes that matter, by format.

## 16:9 — 1920×1080

The default. Everything in this folder assumes it.

- Copy sits in the lower third or the centre.
- A wide frame wants a subject with space around it; a full-bleed subject leaves nowhere for the type.
- Horizontal camera moves (drift left/right) read well; vertical moves are weaker.
- Furniture can live in the corners without crowding.

## 9:16 — 1080×1920

Vertical changes the design, not just the crop.

| 16:9 habit | what to do in 9:16 |
|---|---|
| copy in the lower third | copy in the **middle band** (roughly 35–60% height) — the bottom is covered by UI |
| wide establishing shot | go **close**; a vertical frame cannot hold a landscape |
| drift left/right | drift **up/down**, or push in |
| long horizontal chart | **stack** the bars, or use a single climbing value |
| small corner labels | keep out of the top and bottom 12% (platform UI) |

**Safe zones.** On the major platforms the top ~12% and bottom ~20% can carry UI. Keep all copy inside the middle 68%.

**Text size.** A vertical frame is watched on a phone at arm's length: type that reads at 24 px in 16:9 needs ~30 px at
1080×1920 to feel the same.

**Beat rate.** Vertical short-form tolerates — and expects — a faster cut. A new visual element every 1–3 s rather than 3–5.

## 1:1 — 1080×1080

A square is a compromise: it suits feed placement and suits neither of the other two. Use it when the film will sit next to
other square content, not when you are choosing freely.

- Copy centred or in the lower quarter.
- Symmetric compositions work better here than anywhere else.

## 4:5 — 1080×1350

The feed format that keeps the most vertical space without being a story. Everything in the 9:16 table applies except the
extreme safe zones, which are smaller here.

## Changing format in a code film

The frame is `W` and `H` in `film.js`, and the canvas in `index.html`. When you change them:

1. **Re-check every absolute position.** A copy block set at `H - 148` lands somewhere else entirely at 1920 px tall.
2. **Re-check every fixed size.** A 58 px brand line that whispers at 1080 wide shouts at 1080×1920.
3. **Re-check the camera push.** The same scale factor covers less of a tall frame.
4. **Take a contact sheet again.** A crop that worked in 16:9 can put the subject behind the type.

Do not scale the whole composition by a factor and call it done. The layout is a design decision per format.

## Aspect and source material

Generated stills and clips arrive at an aspect ratio you did not choose. When placing them:

- **cover** (fill and crop) is right for footage — it never leaves bars.
- **contain** (fit and letterbox) is right for a document, a screenshot or a diagram that must not be cropped.
- A 1.8:1 clip in a 1.78:1 frame crops about 1% — invisible. A 1.8:1 clip in a 9:16 frame crops more than half: choose a
  different image.
