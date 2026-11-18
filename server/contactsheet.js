// Contact sheet: N frames of a film in one labelled grid, so an agent (or a person) can see the edit instead of
// describing it. No render, no ffmpeg: the hub serves the live page, this script opens it in headless Chrome, calls
// window.renderOut(t) once per frame and draws the frames into a grid canvas inside the page. One PNG comes back.
//
//   node server/contactsheet.js '{"url":"http://127.0.0.1:7788/live/<id>/index.html","out":"…/snaps/x.png", …}'
//
// It also works on a `code`-family project that has no render script at all, because it only needs the live contract
// (docs/PROJECT-CONTRACT.md §2): window.renderOut(t) draws second t on the page's canvas and window.READY says when the
// assets are in. The frames are pure functions of t, so the sheet always matches a render of the same moments.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findBrowser } from './platform.js';
import { VHCRAFT } from '../engine-hooks/vhcraft.js';

const SELF = fileURLToPath(import.meta.url);
const BG = '#0d1013', FG = '#f2f4f6', DIM = '#8b939b';

// ---------- the page side: draw every frame into one grid canvas and hand back a PNG data URL
function compose(cfg) {
  return new Promise((resolve) => {
    try {
      if (typeof window.renderOut !== 'function') return resolve({ error: 'the page does not define window.renderOut(t)' });
      const cvs = [...document.querySelectorAll('canvas')];
      const src = document.getElementById('c') || cvs.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (!src || !src.width || !src.height) return resolve({ error: 'the page has no canvas with a picture on it' });
      const sw = src.width, sh = src.height;
      const cellW = cfg.cellW, cellH = Math.max(1, Math.round(cellW * sh / sw));
      const gap = cfg.gap, head = cfg.head, cols = cfg.cols, rows = Math.ceil(cfg.times.length / cols);
      const W = cols * cellW + (cols + 1) * gap, H = head + rows * cellH + (rows + 1) * gap;
      const sheet = document.createElement('canvas'); sheet.width = W; sheet.height = H;
      const g = sheet.getContext('2d');
      const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      const sans = 'system-ui, -apple-system, "Segoe UI", sans-serif';
      g.fillStyle = cfg.bg; g.fillRect(0, 0, W, H);
      g.textBaseline = 'middle';
      g.fillStyle = cfg.fg; g.font = `600 ${Math.round(head * 0.44)}px ${sans}`; g.textAlign = 'left';
      g.fillText(cfg.title, gap, head / 2);
      if (cfg.note) { g.font = `${Math.round(head * 0.36)}px ${mono}`; g.fillStyle = cfg.dim; g.textAlign = 'right'; g.fillText(cfg.note, W - gap, head / 2); }
      const errs = [];
      // What the frames actually contain, read from the source canvas (not from the sheet, whose timecode chips would
      // hide an empty film): a 32x18 downscale per frame gives a cheap "is there a picture" and "is it frozen" answer.
      let probe = null, firstSig = null, same = true, lo = 255, hi = 0, probes = 0;
      const sample = () => {
        if (!probe) { probe = document.createElement('canvas'); probe.width = 32; probe.height = 18; }
        const pg = probe.getContext('2d');
        pg.clearRect(0, 0, 32, 18); pg.drawImage(src, 0, 0, 32, 18);
        const d = pg.getImageData(0, 0, 32, 18).data;
        probes++;
        for (let k = 0; k < d.length; k += 4) { const l = (d[k] * 0.299 + d[k + 1] * 0.587 + d[k + 2] * 0.114) | 0; if (l < lo) lo = l; if (l > hi) hi = l; }
        if (!firstSig) firstSig = d;
        else {
          let sum = 0;
          for (let k = 0; k < d.length; k += 4) sum += Math.abs(d[k] - firstSig[k]) + Math.abs(d[k + 1] - firstSig[k + 1]) + Math.abs(d[k + 2] - firstSig[k + 2]);
          if (sum / (d.length / 4 * 3) >= 2) same = false;
        }
      };
      cfg.times.forEach((t, i) => {
        const x = gap + (i % cols) * (cellW + gap), y = head + gap + Math.floor(i / cols) * (cellH + gap);
        let err = null;
        // same task as the drawImage: a WebGL canvas still holds its pixels here, and a 2D one always does
        try { window.renderOut(t); } catch (e) { err = String((e && e.message) || e); errs.push('t=' + t + ': ' + err); }
        try { sample(); } catch { }
        try { g.drawImage(src, x, y, cellW, cellH); } catch (e) { errs.push('draw at t=' + t + ': ' + ((e && e.message) || e)); }
        if (err) { g.fillStyle = 'rgba(140,24,24,.9)'; g.fillRect(x, y, cellW, cellH); }
        const chip = Math.round(cellH * 0.13), pad = Math.round(chip * 0.4);
        g.fillStyle = 'rgba(0,0,0,.66)'; g.fillRect(x, y + cellH - chip, cellW, chip);
        g.fillStyle = err ? '#ffd7d7' : '#ffffff';
        g.font = `${Math.round(chip * 0.55)}px ${mono}`; g.textBaseline = 'middle'; g.textAlign = 'left';
        g.fillText(cfg.labels[i], x + pad, y + cellH - chip / 2 + 1);
        if (err) { g.textAlign = 'right'; g.fillText('renderOut(t) threw', x + cellW - pad, y + cellH - chip / 2 + 1); }
      });
      resolve({ data: sheet.toDataURL('image/png'), w: W, h: H, cellW, cellH, srcW: sw, srcH: sh, rows, errs,
        spread: probes ? hi - lo : 0, frozen: probes > 1 && same });
    } catch (e) { resolve({ error: String((e && e.stack) || e) }); }
  });
}

// evenly spaced moments that never land exactly on the end of the film (t = dur is one past the last frame)
export function defaultTimes(dur, count) {
  const c = Math.round(+count);
  const n = Math.min(48, c > 0 ? c : 12), d = Math.max(0.001, +dur || 0);
  return Array.from({ length: n }, (_, i) => +((d * (i + 0.5)) / n).toFixed(3));
}

// ---------- the sheet itself
export async function makeSheet(opts = {}) {
  const t0 = Date.now();
  const times = (Array.isArray(opts.times) && opts.times.length ? opts.times : defaultTimes(opts.dur, opts.count))
    .map(t => +t).filter(t => Number.isFinite(t) && t >= 0).slice(0, 48);
  if (!times.length) throw Object.assign(new Error('no times to make a contact sheet from'), { code: 400 });
  if (!opts.url) throw Object.assign(new Error('makeSheet needs the live page url'), { code: 400 });
  if (!opts.out) throw Object.assign(new Error('makeSheet needs an output file'), { code: 400 });
  const cols = Math.max(1, Math.min(8, Math.round(opts.cols) || 4));
  const cellW = Math.max(120, Math.min(960, Math.round(opts.cellW) || 480));
  const fps = +opts.fps || 30;
  const exe = opts.browser || process.env.NODECUT_BROWSER || findBrowser().path;
  if (!exe) throw Object.assign(new Error('No Chrome, Edge or Chromium found to make a contact sheet (set NODECUT_BROWSER).'), { code: 400 });

  const browser = await puppeteer.launch({
    executablePath: exe, headless: 'new', protocolTimeout: 0,
    args: ['--allow-file-access-from-files', '--force-device-scale-factor=1', '--hide-scrollbars', '--disable-accelerated-2d-canvas'],
  });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e.message || e).slice(0, 300)));
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.waitForFunction('window.READY === true', { timeout: opts.readyMs || 120000 });
    } catch {
      const why = pageErrors.length ? ' Page errors: ' + [...new Set(pageErrors)].slice(0, 3).join(' · ') : '';
      throw Object.assign(new Error('The page never set window.READY = true, so the contact sheet cannot be trusted.' + why), { code: 400 });
    }
    const labels = times.map(t => `t=${t.toFixed(2)}s  ${VHCRAFT.tc(t, fps)}`);
    const r = await page.evaluate(compose, {
      times, labels, cols, cellW, gap: opts.gap ?? 8, head: Math.max(28, Math.round(cellW * 0.1)),
      bg: BG, fg: FG, dim: DIM, title: opts.title || '', note: opts.note || '',
    });
    if (r.error) throw Object.assign(new Error(r.error), { code: 400 });
    if (r.spread < 3) throw Object.assign(new Error('Every frame came out one flat colour: the page draws on another canvas, or window.renderOut(t) does nothing for these moments.'), { code: 400 });
    const png = Buffer.from(String(r.data).split(',')[1] || '', 'base64');
    if (png.length < 1000) throw Object.assign(new Error('the page returned an empty picture'), { code: 400 });
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, png);
    return { ok: true, file: opts.out, w: r.w, h: r.h, cols, rows: r.rows, cellW: r.cellW, cellH: r.cellH, srcW: r.srcW, srcH: r.srcH,
      times, errors: r.errs || [], frozen: !!r.frozen, pageErrors: [...new Set(pageErrors)].slice(0, 5), ms: Date.now() - t0 };
  } finally { try { await browser.close(); } catch { } }
}

// ---------- the hub side: POST /api/contactsheet, spawned as its own process so a stuck browser cannot hold the hub
const THUMB = /^contact-sheet-[\w.-]+\.png$/;
function prune(dir, keep = 12) {
  let list = [];
  try { list = fs.readdirSync(dir).filter(f => THUMB.test(f)).map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m); } catch { return; }
  for (const old of list.slice(keep)) { try { fs.unlinkSync(path.join(dir, old.f)); } catch { } }
}

export function routes(route, project, live, port) {
  route('POST', '/api/contactsheet', async (req) => {
    const body = await readJson(req);
    const p = project(body.id);
    if (!p) throw Object.assign(new Error('project not found'), { code: 404 });
    if (p.studio) throw Object.assign(new Error('A 3D studio scene has no contact sheet yet: open its live preview (hub_live) and look there.'), { code: 400 });
    if (p.group || p.rootType === 'media') throw Object.assign(new Error('A folder of finished videos has nothing to draw: this works on films written as code.'), { code: 400 });
    const li = await live.liveInfo(p);
    if (!li.ok) throw Object.assign(new Error(li.reason), { code: 400 });
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const out = path.join(p.path, 'snaps', `contact-sheet-${stamp}.png`);
    const payload = {
      url: `http://127.0.0.1:${port}${li.url}`, out,
      times: Array.isArray(body.times) && body.times.length ? body.times : undefined,
      count: body.count, cols: body.cols, cellW: body.cellW, dur: li.dur, fps: li.fps,
      title: `${p.title}`, note: `${li.fps} fps · ${VHCRAFT.tc(li.dur, li.fps)} · ${li.w}×${li.h}`,
    };
    const r = await runChild(payload, body.timeoutMs || 180000);
    if (!r.ok) throw Object.assign(new Error(r.error || 'the contact sheet failed'), { code: 400 });
    prune(path.join(p.path, 'snaps'));
    return { ...r, url: '/media?p=' + encodeURIComponent(out), project: p.id, dur: li.dur, durFrom: li.durFrom, liveUrl: li.url };
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const bufs = []; let n = 0;
    req.on('data', b => { n += b.length; if (n > 1 << 20) { reject(new Error('too large')); req.destroy(); } else bufs.push(b); });
    req.on('end', () => { try { resolve(bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf8')) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// one child per request: a browser that hangs is killed, and the hub keeps serving
function runChild(payload, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, JSON.stringify(payload)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '', done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { } finish({ ok: false, error: `the contact sheet took longer than ${Math.round(timeoutMs / 1000)} s and was stopped` }); }, timeoutMs);
    child.stdout.on('data', b => { out += b; if (out.length > 4 << 20) out = out.slice(-(1 << 20)); });
    child.stderr.on('data', b => { err += b; if (err.length > 20000) err = err.slice(-8000); });
    child.on('error', e => finish({ ok: false, error: e.message }));
    child.on('close', code => {
      const line = out.trim().split('\n').filter(Boolean).pop();
      let j = null; try { j = JSON.parse(line); } catch { }
      if (j) return finish(j);
      finish({ ok: false, error: err.trim().split('\n').filter(Boolean).slice(-3).join(' · ') || `the contact sheet exited (code ${code})` });
    });
  });
}

// ---------- CLI: the hub runs this file, and a person can run it by hand
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(SELF).href) {
  let args; try { args = JSON.parse(process.argv[2] || '{}'); } catch (e) { console.error('bad json argument'); process.exit(2); }
  makeSheet(args).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(String(e.message || e)); process.exit(1); });
}
