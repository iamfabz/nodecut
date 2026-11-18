# Camera — the one line of intent per beat, and the words for it

A beat with no camera intent is a frame. A beat with a bad one is a shot that drifts for no reason. The line is short on
purpose: it tells you, and any tool that generates media for you, what the camera is doing and why.

## The intent line

One line, concrete, no mood adjectives:

```
slow push in, deep focus
static, shallow focus on the label
slow drift right, wide
handheld, tracking the subject
locked off, hard light from the left
```

Not:

```
cinematic and emotional
dynamic movement
beautifully lit
```

Those are not instructions; they are compliments.

## The vocabulary

Five parts. Every camera line is some subset of these, in this order, separated by commas.

**1. Shot size**

`extreme wide` · `wide` · `medium wide` · `medium` · `medium close` · `close` · `extreme close` · `macro`

**2. Subject motion**

`still` · `slow turn` · `drift` · `walk` · `pour` · `fall` · `rise`

**3. Scene / setting**

`field at dawn` · `studio void` · `table top` · `workshop bench` · `night exterior`

**4. Spatial framing**

`centred` · `off-centre left` · `low angle` · `high angle` · `eye level` · `overhead flat lay`

**5. Camera**

`static` · `slow push in` · `slow pull out` · `drift left/right` · `rise` · `orbit` · `handheld` · `whip pan`

## What each moved in a film

| move | reads as |
|---|---|
| push in | concentration, the subject matters |
| pull out | reveal, context, ending |
| drift | observation, calm |
| orbit | the object is worth circling; product shots |
| rise | scale, arrival |
| handheld | urgency, realism |
| static | confidence, design; but only with something alive inside the frame |
| whip pan | a cut, not a shot — use once |

## Movement must have a reason

The checker scores `weak_motion`: a beat that moves but cannot say why is penalised as much as one that does not move. So
the `why` line and the camera line should agree.

- "slow push to make the claim land" — the movement is doing work.
- "slow push" alone — that is a default, not a decision.

If a beat is static, give it a reason to be static: *held, so the type carries it.* A locked-off shot with great type is
stronger than a drifting shot with weak type.

## Generated footage

Models produce very little motion, even when asked. Plan for it:

- Ask for the move in the prompt, then **add the camera move in code** anyway — a slow scale over the beat, a lateral drift.
  The coded move is smooth, free, and exactly what you asked for.
- Alternate the direction between consecutive beats (drift right, then left) so the film pulls against itself instead of
  marching.
- Clips often fade out or freeze on their last frames. Play their strong middle, not their tail.
- Do not ask for "steam", "smoke" or "vapour" unless it is the point. Models add it readily and it makes a dry product look
  like it is on fire.
- Beware symmetry: a generated wide shot can come back mirrored, and a mirrored subject reads as two of them.

## Framing rules

- Keep the copy zone clear. If the words sit in the lower third, the camera move should not push the subject into them.
- A subject dead centre is a portrait; a subject on a third is a scene. Choose.
- Never let a drawn frame, ring or rule in code sit *on* the product. If you add a graphic overlay, keep it outside the
  object's silhouette — a ring drawn over a jar reads as a crop, not as a frame.
- Leave room where the type will go. A shot that fills the frame leaves nowhere to put the line.
