# Mediums — what each beat is made of

The single biggest decision in a short film, and the one most often left to habit. If you do not choose a medium per beat,
every beat becomes the same thing: a clip with a caption on it. That is what makes a film look generated.

## The set

`plan.json` allows exactly these, and the checker knows which ones feel different from each other:

| medium | best when | watch out |
|---|---|---|
| `footage` | the subject is real and the camera is the point | needs real motion; a still shot held for 3 s is a photograph |
| `image_to_video` | you have a still and want one move on it | generated clips come from a still you already made; use it when the picture is right but dead |
| `text_to_video` | the beat needs a thing that cannot be drawn or typed | costs money per clip. Not a background. Only for a beat whose whole point is the thing moving |
| `kinetic_type` | **the words are the idea** | only if the line is short enough to read once |
| `motion_graphics` | you need to show how something is built, assembled or measured | hand-drawn, so it must be designed rather than defaulted |
| `diagram` | the subject is a process, a structure or a set of parts | needs labels or it is decoration |
| `chart` | you are making a numeric claim | a bar with no number is an illustration, not an argument |
| `none` | a deliberate black frame or a pure-light beat | rare; use it as punctuation, not as filler |

## The variety rule

Three beats in a row on the **same family** is refused. The families the checker uses:

| family | members |
|---|---|
| live | `footage`, `image_to_video`, `text_to_video` — all are moving photographs |
| type | `kinetic_type`, `chart` — both are led by words or numbers |
| graphic | `motion_graphics`, `diagram` — both are drawn |

So `footage → text_to_video → image_to_video` is still one family three times over. It will be refused, and it should be.
Generated clips do not count as variety: alternating two machine-made clips is the machine version of the caption film.

## Choosing a generated clip, and when not to

Most beats do not need one. A beat earns `text_to_video` because **nothing drawn could show it**: the sizzle in the pan, the
steam off the bowl, water going over the edge, a hand lifting the lid. If the beat would work as a diagram, a chart or a
line of type, it is not a clip beat — and a clip on it makes the film look bought rather than made.

Ask, in this order:

1. **Could I draw this?** → yes, then do not generate it. Draw it.
2. **Is the point a word or a number?** → then it is `kinetic_type` or `chart`, and a clip behind it is a caption film.
3. **Is there a real thing moving that carries the idea?** → `text_to_video`, and be specific enough that the shot could be
   filmed: what it is, what it is doing, where the camera is, how light falls.
4. **Do I already have the still?** → `image_to_video`, and describe the motion only: the camera move and what changes.

Two clips is usually the most a fifteen- to thirty-second film needs. Three is the ceiling before it stops being a
designed film and becomes a stock-footage montage.

**Cost:** each clip is about two cents and about five seconds. The planner prices the whole plan before anything is
generated and says so in the summary. If the plan is refused on cost, the fix is fewer clip beats, not cheaper ones.

## Choosing

Ask these in order:

1. **Is the point of this beat a word?** → `kinetic_type`. The line *is* the image; do not put a clip behind it and call
   that a design.
2. **Is the point a number or a comparison?** → `chart`. Two bars prove a claim in half a second; a portrait never does.
3. **Is the point how something works, or what it is made of?** → `diagram` or `motion_graphics`.
4. **Is the point something real moving — heat, steam, liquid, a hand, a place?** → `text_to_video` if you would have to
   film it, `image_to_video` if you already have the still. See *Choosing a generated clip* above.
5. **Is the point the object or the place itself?** → `footage` if you have it, `text_to_video` if you do not.
6. **Is the point the build of the brand itself?** → `motion_graphics`. A lockup assembling around the product *is* the
   product demo.

## Patterns that work

**The reveal ladder** — start literal, then draw, then type, and never two moving photographs in a row:

```
text_to_video → diagram → kinetic_type → motion_graphics
```

**The argument** — alternate claim and evidence, so the film never says the same thing twice in a row:

```
kinetic_type → chart → text_to_video → diagram
```

**The portrait** — one subject, four ways of looking at it (the two clips are separated by a drawn beat, because beside
each other they are one medium):

```
text_to_video (wide) → motion_graphics (its parts) → image_to_video (close) → kinetic_type (its name)
```

**The recipe** — a real thing shown, then explained in a drawing, then named in type:

```
text_to_video (the action) → diagram (why it works) → kinetic_type (the rule)
```

## Patterns that fail

- **The caption film.** Every beat a clip with a line of text at the bottom. The text is doing all the work and nothing on
  screen is designed. This is the failure the checker exists for.
- **The montage.** Three or more generated clips in a row, or a film that alternates clips to look varied. Generated clips
  are all the same family on purpose: the picture changes, the film does not.
- **The stock-film.** Every beat `text_to_video` because it was one tool call. Every clip is plausible and none of them is
  about anything.
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
