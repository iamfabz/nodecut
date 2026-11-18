# Craft — the reference NodeCut's agent reads before planning a film

These files are NodeCut's own. They are short on purpose: a planning agent reads two or three of them, not twenty.

They cover the decisions that make a film look designed rather than generated. Where a rule of thumb comes from a
public source, the source is named — that is a citation, not a copy. Nothing here is reproduced from another project.

## Read in this order

| file | when |
|---|---|
| [`routing.md`](routing.md) | **always first.** Brief → which pipeline fits and which files below to read |
| [`pacing.md`](pacing.md) | any film with more than three beats: how long a shot holds, how often something changes |
| [`mediums.md`](mediums.md) | choosing what each beat is *made of* — the single biggest decision in the film |
| [`story.md`](story.md) | a film that has to explain something, or persuade |
| [`type.md`](type.md) | any film with words on screen |
| [`sound.md`](sound.md) | any film with music or voice |
| [`camera.md`](camera.md) | writing the one-line camera intent per beat, and the vocabulary for generated footage |
| [`taste.md`](taste.md) | committing to a look, and writing the "do not use" list |
| [`review.md`](review.md) | scoring your own work before the user sees it |
| [`formats.md`](formats.md) | 9:16 social, 16:9 film, and what each one changes |

## The rule underneath all of them

A film is code that draws every frame from `t`. So anything that cannot be drawn deterministically — a clock, an unseeded
random, state carried between frames — is out. Practical consequence: **the motion must be designed, not improvised.** If
a beat looks alive, somebody chose the curve, the timing and the hand-off.

## Provenance

These notes are informed by the director workflow published in [OpenMontage](https://github.com/alfredfrancis/OpenMontage)
(AGPL-3.0), which in turn draws on public craft writing: Kurzgesagt's production notes, 3Blue1Brown's technique videos,
Richard Mayer's multimedia learning principles, Walter Murch's editing theory. Where a rule came from one of those, it is
attributed there. No text from OpenMontage is reproduced here; this is a restatement of the ideas in NodeCut's terms.
