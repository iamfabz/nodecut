// An Editor V1 film is a film NodeCut can play, even though it has no render.js.
//
// Reported from a real film: clicking "Chess Grandmaster" opened the renders list instead of the editor, while every
// other project opened the editor. Its page drew itself and had no render script, so scanning found no family and
// settled on "other" — and a project with no family is not offered a live preview at all. The agent checked the page
// had been written, the film played in a browser, and nothing looked wrong anywhere.
//
// These pin the two things that have to hold: the film is recognised from its page, and a page without the live hook
// is NOT claimed to be playable (a project that says it can play and then shows black is worse than one that says
// nothing).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PAGE = (hook) => `<!doctype html>
<html><head><style>
html,body{margin:0;background:#000;width:100%;height:100%}
#root{position:relative;width:1920px;height:1080px;overflow:hidden}
</style></head>
<body><div id="root"></div>
<script>
${hook ? [
  'window.__timelines = window.__timelines || {};',
  'window.__timelines["main"] = gsap.timeline({ paused: true });',
  'window.renderOut = function (t) { window.__timelines["main"].seek(t, false); };',
  'window.READY = true;',
].join('\n') : '// no live hook: this page only exists to be rendered'}
</script></body></html>`;

async function filmWithPage(hook) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ev1-scan-'));
  fs.writeFileSync(path.join(dir, 'index.html'), PAGE(hook));
  fs.writeFileSync(path.join(dir, 'out.mp4'), Buffer.alloc(1024));   // so the folder is listed as a project
  return dir;
}

// The scan walks the folders in Settings. The cheapest honest way to see what it decides is to ask it about the folder.
async function scanOne(dir) {
  const { renderInfo } = await import('./scan.js');
  return renderInfo(dir);
}

test('an Editor V1 page is a film NodeCut can play, not "other"', async () => {
  const dir = await filmWithPage(true);
  try {
    const ri = await scanOne(dir);
    // "other" is the value that made the project open onto its renders list
    assert.equal(ri.family, 'code');
    assert.equal(ri.script, 'index.html');
    assert.equal(ri.w, 1920);
    assert.equal(ri.h, 1080);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a page with no live hook is not called playable', async () => {
  const dir = await filmWithPage(false);
  try {
    const ri = await scanOne(dir);
    // no renderOut: it is a page, but not a live project, so the family must not be claimed from it
    assert.notEqual(ri.script, 'index.html');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a real render script still wins over the page', async () => {
  const dir = await filmWithPage(true);
  try {
    fs.writeFileSync(path.join(dir, 'render.js'),
      'const FPS = 30, CH = 60, VW = 1280, VH = 720;\n' +
      '// writes to chunks/\n' +
      'for (let i = 0; i < CH; i++) {}\n');
    const ri = await scanOne(dir);
    assert.equal(ri.family, 'A');           // chunked render: partial re-render stays possible
    assert.equal(ri.script, 'render.js');
    assert.equal(ri.w, 1280);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
