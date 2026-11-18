# Sound — music, voice, and effects in a film that is code

Picture is drawn from `t`; sound is a file the film plays. That difference causes most of the audio problems in this kind
of project, so the rules below are practical rather than aesthetic.

## The three layers

| layer | job | level |
|---|---|---|
| **voice** | carries meaning | the loudest thing; nothing competes with it |
| **music** | carries feeling | sits under the voice, and is the loudest thing when the voice is absent |
| **effects** | mark events | short, punchy, only where something happens |

If you cannot hear the voice on one listen at normal volume, the mix is wrong. That is the whole test.

## Levels

| element | target |
|---|---|
| overall mix | about **−16 LUFS** integrated for web |
| peak | **below −1 dB**, never clipping |
| music under speech | **−18 to −22 dB** relative, or low-cut rather than turned down |
| effects | loud enough to register once, never louder than the voice |

**Low-cut, do not turn down.** A bed that fights a voice is usually a low-end problem — the kick and the bass occupy the
same space as the voice. Filter the bed below ~150 Hz while the voice is speaking instead of lowering the whole thing, which
also loses the energy you wanted.

## The fade trap

Generated or licensed music often **fades out on its own tail**, or ends before the film does. If you use the file as it
arrives, the last beat can be silent.

Always measure before you trust a track:

```bash
ffmpeg -i music.mp3 -af "astats=metadata=1:reset=0" -f null - 2>&1 | tail -20
```

Check the RMS second by second. If the last 20% is falling away, cut the strong body out and loop it, with a short crossfade
at the seam rather than a butt join. Then fade the *result* yourself in the last second.

## Silence is a tool

- 1–3 s of quiet after a key line makes the line land.
- A beat with no music at all, in a film that has had music throughout, is the strongest accent available.
- Do not fill every gap. A bed that never stops is furniture.

## Effects

Place an effect where the **cut** is, not where the picture change is visible. The ear expects the sound to start a frame
before or exactly on the edit.

Effects that earn their place in a short film: one whoosh on a hard cut, one impact on a landing, one shimmer on a reveal,
one mechanical tick on a counter. Four is plenty for 20 seconds. Twenty is noise.

## Voice

- Write for the ear, not the page: short sentences, one clause each.
- Read time: about **150–160 words per minute** for narration; slower for a film, faster for social.
- Time the voice before the beats. If the line does not fit the beat, change the line.
- Leave the first 0.3 s clear so the first word is not clipped by a cut.

## Checking the mix

Before delivering, measure it rather than listening once:

1. **Per-second RMS** across the whole file. Look for sudden drops to silence — that is the fade trap, or a layer that
   failed to load.
2. **Peak** below −1 dB.
3. **A silent pass** — watch the film with the sound off. If the story survives, the picture is doing its job; if not, the
   voice is carrying everything and the visuals are decoration.

## In a code-drawn film

- The film's length and the audio's length must match. A render that is 20 s long and an audio file that is 18 s long ends
  in silence, and nobody notices until delivery.
- Keep one `mix.wav` that is the whole soundtrack. Building the mix in code each time makes every version slightly different.
- If the film has generated sound layers (music you can duck, stems you can mute), the mix is rebuilt at render time — so a
  change to a level changes the output, and the picture does not have to be re-rendered.
