// The live preview serves a film's own files. Video needs Range support: a player streams the file and asks for the
// pieces it wants as it seeks. Without it the browser has to download the whole thing before it can draw a frame, and
// on a large recording it never gets there -- the preview stayed black where the render (reading the file locally) had
// real footage. That was reported from a real film: "the preview is different from the final".
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from './live.js';

// A tiny server around the route, so the test exercises the real headers rather than a reimplementation of them.
function withServer(dir, fn) {
  return new Promise(async (resolve, reject) => {
    const p = { id: 'test', path: dir, rootType: 'container' };
    const srv = http.createServer((req, res) => serve(req, res, p, req.url.replace(/^\//, '').split('?')[0]));
    srv.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      try { resolve(await fn(base)); } catch (e) { reject(e); } finally { srv.close(); }
    });
  });
}

function filmWithVideo(bytes = 5000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-live-range-'));
  const body = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) body[i] = i % 251;
  fs.writeFileSync(path.join(dir, 'clip.mp4'), body);
  return { dir, body };
}

test('a video can be range-requested, so a player can seek instead of waiting for the whole file', async () => {
  const { dir, body } = filmWithVideo(5000);
  try {
    await withServer(dir, async (base) => {
      const r = await fetch(`${base}/clip.mp4`, { headers: { Range: 'bytes=100-199' } });
      assert.equal(r.status, 206);
      assert.equal(r.headers.get('content-range'), 'bytes 100-199/5000');
      assert.equal(r.headers.get('accept-ranges'), 'bytes');
      const got = Buffer.from(await r.arrayBuffer());
      assert.equal(got.length, 100);
      assert.deepEqual(got, body.subarray(100, 200));
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an open-ended range returns the rest of the file', async () => {
  const { dir } = filmWithVideo(5000);
  try {
    await withServer(dir, async (base) => {
      const r = await fetch(`${base}/clip.mp4`, { headers: { Range: 'bytes=4900-' } });
      assert.equal(r.status, 206);
      assert.equal((await r.arrayBuffer()).byteLength, 100);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a suffix range returns the tail, which is how some players probe a file', async () => {
  const { dir } = filmWithVideo(5000);
  try {
    await withServer(dir, async (base) => {
      const r = await fetch(`${base}/clip.mp4`, { headers: { Range: 'bytes=-50' } });
      assert.equal(r.status, 206);
      assert.equal(r.headers.get('content-range'), 'bytes 4950-4999/5000');
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a range past the end is refused, not served as garbage', async () => {
  const { dir } = filmWithVideo(5000);
  try {
    await withServer(dir, async (base) => {
      const r = await fetch(`${base}/clip.mp4`, { headers: { Range: 'bytes=9000-9100' } });
      assert.equal(r.status, 416);
      assert.equal(r.headers.get('content-range'), 'bytes */5000');
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a plain request still returns the whole file, with its length', async () => {
  const { dir, body } = filmWithVideo(5000);
  try {
    await withServer(dir, async (base) => {
      const r = await fetch(`${base}/clip.mp4`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-length'), '5000');
      assert.equal((await r.arrayBuffer()).byteLength, body.length);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
