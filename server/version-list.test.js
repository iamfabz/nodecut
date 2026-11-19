// versions.json has been written in two shapes in the wild: NodeCut's own plain array, and a `{ v, versions: [...] }`
// envelope produced by an agent driving the studio through the MCP tools. The scan read it as an array unconditionally,
// so one enveloped file threw "versions.filter is not a function" and took the whole folder scan down with it — every
// film in the list, not just the broken one. These tests pin the tolerant reader so that cannot come back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readVersionList } from './util.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vers-'));
const write = (dir, data) => { const f = path.join(dir, 'versions.json'); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data)); return f; };

test('readVersionList: a plain array is returned as-is', () => {
  const d = tmp();
  const arr = [{ v: 1, file: 'a.mp4' }, { v: 2, file: 'b.mp4' }];
  assert.deepEqual(readVersionList(write(d, arr)), arr);
});

test('readVersionList: the { v, versions } envelope is unwrapped', () => {
  const d = tmp();
  const versions = [{ v: 1, file: 'sweet cow_v1.mp4', kind: 'final' }];
  assert.deepEqual(readVersionList(write(d, { v: 1, versions })), versions);
});

test('readVersionList: never throws, whatever is on disk', () => {
  for (const bad of ['', 'not json', 'null', '42', '"text"', '{}', '{ "versions": "nope" }', '{ "versions": null }']) {
    const d = tmp();
    assert.deepEqual(readVersionList(write(d, bad)), [], 'input: ' + bad);
  }
});

test('readVersionList: a missing file is an empty list, not a crash', () => {
  assert.deepEqual(readVersionList(path.join(tmp(), 'nope.json')), []);
});

test('readVersionList: every entry survives, so version numbers stay right', () => {
  const d = tmp();
  const versions = Array.from({ length: 5 }, (_, i) => ({ v: i + 1, file: `v${i + 1}.mp4` }));
  const got = readVersionList(write(d, { v: 1, versions }));
  assert.equal(got.length, 5);
  // the map the scan builds is what assigns "v3" to a clip; losing entries would mislabel every film after it
  const byRel = new Map(got.filter(x => x.file).map(x => [x.file, x.v]));
  assert.equal(byRel.get('v3.mp4'), 3);
});
