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
  const DUR = 10;                      // keep in step with render.env.DUR (hub_project) and the length of audio/mix.wav
  const cv = document.getElementById('c'), g = cv.getContext('2d');

  const SCENES = [
    { name: 'Opening', t0: 0, t1: 5 },
    { name: 'Ending', t0: 5, t1: DUR },
  ];
  window.VH_SCENES = SCENES;

  // ---- assets: load everything before READY (example: const img = await loadImage('assets/logo.png'))
  const loadImage = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });

  // The craft library. Opened inside NodeCut it always loads; opened as a bare file:// page it may not, so the two
  // helpers used below have a plain fallback and the film runs either way.
  const loadCraft = async () => { try { return (await import('./vhcraft.js')).VHCRAFT; } catch { return null; } };
  // Generated clips (NodeCut's gen/ folder) are sprite atlases, drawn one cell per moment: still a pure function of t.
  // A film with none is the normal case, so GEN is empty and the examples above just do not draw it.
  let GEN = new Map();
  const loadGen = async () => {
    try {
      const { VIHATLAS } = await import('./vhatlas.js');
      GEN = await VIHATLAS.load('./gen/atlas');
    } catch { }
  };

  function opening(t, C) {
    g.fillStyle = '#101320'; g.fillRect(0, 0, W, H);
    const k = C ? C.ease('outCubic', t / 0.8) : Math.min(1, t / 0.8);
    g.globalAlpha = k;
    g.fillStyle = '#f3efe6'; g.font = '800 120px "Segoe UI", system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('Your film starts here', W / 2, H / 2 - (1 - k) * 40);
    g.globalAlpha = 1;
  }
  function ending(t, C) {
    const s = t - 5;
    g.fillStyle = '#ff7a3d'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#101320'; g.font = '700 90px "Segoe UI", system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('The end', W / 2, H / 2 + Math.sin(s * 2) * 10);
    if (C) C.vignette(g, W, H, { amount: 0.35 });   // a free look: dark edges, no extra code per frame
    // A clip from NodeCut's gen/ folder, if the film has one (hub_gen_import bakes it into an atlas):
    //   const clip = GEN.get('<the id from gen/gen.json>');
    //   if (clip) clip.drawFit(g, s, 0, 0, W, H, 'cover');   // s = the clip's own second
  }

  window.renderOut = function (t) {
    t = Math.max(0, Math.min(DUR, +t || 0));
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (t < 5) opening(t, window.VHCRAFT); else ending(t, window.VHCRAFT);
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
