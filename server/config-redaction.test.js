// The GET and POST of /api/config used to spread the whole config object, which includes the user's live API keys.
// Anyone with the page open (or a saved HAR, or anything else running on the machine that can reach loopback) could
// read sk-… out of the JSON. Keys are now reported as "is one set?" booleans; the values never leave the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('./hub.js', import.meta.url), 'utf8');

// the rule is a single named helper in hub.js; pull it out and exercise it on a realistic config
const body = SRC.match(/const redactConfig = ([\s\S]*?);\nroute\('GET', '\/api\/config'/);
test('redactConfig is still present in hub.js', () => {
  assert.ok(body, 'hub.js must keep redactConfig — it is the only thing stopping /api/config from leaking the API keys');
});

const sample = {
  port: 7791,
  agentName: 'OpenCode',
  generation: { enabled: true, dailyCapUsd: 2, keys: { DEEPINFRA_API_KEY: 'sk-di-secretvalue', OPENROUTER_API_KEY: 'sk-or-v1-secretvalue' } },
};

test('no key VALUE survives redaction; only whether one is set', () => {
  // eval the helper exactly as hub.js defines it
  const fn = new Function('c', `return (${body[1]})(c);`);
  const out = fn(structuredClone(sample));
  const keys = out.generation.keys;
  assert.equal(keys.DEEPINFRA_API_KEY, true);
  assert.equal(keys.OPENROUTER_API_KEY, true);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('sk-di-secretvalue'), 'the DeepInfra key must never appear in the response');
  assert.ok(!json.includes('sk-or-v1-secretvalue'), 'the OpenRouter key must never appear in the response');
  // the rest of the config is untouched: pages still need the port, the folders and the generation settings
  assert.equal(out.port, 7791);
  assert.equal(out.generation.enabled, true);
  assert.equal(out.generation.dailyCapUsd, 2);
});

test('a config with no keys does not invent them', () => {
  const fn = new Function('c', `return (${body[1]})(c);`);
  const out = fn({ port: 1, generation: { enabled: false } });
  assert.deepEqual(out.generation.keys, {});
});
