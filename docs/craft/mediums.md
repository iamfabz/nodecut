# Mediums — what each beat is made of

The single biggest decision in a short film, and the one most often left to habit. If you do not choose a medium per beat,
every beat becomes the same thing: a clip with a caption on it. That is what makes a film look generated.

## The set

`plan.json` allows exactly these, and the checker knows which ones feel different from each other:

| medium | best when | watch out |
|---|---|---|
| `footage` | the subject is real and the camera is the point | needs real motion; a still shot held for 3 s is a photograph |
| `image_to_video` | you have a still and want one move on it | generated clips are usually nearly static — add the camera move in code |
| `kinetic_type` | **the words are the idea** | only if the line is short enough to read once |
| `motion_graphics` | you need to show how something is built, assembled or measured | hand-drawn, so it must be designed rather than defaulted |
| `diagram` | the subject is a process, a structure or a set of parts | needs labels or it is decoration |
| `chart` | you are making a numeric claim | a bar with no number is an illustration, not an argument |
| `none` | a deliberate black frame or a pure-light beat | rare; use it as punctuation, not as filler |

## The variety rule

Three beats in a row on the **same family** is refused. The families the checker uses:

| family | members |
|---|---|
| live | `footage`, `image_to_video` — both are moving photographs |
| type | `kinetic_type`, `chart` — both are led by words or numbers |
| graphic | `motion_graphics`, `diagram` — both are drawn |

So `footage → image_to_video → footage` is still one family three times over. It will be refused, and it should be.

## Choosing

Ask these in order:

1. **Is the point of this beat a word?** → `kinetic_type`. The line *is* the image; do not put a clip behind it and call
   that a design.
2. **Is the point a number or a comparison?** → `chart`. Two bars prove a claim in half a second; a portrait never does.
3. **Is the point how something works, or what it is made of?** → `diagram` or `motion_graphics`.
4. **Is the point the object or the place itself?** → `footage` if it moves, `image_to_video` if you only have a still.
5. **Is the point the build of the brand itself?** → `motion_graphics`. A lockup assembling around the product *is* the
   product demo.

## Patterns that work

**The reveal ladder** — start wide and literal, end drawn and abstract:

```
footage → image_to_video → kinetic_type → motion_graphics
```

**The argument** — alternate claim and evidence, so the film never says the same thing twice in a row:

```
kinetic_type → chart → footage → diagram
```

**The portrait** — one subject, four ways of looking at it:

```
footage (wide) → image_to_video (close) → motion_graphics (its parts) → kinetic_type (its name)
```

## Patterns that fail

- **The caption film.** Every beat a clip with a line of text at the bottom. The text is doing all the work and nothing on
  screen is designed. This is the failure the checker exists for.
- **The slideshow.** Same medium, different pictures. Changing the picture is not changing the beat.
- **The texture film.** Every beat is an abstract dark shot because the footage was easy to generate. Beautiful, and it
  says nothing.
- **The empty diagram.** A `diagram` beat with no labels, or a `chart` with no numbers. Drawn is not the same as designed.

## Writing a beat that holds

Whatever the medium, a beat needs three things or it reads as filler:

- **a purpose** — the `why` line, in your own words, saying what the beat does for the viewer
- **a payoff** — what is different at the end of the beat than at the start
- **a support** — one secondary element that keeps the frame alive: a rule, a counter, a second layer, a small index label

A beat with a purpose but no payoff is a static frame. A beat with a payoff but no support is a diagram with a hole in it.
