// ElevenLabs is checked as data, not by calling it: the body that goes on the wire, the file name that lands on disk, and
// the refusals that should happen before anything is sent. Same approach the other generation tests use, so a wrong field
// is caught without spending the user's credits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceoverRequest, musicRequest, sfxRequest, request, safeName, extFor, make, audioDirOf } from './elevenlabs.js';

test('voiceover: posts to the chosen voice, with the text and settings', () => {
  const r = voiceoverRequest({ text: 'Hello there', voiceId: 'v123' });
  assert.match(r.url, /\/v1\/text-to-speech\/v123$/);
  assert.equal(r.body.text, 'Hello there');
  assert.ok(r.body.model_id, 'a model id must be sent or the API picks one we cannot predict');
  assert.ok(r.body.voice_settings, 'voice settings travel with the request');
});

test('voiceover: a voice id is embedded safely, not pasted into the url', () => {
  const r = voiceoverRequest({ text: 'x', voiceId: 'a/../../etc' });
  assert.doesNotMatch(r.url, /\.\.\/\.\./, 'a voice id must not be able to walk the url');
  assert.match(r.url, /a%2F\.\.%2F\.\.%2Fetc$/);
});

test('a voice-over with no text or no voice is refused before any request', () => {
  assert.throws(() => voiceoverRequest({ text: '', voiceId: 'v' }), /no text/i);
  assert.throws(() => voiceoverRequest({ text: 'hi' }), /pick a voice/i);
});

test('music: length is clamped to what the API allows', () => {
  assert.equal(musicRequest({ prompt: 'warm piano', lengthMs: 30000 }).body.music_length_ms, 30000);
  assert.equal(musicRequest({ prompt: 'x', lengthMs: 10 }).body.music_length_ms, 3000, 'too short is raised to the minimum');
  assert.equal(musicRequest({ prompt: 'x', lengthMs: 10_000_000 }).body.music_length_ms, 300000, 'too long is capped');
});

test('sfx: duration is optional and bounded when given', () => {
  const bare = sfxRequest({ prompt: 'door close' });
  assert.equal(bare.body.duration_seconds, undefined, 'no duration means the API decides');
  assert.equal(sfxRequest({ prompt: 'x', durationSec: 99 }).body.duration_seconds, 22);
  assert.equal(sfxRequest({ prompt: 'x', durationSec: 0.1 }).body.duration_seconds, 0.5);
});

test('request(): every kind routes, and an unknown kind says so', () => {
  assert.match(request('voiceover', { text: 'a', voiceId: 'v' }).url, /text-to-speech/);
  assert.match(request('music', { prompt: 'a' }).url, /\/v1\/music/);
  assert.match(request('sfx', { prompt: 'a' }).url, /sound-generation/);
  assert.throws(() => request('singing', {}), /unknown audio kind/i);
});

test('safeName: a name from a request cannot escape the folder', () => {
  for (const bad of ['../../etc/passwd', '..\\..\\windows\\system32', '/abs/path', 'a:b*c?d', '   ', '']) {
    const got = safeName(bad);
    assert.doesNotMatch(got, /[/\\]/, 'no separators survive: ' + JSON.stringify(bad) + ' -> ' + JSON.stringify(got));
    assert.ok(got.length > 0, 'never an empty file name');
  }
});

test('extFor: the extension follows what the server actually sent', () => {
  assert.equal(extFor('audio/mpeg'), 'mp3');
  assert.equal(extFor('audio/mp3'), 'mp3');
  assert.equal(extFor('audio/wav'), 'wav');
  assert.equal(extFor(''), 'mp3', 'mp3 is the documented default');
});

test('make(): no key means a clear message, not a network call', async () => {
  const prev = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  await assert.rejects(() => make({ path: '/tmp/does-not-matter' }, 'sfx', { prompt: 'x' }), /Settings → Generation/);
  if (prev !== undefined) process.env.ELEVENLABS_API_KEY = prev;
});

test('audioDirOf: audio always sits inside the film', () => {
  assert.equal(audioDirOf({ path: '/films/mine' }), '/films/mine/audio');
});
