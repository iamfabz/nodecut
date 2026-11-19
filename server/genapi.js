// Model-made media: text→image plates (DeepInfra) and image→video clips (OpenRouter), then the same bake gen.js already
// does offline. This file is only ever reached when the user turned generation on in Settings and pressed Generate; the
// import half in gen.js works with none of it.
//
// Why it is shaped this way
// - t2i is one request. DeepInfra's OpenAI-style endpoint returns base64 in the response, so there is no temp URL to
//   download before it expires and no second failure mode.
// - i2v is asynchronous everywhere: submit, poll for minutes, then download. That cannot live inside an HTTP request the
//   UI is waiting on, so a job is written to gen/gen.json as `state: "running"` and a poller fills it in.
// - OpenRouter fetches the starting frame itself, so a local still has to be reachable from the internet for the length
//   of one request. NodeCut answers that with a short-lived tunnel that is closed as soon as the job is accepted.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, saveConfig } from './config.js';
import { DATA_DIR } from './util.js';
import { add, fail, get, newId, plateDir, clipDir, rel, bakeClip, readAtlas, place, PLATE_DIR, CLIP_DIR, ATLAS_DIR } from './gen.js';

export const DEEPINFRA = 'https://api.deepinfra.com/v1/openai/images/generations';
export const OPENROUTER_VIDEOS = 'https://openrouter.ai/api/v1/videos';

// The two endpoints, pinned here so a test can check the shape without a key and a change in the API is one edit.
export function plateBody({ prompt, model, size = '1024x1024', n = 1 }) {
  if (!prompt || !String(prompt).trim()) throw Object.assign(new Error('a prompt is required'), { code: 400 });
  return { model, prompt: String(prompt).trim().slice(0, 2000), n, size, response_format: 'b64_json' };
}

// OpenRouter's documented image-to-video body. frame_images (not "image"), and the frame is the FIRST frame: a still in,
// a moving clip out. Ascpect is explicit because a model otherwise guesses and a film has a fixed shape.
export function clipBody({ prompt, model, imageUrl, duration = 5, resolution = '480p', aspect = '16:9', seed }) {
  if (!model) throw Object.assign(new Error('a video model is required'), { code: 400 });
  if (!imageUrl) throw Object.assign(new Error('the clip needs a starting still'), { code: 400 });
  const body = { model, prompt: String(prompt || '').trim().slice(0, 2000) || undefined, duration: +duration, resolution, aspect_ratio: aspect };
  if (seed != null && Number.isFinite(+seed)) body.seed = +seed;
  body.frame_images = [{ type: 'image_url', image_url: { url: imageUrl }, frame_type: 'first_frame' }];
  return body;
}

// ---- settings -----------------------------------------------------------------------------------------------------
// Off by default. With it off there is no route that spends, and no key is read.
export const GEN_DEFAULTS = {
  enabled: false,
  dailyCapUsd: 2,
  t2iModel: 'black-forest-labs/FLUX-2-klein-9b',
  i2vModel: 'heygen/heygen-video-1',
  resolution: '480p',
  duration: 5,
};
export const genSettings = () => ({ ...GEN_DEFAULTS, ...(config().generation || {}) });
const keyOf = (name) => process.env[name] || (config().generation?.keys || {})[name] || '';
export const hasKey = (name) => !!keyOf(name);

// cost of an image→video job from the model's own price list. Prices are per second, in dollars.
export function clipCost(pricing, { resolution = '480p', duration = 5 } = {}) {
  const sku = pricing?.[`duration_seconds_${resolution}`];
  if (sku == null) return null;
  return +( (+sku) * (+duration || 0) ).toFixed(4);
}

// ---- t2i: one request, base64 back ---------------------------------------------------------------------------------
export async function makePlate(p, { prompt, model = genSettings().t2iModel, size = '1024x1024' }) {
  const s = genSettings();
  if (!s.enabled) throw Object.assign(new Error('Generation is off. Turn it on in Settings > Generation.'), { code: 403 });
  const key = keyOf('DEEPINFRA_API_KEY');
  if (!key) throw Object.assign(new Error('No DeepInfra API key. Add one in Settings > Generation.'), { code: 403 });
  const body = plateBody({ prompt, model, size });
  const r = await fetch(DEEPINFRA, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`DeepInfra said ${r.status}: ${text.slice(0, 300)}`), { code: 400 });
  let j; try { j = JSON.parse(text); } catch { throw Object.assign(new Error('DeepInfra returned something that is not JSON'), { code: 400 }); }
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) throw Object.assign(new Error('DeepInfra returned no image'), { code: 400 });
  const buf = Buffer.from(b64, 'base64');
  const id = newId();
  fs.mkdirSync(plateDir(p), { recursive: true });
  const file = rel(PLATE_DIR, id + '.png');
  fs.writeFileSync(path.join(p.path, file), buf);
  const rec = { id, kind: 'plate', state: 'ready', file, name: body.prompt.slice(0, 60), prompt: body.prompt, source: 'model', provider: 'deepinfra', model, cost: null };
  add(p, rec);
  return rec;
}

// ---- i2v: submit, poll, download -----------------------------------------------------------------------------------
// The tunnel: one HTTP file reachable from outside for as long as a submit takes. ngrok is the one this machine has; a
// machine without it gets a sentence saying so rather than a silent failure.
export function startTunnel(port, { bin = 'ngrok', timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let child, out = '', done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { try { child?.kill(); } catch { } finish(reject, Object.assign(new Error('the tunnel did not start in time'), { code: 500 })); }, timeoutMs);
    try { child = spawn(bin, ['http', String(port), '--log', 'stdout', '--log-format', 'json'], { windowsHide: true }); }
    catch (e) { return finish(reject, Object.assign(new Error(`could not start ${bin}: ${e.message}`), { code: 500 })); }
    const onData = (b) => {
      out += b;
      const m = out.match(/"url":"(https:\/\/[^"]+)"/);
      if (m) finish(resolve, { url: m[1], close: () => { try { child.kill(); } catch { } } });
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => finish(reject, Object.assign(new Error(`could not start ${bin}: ${e.message}`), { code: 500 })));
    child.on('close', () => finish(reject, Object.assign(new Error(`the tunnel closed before it was ready (${out.slice(-200)})`), { code: 500 })));
  });
}

export async function makeClip(p, { prompt, plateId, plateFile, model = genSettings().i2vModel, duration = genSettings().duration, resolution = genSettings().resolution, aspect = '16:9', tunnelUrl }) {
  const s = genSettings();
  if (!s.enabled) throw Object.assign(new Error('Generation is off. Turn it on in Settings > Generation.'), { code: 403 });
  const key = keyOf('OPENROUTER_API_KEY');
  if (!key) throw Object.assign(new Error('No OpenRouter API key. Add one in Settings > Generation.'), { code: 403 });
  const still = plateFile || (plateId && get(p, plateId)?.file);
  if (!still) throw Object.assign(new Error('Say which still the clip starts from'), { code: 400 });
  const abs = path.join(p.path, still);
  if (!fs.existsSync(abs)) throw Object.assign(new Error(`the still is missing: ${still}`), { code: 404 });
  if (!tunnelUrl) throw Object.assign(new Error('the starting still is not reachable from the internet yet'), { code: 500 });
  const body = clipBody({ prompt, model, imageUrl: tunnelUrl, duration, resolution, aspect });
  const r = await fetch(OPENROUTER_VIDEOS, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`OpenRouter said ${r.status}: ${text.slice(0, 300)}`), { code: 400 });
  let j; try { j = JSON.parse(text); } catch { throw Object.assign(new Error('OpenRouter returned something that is not JSON'), { code: 400 }); }
  if (!j?.id) throw Object.assign(new Error('OpenRouter accepted nothing: no job id'), { code: 400 });
  return { jobId: j.id, pollingUrl: j.polling_url || `${OPENROUTER_VIDEOS}/${j.id}`, body };
}

// The job id comes back as `id` on OpenRouter today; older/other shapes use `generation_id`. Read either rather than
// assume, because a job without an id is a submission that cannot be polled or cancelled.
export const jobIdOf = (j) => j?.id || j?.generation_id || null;

// Poll a job until it ends. Every status OpenRouter documents: `completed` is the only success, and failed, error,
// cancelled and expired are all terminal failures. An unknown status is treated as still-running, which is the safe
// reading: the deadline still ends it, so a new status cannot turn into a hang.
export const CLIP_STATUSES = { pending: 'running', in_progress: 'running', completed: 'ready', failed: 'failed', error: 'failed', cancelled: 'failed', expired: 'failed' };

// HeyGen's own ceiling is ~900 s, so that is the deadline. Polling every 5 s costs one cheap GET and makes the panel
// feel alive; the job itself takes minutes either way.
export const POLL_EVERY_MS = 5000, POLL_DEADLINE_MS = 900000;

// The finished file: unsigned_urls[0] is the documented, authenticated download. Fall back to the constructed content
// path (with index=0, which the hand-built path was missing) only when the response did not carry one.
export function downloadUrlOf(j, jobId) {
  const u = j?.unsigned_urls?.[0];
  return u || `https://openrouter.ai/api/v1/videos/${jobId}/content?index=0`;
}

export async function pollClip(jobId, { fetchJson, everyMs = POLL_EVERY_MS, maxMs = POLL_DEADLINE_MS, onTick }) {
  const started = Date.now();
  for (;;) {
    const j = await fetchJson(`https://openrouter.ai/api/v1/videos/${jobId}`);
    const state = CLIP_STATUSES[j?.status] || 'running';
    if (onTick) onTick(j);
    if (state !== 'running') {
      if (state === 'failed') throw Object.assign(new Error(`the clip job ${jobId} ended as "${j?.status}": ${j?.error || 'no reason given'}`), { code: 502 });
      return j;
    }
    if (Date.now() - started > maxMs) throw Object.assign(new Error(`the clip job ${jobId} is still "${j?.status}" after ${Math.round(maxMs / 60000)} min, which is past HeyGen's ceiling; it may still finish on OpenRouter`), { code: 504 });
    await new Promise(r => setTimeout(r, everyMs));
  }
}

// ---- the tunnel: one still reachable from outside, for one submit -----------------------------------------------
// OpenRouter downloads the starting frame itself, so a still on this PC has to be readable from the internet for the
// length of one request. The exposure is small and short on purpose: one random path, one file, GET only, and the token
// is forgotten as soon as the job is accepted.
const showing = new Map();   // random url path -> absolute file

export function oneShotFile(file) {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const urlPath = '/__gen/' + token;
  showing.set(urlPath, file);
  return { urlPath, forget: () => showing.delete(urlPath) };
}

// Called by the hub before its own routes: while a tunnel is up, this is the only thing the public side can reach.
export function tunnelServe(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/__gen/')) return false;
  const file = showing.get(url.pathname);
  if (!file) { res.writeHead(404); res.end(); return true; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return true; }
  let st; try { st = fs.statSync(file); } catch { res.writeHead(404); res.end(); return true; }
  const type = /\.jpe?g$/i.test(file) ? 'image/jpeg' : /\.webp$/i.test(file) ? 'image/webp' : 'image/png';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return true;
}

// The live price list, read from OpenRouter and cached for the life of a hub: one request, and a spend cap that can
// never be checked against a number a page made up. Cached so a submit does not wait on the catalogue every time.
const pricingCache = new Map();
export async function providerPricing(model) {
  if (pricingCache.has(model)) return pricingCache.get(model);
  const r = await fetch('https://openrouter.ai/api/v1/videos/models', { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Object.assign(new Error(`could not read the model price list (${r.status}), so the cost of this clip is unknown and it was not submitted`), { code: 502 });
  const j = await r.json();
  for (const m of j?.data || []) pricingCache.set(m.id, m.pricing_skus || null);
  if (!pricingCache.has(model)) throw Object.assign(new Error(`OpenRouter does not list the model ${model}`), { code: 400 });
  return pricingCache.get(model);
}

// ---- the daily spend cap --------------------------------------------------------------------------------------
// Every paid job records its cost in gen.json, so the cap is a sum over today's records rather than a counter a restart
// could lose. Nothing here is guessed: a job with no price is refused rather than treated as free.
const spentFile = p => path.join(p.path, 'gen', 'spend.json');
export function spentToday(p, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  let j = {};
  try { j = JSON.parse(fs.readFileSync(spentFile(p), 'utf8')); } catch { }
  return +(j[day] || 0);
}
// `usd` may be negative: a finished job is reconciled against what the provider actually billed, and the difference is
// returned to the day the estimate was taken on.
export function addSpend(p, usd, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  let j = {};
  try { j = JSON.parse(fs.readFileSync(spentFile(p), 'utf8')); } catch { }
  j[day] = +Math.max(0, (+(j[day] || 0)) + (+usd || 0)).toFixed(4);
  fs.mkdirSync(path.dirname(spentFile(p)), { recursive: true });
  fs.writeFileSync(spentFile(p), JSON.stringify(j, null, 1));
  return j[day];
}
// The gate every paid call passes: the number is shown before it is spent, and the cap refuses rather than warns.
export function checkBudget(p, usd) {
  const s = genSettings(), spent = spentToday(p), cost = +usd || 0;
  if (spent + cost > s.dailyCapUsd) {
    throw Object.assign(new Error(`That would cost $${cost.toFixed(2)}; today's total is already $${spent.toFixed(2)} of a $${s.dailyCapUsd.toFixed(2)} cap. Raise the cap in Settings > Generation.`), { code: 402 });
  }
  return { spent, cost, cap: s.dailyCapUsd };
}

// ---- routes --------------------------------------------------------------------------------------------------
export function routes(route, project, readBody, port) {
  const need = (id) => { const p = project(id); if (!p) throw Object.assign(new Error('project not found'), { code: 404 }); return p; };

  // the settings the panel draws, minus the key values (a key is never sent back to a page)
  route('GET', '/api/gen/config', () => {
    const s = genSettings();
    return { ...s, keys: { DEEPINFRA_API_KEY: hasKey('DEEPINFRA_API_KEY'), OPENROUTER_API_KEY: hasKey('OPENROUTER_API_KEY'), ELEVENLABS_API_KEY: hasKey('ELEVENLABS_API_KEY') } };
  });
  route('POST', '/api/gen/config', async (req) => {
    const body = await readBody(req);
    const patch = {};
    const prev = config().generation || {};
    for (const k of ['enabled', 'dailyCapUsd', 't2iModel', 'i2vModel', 'resolution', 'duration']) if (k in body) patch[k] = body[k];
    if (body.keys && typeof body.keys === 'object') {
      const keys = { ...(prev.keys || {}) };
      for (const n of ['DEEPINFRA_API_KEY', 'OPENROUTER_API_KEY', 'ELEVENLABS_API_KEY']) if (typeof body.keys[n] === 'string' && body.keys[n].trim()) keys[n] = body.keys[n].trim();
      patch.keys = keys;
    }
    if (patch.dailyCapUsd != null) patch.dailyCapUsd = Math.max(0, +patch.dailyCapUsd || 0);
    if (patch.duration != null) patch.duration = Math.max(1, Math.round(+patch.duration || 5));
    saveConfig({ generation: { ...prev, ...patch } });
    return { ...genSettings(), keys: { DEEPINFRA_API_KEY: hasKey('DEEPINFRA_API_KEY'), OPENROUTER_API_KEY: hasKey('OPENROUTER_API_KEY'), ELEVENLABS_API_KEY: hasKey('ELEVENLABS_API_KEY') } };
  });

  // today's spend, so the panel can show it next to the cap
  route('GET', '/api/gen/:id/spend', (req, url, { id }) => {
    const p = need(id), s = genSettings();
    return { spent: spentToday(p), cap: s.dailyCapUsd };
  });

  // text -> one still
  route('POST', '/api/gen/:id/plate', async (req, url, { id }) => {
    const p = need(id), body = await readBody(req);
    const s = genSettings();
    if (!s.enabled) throw Object.assign(new Error('Generation is off. Turn it on in Settings > Generation.'), { code: 403 });
    const rec = await makePlate(p, body);
    return rec;
  });

  // still -> a video job. The tunnel is up only while the submit is in flight.
  route('POST', '/api/gen/:id/clip', async (req, url, { id }) => {
    const p = need(id), body = await readBody(req);
    const s = genSettings();
    if (!s.enabled) throw Object.assign(new Error('Generation is off. Turn it on in Settings > Generation.'), { code: 403 });
    const plan = { resolution: body.resolution || s.resolution, duration: body.duration || s.duration, model: body.model || s.i2vModel };
    // The price comes from the provider's own catalogue at submit time, not from the caller: an agent cannot be trusted
    // to say what a job costs, and a stale price is how a cap silently fails. A model with no published price for this
    // resolution is refused rather than run unpriced.
    const pricing = await providerPricing(plan.model);
    const cost = clipCost(pricing, plan);
    if (cost == null) throw Object.assign(new Error(`I cannot price ${plan.model} at ${plan.resolution}. Pick a resolution the model lists, so the spend is known before it happens.`), { code: 400 });
    checkBudget(p, cost);
    const shot = oneShotFile(path.join(p.path, body.plateFile || get(p, body.plateId)?.file || ''));
    let tunnel = null;
    try {
      tunnel = await startTunnel(port);
      const job = await makeClip(p, { ...body, ...plan, tunnelUrl: tunnel.url + shot.urlPath });
      const rec = { id: newId(), kind: 'clip', state: 'running', jobId: job.jobId, provider: 'openrouter', model: plan.model, resolution: plan.resolution, duration: plan.duration, cost: clipCost(pricing, plan), prompt: String(body.prompt || '').slice(0, 2000), plateId: body.plateId || null, file: null, pricedAt: new Date().toISOString() };
      // a readable name for the timeline bar: the first words of the motion, which is what tells two clips apart
      rec.name = (body.name || rec.prompt || '').trim().split(/\s+/).slice(0, 6).join(' ').slice(0, 48) || plan.model;
      add(p, rec);
      addSpend(p, rec.cost);   // the estimate is held against the cap until the job reports what it really cost
      // start watching it now. resumeJobs() at hub start only covers jobs that were already running then; a job
      // submitted afterwards was left unwatched, which is how one completed on OpenRouter and stayed "running" here.
      watchJob(p, rec.id);
      return rec;
    } finally {
      shot.forget();
      if (tunnel) try { tunnel.close(); } catch { }
    }
  });
}

// ---- finishing a running job ---------------------------------------------------------------------------------
// Download and bake, once a job reports completed. Kept apart from polling so a hub that restarted in the middle can
// pick the job up again: the job id is in gen.json, and OpenRouter keeps the result.
export async function finishClip(p, id) {
  const rec = get(p, id);
  if (!rec) throw Object.assign(new Error(`no asset ${id}`), { code: 404 });
  if (rec.kind !== 'clip') throw Object.assign(new Error(`${id} is not a clip`), { code: 400 });
  if (rec.state !== 'running') return rec;
  const key = keyOf('OPENROUTER_API_KEY');
  if (!key) throw Object.assign(new Error('No OpenRouter API key.'), { code: 403 });
  const auth = { Authorization: `Bearer ${key}` };
  // Poll again rather than assume: this is reached both right after a submit and after a restart, and only the job
  // itself can say whether it is done. It also gives us the download URL the response carries.
  const done = await pollClip(rec.jobId, { fetchJson: async (u) => { const r = await fetch(u, { headers: auth }); if (!r.ok) throw Object.assign(new Error(`OpenRouter said ${r.status} while checking job ${rec.jobId}`), { code: 502 }); return r.json(); } });
  const r = await fetch(downloadUrlOf(done, rec.jobId), { headers: auth, redirect: 'follow', signal: AbortSignal.timeout(10 * 60000) });
  if (!r.ok) throw Object.assign(new Error(`OpenRouter said ${r.status} for the clip download`), { code: 502 });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 2048) throw Object.assign(new Error('the clip download came back empty'), { code: 502 });
  // The provider's own figure is the truth. The catalogue SKU is not simply per-second x duration (a 5 s 480p heygen
  // clip is listed at $0.10 and billed at $0.05), so the estimate is corrected and the difference returned to the cap.
  const billed = done?.usage?.cost;
  if (Number.isFinite(+billed) && +billed >= 0) {
    rec.billedCost = +(+billed).toFixed(4);
    const was = +rec.cost || 0, now = rec.billedCost;
    if (Math.abs(now - was) > 0.0001) addSpend(p, now - was, new Date(rec.pricedAt || Date.now()));
  }
  fs.mkdirSync(clipDir(p), { recursive: true });
  const file = rel(CLIP_DIR, id + '.mp4');
  fs.writeFileSync(path.join(p.path, file), buf);
  const m = JSON.parse(fs.readFileSync(path.join(p.path, 'gen', 'gen.json'), 'utf8'));
  const a = m.assets.find(x => x.id === id);
  a.file = file; a.state = 'ready'; a.bytes = buf.length; a.readyAt = new Date().toISOString();
  if (rec.billedCost != null) a.billedCost = rec.billedCost;
  const tmp = path.join(p.path, 'gen', 'gen.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(m, null, 1)); fs.renameSync(tmp, path.join(p.path, 'gen', 'gen.json'));
  try {
    await bakeClip(p, id, {});
    Object.assign(a, { baked: true, atlas: rel(ATLAS_DIR, id + '.json') });
    // Placed on the timeline as part of finishing: generating a clip and seeing it in the film are one action. It goes
    // after whatever is already placed, never on top of it, and the user can drag it afterwards.
    try {
      const at = readAtlas(p, id);
      const filmDur = +(JSON.parse(fs.readFileSync(path.join(p.path, '.nodecut', 'project.json'), 'utf8')).render?.env?.DUR || 0) || 10;
      const put = place(p, { id, t0: null, t1: null, op: 1, fit: 'cover', filmDur: Math.max(filmDur, (at?.srcDur || 5)) });
      Object.assign(a, { placed: put.placed });
    } catch (e) { a.placeError = String(e.message || e).slice(0, 200); }
  } catch (e) { Object.assign(a, { baked: false, bakeError: String(e.message || e).slice(0, 300) }); }
  fs.writeFileSync(tmp, JSON.stringify(m, null, 1)); fs.renameSync(tmp, path.join(p.path, 'gen', 'gen.json'));
  return a;
}

// Watch one running job to the end: poll, download, bake, place. One watcher per asset, however it was started, so a
// submit and a hub restart cannot both finish the same job.
const watching = new Set();
export function watchJob(p, id) {
  if (watching.has(id)) return;
  const a = get(p, id);
  if (!a || a.kind !== 'clip' || a.state !== 'running' || !a.jobId) return;
  watching.add(id);
  (async () => {
    try { await finishClip(p, id); }
    catch (e) { fail(p, id, e.message); }
    finally { watching.delete(id); }
  })();
}

// Jobs left running by an earlier hub. Called at start: anything submitted while the hub was down is picked up here,
// and anything submitted after start is watched by watchJob() at submit time. Between them no job is ever unwatched.
export function resumeJobs(p) {
  for (const a of JSON.parse(readManifestSafe(p)).assets || []) if (a.kind === 'clip' && a.state === 'running') watchJob(p, a.id);
}
function readManifestSafe(p) { try { return fs.readFileSync(path.join(p.path, 'gen', 'gen.json'), 'utf8'); } catch { return '{}'; } }
