// The generation endpoints are checked as data, not by calling them: the body that goes on the wire is the thing that
// breaks silently when a provider changes, and a test can hold it still without a key or a dollar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { plateBody, clipBody, clipCost, CLIP_STATUSES, pollClip, jobIdOf, downloadUrlOf, POLL_EVERY_MS, POLL_DEADLINE_MS } from './genapi.js';

test('genapi: the t2i body asks DeepInfra for base64, so there is no expiring URL to chase', () => {
  const b = plateBody({ prompt: '  a copper kettle, studio light  ', model: 'black-forest-labs/FLUX-2-klein-9b' });
  assert.equal(b.model, 'black-forest-labs/FLUX-2-klein-9b');
  assert.equal(b.prompt, 'a copper kettle, studio light', 'the prompt is trimmed');
  assert.equal(b.response_format, 'b64_json', 'base64 in the response, not a temp URL');
  assert.equal(b.n, 1);
  assert.equal(b.size, '1024x1024');
  assert.throws(() => plateBody({ prompt: '   ' }), /a prompt is required/);
  assert.throws(() => plateBody({}), /a prompt is required/);
  assert.equal(plateBody({ prompt: 'x'.repeat(5000), model: 'm' }).prompt.length, 2000, 'a runaway prompt is capped');
});

test('genapi: the i2v body matches OpenRouter\'s documented shape (frame_images, not "image")', () => {
  const b = clipBody({ prompt: 'slow push in', model: 'heygen/heygen-video-1', imageUrl: 'https://example.test/a.jpg', duration: 5, resolution: '480p' });
  assert.equal(b.model, 'heygen/heygen-video-1');
  assert.equal(b.duration, 5);
  assert.equal('image' in b, false, 'the old "image" field is gone: OpenRouter rejects it');
  assert.deepEqual(b.frame_images, [{ type: 'image_url', image_url: { url: 'https://example.test/a.jpg' }, frame_type: 'first_frame' }]);
  assert.equal(b.aspect_ratio, '16:9', 'a film has a fixed shape, so the aspect is explicit');
  assert.equal('generate_audio' in b, false, 'the film muxes its own sound');
  // a seed is only sent when there is one: an absent key is not the same as 0
  assert.equal('seed' in b, false);
  assert.equal(clipBody({ model: 'm', imageUrl: 'u', seed: 0 }).seed, 0, 'seed 0 is a real seed');
  assert.throws(() => clipBody({ imageUrl: 'u' }), /video model/);
});

test('genapi: without a still the body is text-to-video, and sends no frame at all', () => {
  // Frame images are what a model ACCEPTS, not what it requires: Veo, Kling and Seedance all generate from words alone.
  // Demanding a still is what made "make this shot from a description" impossible for an agent.
  const b = clipBody({ prompt: 'a slow orbit around a glass cube on black', model: 'google/veo-3.1-fast', duration: 5, resolution: '720p' });
  assert.equal('frame_images' in b, false, 'a frame image here would turn a text shot into a still animation');
  assert.match(b.prompt, /glass cube/, 'the prompt is the whole shot, so it must survive intact');
  assert.equal(b.model, 'google/veo-3.1-fast');
  // and with a still, the frame is back
  assert.ok(clipBody({ prompt: 'x', model: 'm', imageUrl: 'u' }).frame_images);
});

test('genapi: a heygen clip costs what the catalog says, and 1080p is five times 480p', () => {
  // the model's own price list (dollars per second), as OpenRouter publishes it
  const heygen = { duration_seconds_480p: '0.02', duration_seconds_768p: '0.036', duration_seconds_1080p: '0.1', duration_seconds_2k: '0.1' };
  assert.equal(clipCost(heygen, { resolution: '480p', duration: 5 }), 0.1, '5 s at 480p is ten cents');
  assert.equal(clipCost(heygen, { resolution: '1080p', duration: 5 }), 0.5, 'the same clip at 1080p is fifty cents');
  assert.equal(clipCost(heygen, { resolution: '768p', duration: 10 }), 0.36);
  assert.equal(clipCost(heygen, { resolution: '4K', duration: 5 }), null, 'a resolution the model does not price is not free, it is unknown');
  assert.equal(clipCost(null, { resolution: '480p' }), null);
});

test('genapi: every status OpenRouter documents maps to running, ready or failed', () => {
  assert.equal(CLIP_STATUSES.pending, 'running');
  assert.equal(CLIP_STATUSES.in_progress, 'running');
  assert.equal(CLIP_STATUSES.completed, 'ready');
  // "error" is a documented failure status: without it a failed job polls until the deadline
  for (const s of ['failed', 'error', 'cancelled', 'expired']) assert.equal(CLIP_STATUSES[s], 'failed', s);
  assert.equal(CLIP_STATUSES.something_new, undefined, 'an unknown status is not silently treated as finished');
});

test('genapi: the job id is read from either key, because the response shape varies', () => {
  assert.equal(jobIdOf({ id: 'abc' }), 'abc');
  assert.equal(jobIdOf({ generation_id: 'gen-123' }), 'gen-123', 'generation_id is the other documented shape');
  assert.equal(jobIdOf({ id: 'abc', generation_id: 'gen-123' }), 'abc', 'id wins when both are present');
  assert.equal(jobIdOf({}), null, 'no id means the job cannot be polled');
  assert.equal(jobIdOf(null), null);
});

test('genapi: the download uses unsigned_urls[0], and the fallback keeps index=0', () => {
  // the documented authenticated download
  assert.equal(downloadUrlOf({ unsigned_urls: ['https://x.test/videos/j1/content?index=0'] }, 'j1'), 'https://x.test/videos/j1/content?index=0');
  // only the first output, never a list
  assert.equal(downloadUrlOf({ unsigned_urls: ['https://x.test/a', 'https://x.test/b'] }, 'j1'), 'https://x.test/a');
  // the hand-built path must carry index=0, which the original was missing
  assert.equal(downloadUrlOf({}, 'j1'), 'https://openrouter.ai/api/v1/videos/j1/content?index=0');
  assert.equal(downloadUrlOf(null, 'j1'), 'https://openrouter.ai/api/v1/videos/j1/content?index=0');
});

test('genapi: polling runs on a live cadence against a real deadline', () => {
  assert.equal(POLL_EVERY_MS, 5000, '~5 s, not 15: a cheap GET that keeps the panel honest');
  assert.equal(POLL_DEADLINE_MS, 900000, '15 min, roughly HeyGen\'s ceiling for the longest clip it makes');
});

test('genapi: polling waits for the job and stops on a failure or a timeout instead of hanging', async () => {
  const seen = [];
  let n = 0;
  const j = await pollClip('j1', {
    everyMs: 1, maxMs: 60000, onTick: s => seen.push(s.status),
    fetchJson: async () => [{ status: 'pending' }, { status: 'in_progress' }, { status: 'completed', urls: ['u'] }][n++],
  });
  assert.equal(j.status, 'completed');
  assert.deepEqual(seen, ['pending', 'in_progress', 'completed']);

  // "error" is terminal too: it must throw, not spin until the deadline
  await assert.rejects(() => pollClip('j2', { everyMs: 1, maxMs: 60000, fetchJson: async () => ({ status: 'error', error: 'nsfw filter' }) }),
    /ended as "error": nsfw filter/);

  await assert.rejects(() => pollClip('j3', { everyMs: 1, maxMs: 30, fetchJson: async () => ({ status: 'in_progress' }) }),
    /still "in_progress"/);
});

test('genapi: the price comes from the provider catalogue, never from the caller', async () => {
  const { providerPricing, clipCost } = await import('./genapi.js');
  // cached: the catalogue is read once, so a second submit does not wait on it
  const a = await providerPricing('heygen/heygen-video-1');
  const b = await providerPricing('heygen/heygen-video-1');
  assert.equal(a, b, 'the same object comes back from the cache');
  assert.equal(clipCost(a, { resolution: '480p', duration: 5 }), 0.1);
  // a model that is not in the catalogue is a clear refusal, not an unpriced job
  await assert.rejects(() => providerPricing('nobody/nothing-here'), /does not list the model/);
});

test('genapi: a finished job settles the cap to what the provider billed, not to the estimate', async () => {
  const { addSpend, spentToday, checkBudget } = await import('./genapi.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const p = { path: fs.mkdtempSync(path.join(os.tmpdir(), 'vh-settle-')), id: 's1' };
  // submit: the catalogue estimate is held against the cap
  addSpend(p, 0.10);
  assert.equal(spentToday(p), 0.1);
  // completion: the provider billed half, so half comes back
  addSpend(p, 0.05 - 0.10);
  assert.equal(spentToday(p), 0.05, 'the cap now reflects the real charge');
  // and a correction can never push the day below zero
  addSpend(p, -99);
  assert.equal(spentToday(p), 0);
  // a job the estimate refused is allowed once the real price is known
  addSpend(p, 1.9);
  assert.throws(() => checkBudget(p, 0.2), /today's total/);
  addSpend(p, 1.85 - 1.9);
  assert.doesNotThrow(() => checkBudget(p, 0.1));
});

// --- text-to-video on DeepInfra ---------------------------------------------------------------------------------
// The studio defaults to FastVideo's FastWan because it is the cheapest 720p text-to-video DeepInfra lists: $0.0225 for
// five seconds, which is roughly a tenth of the OpenRouter video models for the same length.
import { t2vBody, t2vCost, T2V_MODEL, T2V_COST } from './genapi.js';

test('t2v: the body matches DeepInfra\'s documented fields', () => {
  const b = t2vBody({ prompt: 'a slow orbit around a glass cube' });
  assert.equal(b.seconds, 5, 'this model only makes five-second clips');
  assert.equal(b.resolution, '720p', '720p is the default the user asked for, not 480p');
  assert.equal(b.orientation, 'landscape');
  assert.match(b.prompt, /glass cube/);
  assert.equal('frame_images' in b, false, 'a text shot has no starting still');
});

test('t2v: resolution and orientation are constrained to what the model offers', () => {
  assert.equal(t2vBody({ prompt: 'x', resolution: '480p' }).resolution, '480p');
  assert.equal(t2vBody({ prompt: 'x', resolution: '1080p' }).resolution, '720p', 'unsupported sizes fall back, never sent through');
  assert.equal(t2vBody({ prompt: 'x', orientation: 'portrait' }).orientation, 'portrait');
  assert.equal(t2vBody({ prompt: 'x', orientation: 'sideways' }).orientation, 'landscape');
});

test('t2v: an empty prompt is refused before anything is sent', () => {
  assert.throws(() => t2vBody({ prompt: '   ' }), /Describe the shot/);
});

test('t2v: the price is the published one, and 480p is half', () => {
  assert.equal(T2V_MODEL, 'FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers');
  assert.equal(T2V_COST, 0.0225);
  assert.equal(t2vCost('720p'), 0.0225);
  assert.equal(t2vCost('480p'), 0.01125, 'the listing says 480p is half price');
});

test('t2v: a seed is sent only when there is one', () => {
  assert.equal('seed' in t2vBody({ prompt: 'x' }), false, 'an absent seed is not seed 0');
  assert.equal(t2vBody({ prompt: 'x', seed: 0 }).seed, 0, 'seed 0 is a real seed');
});
