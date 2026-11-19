// ElevenLabs is checked as data, not by calling it: the body that goes on the wire, the file name that lands on disk, and
// the refusals that should happen before anything is sent. Same approach the other generation tests use, so a wrong field
// is caught without spending the user's credits.
//
// Nothing in this file may make a network call. keyOf() falls back to the hub's saved config, so a test that only clears
// the env var would still find a real key on a real machine — that happened once and attempted a live request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceoverRequest, musicRequest, sfxRequest, request, safeName, extFor, audioDirOf } from './elevenlabs.js';

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

test('audioDirOf: audio always sits inside the film', () => {
  assert.equal(audioDirOf({ path: '/films/mine' }), '/films/mine/audio');
});

// --- plan entitlements -----------------------------------------------------------------------------------------
// A real failure, worth pinning: a film requested mp3_44100_192, which needs the Creator tier. The account did not have
// it, every call returned 403 `subscription_required`, and the caller silently fell back to a machine voice — so the
// symptom looked like "the voice is robotic", not "the format was refused". No request may name a tier-locked format.
test('no request pins an output format that some plans are refused', () => {
  const all = [
    voiceoverRequest({ text: 'x', voiceId: 'v' }).url,
    musicRequest({ prompt: 'x' }).url,
    sfxRequest({ prompt: 'x' }).url,
  ];
  for (const url of all) {
    assert.doesNotMatch(url, /output_format=/i, 'the format must be left to the account, not requested: ' + url);
  }
});
