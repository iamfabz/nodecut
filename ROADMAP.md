# Roadmap

What NodeCut is working toward. This is a direction, not a contract — things move, and some ideas get dropped when
they turn out to be bad ideas. If any of it excites you, see [CONTRIBUTING.md](CONTRIBUTING.md): a lot of these are
good first projects.

Everything below is open work. Nothing here is promised for a version or a date.

## The headline

Four features that change what NodeCut is. Today it starts from a plan and writes the film. These start from a
**recording** — yours, a client's, or one you just shot on a phone — and take it to a finished film that you can keep
directing afterwards. That is a much bigger audience, and it is the direction the app is going.

They are listed here in the order they make sense: you cannot polish footage you have not got in, you cannot transcribe
audio you have not captured, and you cannot keep directing a film the app cannot remember.

- [ ] **Build a film end to end, then keep editing it with what you add.** The whole loop in one place: describe the
      film, let it plan and build, then keep changing one thing at a time — a note, a still, a line of new direction —
      and have the whole film follow, without anything it already decided quietly reverting. The parts exist (brief,
      plan, build, notes with the frame and a close-up). What does not exist is **continuity**: the app has no memory of
      what was settled earlier, so an edit late in a film can undo a decision made in scene two and nothing notices.
      This is the feature that makes the app feel like a collaborator rather than a generator. See
      [#16](https://github.com/iamfabz/nodecut/issues/16).
- [ ] **Record into the studio from another device.** Display a QR code, scan it with a phone, and shoot straight into
      the project. Works for camera and for microphone. Local machine capture where a mic exists. See
      [#13](https://github.com/iamfabz/nodecut/issues/13) for camera and
      [#14](https://github.com/iamfabz/nodecut/issues/14) for audio.
- [ ] **Ingest a finished recording and rebuild it as a film.** Take a video someone already shot, transcribe it, and
      produce a NodeCut film that is the same content made well: tighter cuts, real typography, subtle motion, sound
      that sits right. This is the biggest single feature on the roadmap and the most valuable. See
      [#12](https://github.com/iamfabz/nodecut/issues/12).
- [ ] **Transcribe anything that has audio.** The building block under both of the above, and useful on its own. Note
      that NodeCut already *consumes* a transcript (`words.json` or an `.srt`, see `server/transcript.js`) to place
      notes and sentence timings. What is missing is producing one from a media file without an API key. See
      [#15](https://github.com/iamfabz/nodecut/issues/15).

## Nearby

The next things worth doing, roughly in the order they make NodeCut better.

- [ ] **Linux and macOS on real machines.** They work and are tested, but no one has finished a film on them yet
      (see [docs/PLATFORMS.md](docs/PLATFORMS.md)). Rundown of every gap: folder dialogs, trash, notifications,
      render priority, encoder probing. The most valuable contribution here is a bug report with your distro and the
      exact error.
- [ ] **A macOS `.app` bundle.** Right now macOS gets a `NodeCut.command` file. It works, but it looks unfinished in
      the Dock and in Finder.
- [ ] **Subtitles without re-rendering.** Burned-in captions already come out of the film code. The ask is an export
      that writes a `.srt` from the same timing, so a film can ship with soft captions too.
- [ ] **Contact sheet for a whole film at a glance.** The contact sheet exists. It should also answer "which scenes
      still have no still, no note, no render?"
- [ ] **A cheaper partial re-render.** Re-rendering only the chunks your notes touched is the best thing in the app
      and it still over-renders when a note moves something early in the film that echoes later.

## Wanted

Real features, not yet designed. These need a conversation before code.

- [ ] **Batch render.** Queue several films at once and walk away, instead of one film and one queue at a time.
- [ ] **Beat detection on the timeline.** Give the timeline real beat marks from the film's own music, so scene
      cuts and text chips can snap to them instead of to the grid.
- [ ] **A second agent.** The ◈ Agent tab speaks OpenCode. Claude Code is already integrated for making films; the tab
      should offer it too, and say which one is answering.
- [ ] **Film templates that are not hello-test.** A few starting points that pass the slideshow gate on their own: a
      title card, a product beat, a talking-head cutaway. Right now the only example is deliberately minimal.
- [ ] **Cheaper stills.** Generated stills and clips go through whatever model you configured. A cache keyed by prompt
      and seed would stop paying twice for the same picture.
- [ ] **Export a film to a shareable project.** A single file that carries the film, its stills, its notes and its
      craft decisions, so someone else can open it and pick up the work.

## Someday

Ideas worth keeping, not worth committing to.

- [ ] **Vertical and square films** — the studio is 16:9 end to end. Social formats need the preview, the outline grid
      and the render sizes to all agree on a second aspect.
- [ ] **Collaboration.** Two people on one film would mean merging scene files and notes instead of one workspace.
      That is a big design change, not a feature.
- [ ] **A plugin surface for encoders** without editing the render pipeline.
- [ ] **A keyboard-complete editor.** The shortcuts are good. Someone who never touches the mouse should be able to
      make a whole film.
- [ ] **Characters that stay the same across scenes, and animate.** The gap that stops NodeCut making a film with a
      person in it. Today there is no identity lock: a generated still in scene one and a generated still in scene nine
      are two unrelated pictures of two unrelated people, and a checked plan cannot tell. Doing this properly means a
      character definition the film can refer to by name, a way to keep a face, build and wardrobe stable when a still
      or clip is generated, and a rig that can be posed and animated rather than a picture that is swapped.

      Worth being blunt about the cost: character animation is a different discipline from motion graphics, and the
      architecture pushes against parts of it. A film is a pure function of `t`, which rules out the stateful
      frame-to-frame simulation most rigs assume. That is not a reason never to do it, but it does mean this is the one
      item here that could take months rather than weeks, and it should not be started until the recording and rebuild
      work has proved the app can carry a real film end to end. **Further out than anything else on this page, and
      least urgent** — NodeCut is a camera-and-edit tool today, and it is a good one. See
      [#17](https://github.com/iamfabz/nodecut/issues/17).

## Done

Kept here so the roadmap has a floor. Each of these shipped.

- [x] Partial re-render: only the chunks your notes touched
- [x] Three output qualities, each with an estimate from this film's real timings
- [x] Notes pinned to exact frames, with a drawing and a close-up sent to the agent
- [x] The slideshow gate and the plan checker's seven dimensions
- [x] Live preview that is a pure function of `t`
- [x] Render protection: slow down, pause, or stop without cross-platform guesswork
- [x] Scene outline with real thumbnails
- [x] Asset thumbnails for stills and clips
- [x] MCP tools and a CLI so an agent can drive the studio from a shell

## How to push on this

- **Propose a change to the list** by opening an issue titled `Roadmap: <the idea>` and saying what it would unlock.
- **Take something on** by commenting on its issue. Say which bullet you mean, so two people do not start the same one.
- **Disagree** in the issue. A roadmap that nobody argues with is usually a roadmap nobody read.

Issues labelled `good first issue` are picked specifically because they are small, self-contained and do not need the
whole app in your head. Issues labelled `help wanted` are ones where a second pair of hands genuinely decides whether
they happen.
