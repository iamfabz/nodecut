// PrunaAI/p-video on DeepInfra, and the tunnel lifetime it depends on.
//
// Two things are worth asserting without spending money: the price, because a spend cap that quotes a number the provider
// does not charge is not a cap; and that the FastWan route refuses a different model rather than quietly running its own
// body, which is what happened first — a p-video job that answered 200 with a FastWan mp4 and cost real money.
import test from 'node:test';
import assert from 'node:assert/strict';

const { pvideoCost, PVIDEO_MODEL, PVIDEO_PER_SEC, makeT2V, T2V_MODEL } = await import('./genapi.js');

test('p-video is priced from its published per-second rate', () => {
  assert.equal(PVIDEO_MODEL, 'PrunaAI/p-video');
  assert.equal(pvideoCost(5, '720p'), 0.1, '5 s at 720p is ten cents, which is what the provider billed in testing');
  assert.equal(pvideoCost(5, '1080p'), 0.2);
  assert.equal(pvideoCost(10, '720p'), 0.2);
  // draft is a quarter price, the documented way to look before committing
  assert.equal(pvideoCost(5, '720p', true), 0.025);
  // an unknown resolution must not become free
  assert.equal(pvideoCost(5, '4k'), 0.1);
  for (const [res, rate] of Object.entries(PVIDEO_PER_SEC)) assert.ok(rate > 0, `${res} has a price`);
});

test('the FastWan endpoint refuses a model whose body it does not speak', async () => {
  // the failure this guards: passing model: 'PrunaAI/p-video' to makeT2V used to run FastWan anyway and return 200
  await assert.rejects(
    () => makeT2V({ id: 'x', path: '/nonexistent' }, { prompt: 'smoke', model: 'PrunaAI/p-video' }),
    /does not use this endpoint/,
  );
  assert.equal(T2V_MODEL, 'FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers');
});
