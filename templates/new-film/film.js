// A new film, written as code. Start here; see docs/PROJECT-CONTRACT.md (NodeCut folder) for the rules.
//
//   window.renderOut(t)  must draw second t of the film synchronously on the fixed-size canvas (#c, 1920x1080)
//   window.READY = true  once every asset is loaded (images, fonts, …)
//   window.VH_SCENES     the film's scenes [{name, t0, t1}] — they show up on NodeCut's timeline
//
// Golden rule: the picture is a pure function of t (no Date.now(), no state carried from frame to frame, no unseeded
// Math.random()). Then the live preview can jump anywhere, frame stepping works, and a partial re-render of one chunk
// matches its neighbours exactly.
//
// The craft library (engine-hooks/vhcraft.js — 22 easing curves, keyframe tracks, beat pulses, crossfade/wipe/slide/iris,
// scrim/vignette/grain/letterbox, captions and kinetic type) is served next to any film by NodeCut itself, so you can
// use it without copying it in. Everything in it obeys the golden rule.
(function () {
  'use strict';
  const W = 1920, H = 1080;
  const DUR = 15;                      // keep in step with render.env.DUR (hub_project) and the length of audio/mix.wav
  const cv = document.getElementById('c'), g = cv.getContext('2d');

  const SCENES = [
    { name: 'Opening', t0: 0, t1: 5 },
    { name: 'Moving beat', t0: 5, t1: 10 },
    { name: 'Ending', t0: 10, t1: DUR },
  ];
  window.VH_SCENES = SCENES;

  // ---- assets: load everything before READY (example: const img = await loadImage('assets/logo.png'))
  const loadImage = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });

  // The craft library. Opened inside NodeCut it always loads; opened as a bare file:// page it may not, so the two
  // helpers used below have a plain fallback and the film runs either way.
  const loadCraft = async () => { try { return (await import('./vhcraft.js')).VHCRAFT; } catch { return null; } };
  // Generated clips (NodeCut's gen/ folder) are sprite atlases, drawn one cell per moment: still a pure function of t.
  // A film with none is the normal case, so GEN is empty and the beat below draws its fallback panel instead.
  let GEN = new Map();
  const loadGen = async () => {
    try {
      const { VIHATLAS } = await import('./vhatlas.js');
      GEN = await VIHATLAS.load('./gen/atlas');
    } catch { }
  };

  // ---- an image-to-video beat, written the way a real one is built --------------------------------
  //
  // A clip is a plate you generated and then animated, so the beat works in two states and the film never breaks:
  //
  //   CLIP_ID is an atlas id in the film's gen/ folder. Make one with hub_generate_still (the plate), then
  //   hub_generate_clip with that still's id (the motion), and GEN.get(CLIP_ID) draws it here.
  //
  //   With no clip baked yet the beat still draws a designed panel, not a black frame, so the film is watchable while
  //   the clip is being made and a failed bake is a panel rather than a hole.
  //
  // The clip's own second is (film time - where the beat starts): the shot plays from its first frame every time the
  // film is scrubbed back to this beat. Nothing is stored between frames — the picture stays a pure function of t.
  const CLIP_ID = '';                  // e.g. 'clip_0007': the atlas id hub_gen_list reports
  const CLIP_IN = 5;                   // where the moving beat starts, in film time
  function moving(t, C) {
    const s = t - CLIP_IN;
    const clip = CLIP_ID ? GEN.get(CLIP_ID) : null;
    // The clip is drawn through a slow push of this film's own. A generated shot arrives with a small move already;
    // adding the beat's own scale makes it belong to the film instead of looking pasted in, and it costs one transform.
    const push = 1 + Math.min(0.06, Math.max(0, s) * 0.012);
    if (clip) {
      g.save();
      g.translate(W / 2, H / 2); g.scale(push, push); g.translate(-W / 2, -H / 2);
      clip.drawFit(g, s, 0, 0, W, H, 'cover');
      g.restore();
    } else {
      g.fillStyle = '#0e1118'; g.fillRect(0, 0, W, H);
      const k = C ? C.ease('outCubic', Math.min(1, Math.max(0, s) / 0.8)) : Math.min(1, Math.max(0, s) / 0.8);
      g.save();
      g.translate(W / 2, H / 2); g.scale(push, push); g.translate(-W / 2, -H / 2);
      g.globalAlpha = 0.16 + 0.06 * k; g.fillStyle = '#ff7a3d';
      g.beginPath(); g.arc(W / 2, H / 2, 240 + k * 30, 0, Math.PI * 2); g.fill();
      g.restore();
      g.globalAlpha = 1;
    }
    if (C) C.vignette(g, W, H, { amount: 0.3 });
  }

  function opening(t, C) {
    g.fillStyle = '#101320'; g.fillRect(0, 0, W, H);
    const k = C ? C.ease('outCubic', t / 0.8) : Math.min(1, t / 0.8);
    g.globalAlpha = k;
    g.fillStyle = '#f3efe6'; g.font = '800 120px "Segoe UI", system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('Your film starts here', W / 2, H / 2 - (1 - k) * 40);
    g.globalAlpha = 1;
  }
  function ending(t, C) {
    const s = t - 10;
    g.fillStyle = '#ff7a3d'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#101320'; g.font = '700 90px "Segoe UI", system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('The end', W / 2, H / 2 + Math.sin(s * 2) * 10);
    if (C) C.vignette(g, W, H, { amount: 0.35 });   // a free look: dark edges, no extra code per frame
  }

  window.renderOut = function (t) {
    t = Math.max(0, Math.min(DUR, +t || 0));
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    const C = window.VHCRAFT;
    if (t < 5) opening(t, C); else if (t < 10) moving(t, C); else ending(t, C);
  };

  (async () => {
    // await loadImage(...), document.fonts.load('700 90px MyFont'), …
    await loadCraft();
    await loadGen();
    await document.fonts.ready;
    window.renderOut(0);
    window.READY = true;
  })();
})();
