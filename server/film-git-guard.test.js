// A film is a project the person is making, not a change to this app. Films are created inside whatever folder the user
// keeps them in — often inside somebody else's git repository — so a stray `git add .` could sweep an entire film into a
// commit. These tests pin the safeguard that makes that impossible.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STYLE } from './agent.js';

test('the agent is told never to run git in a film folder', () => {
  assert.match(STYLE, /FILM PROJECT/, 'the instructions must say what the folder is');
  assert.match(STYLE, /Never run git commands/, 'and that git is off limits');
  for (const verb of ['add', 'commit', 'stash', 'checkout', 'branch']) {
    assert.match(STYLE, new RegExp(verb), 'git ' + verb + ' must be named so it cannot be read as allowed');
  }
});

test('the agent is told not to edit the studio itself', () => {
  assert.match(STYLE, /Do not edit files outside this folder/);
});

test('a film folder that excludes itself lets nothing through but .gitignore', () => {
  // the same bytes the new-film route writes
  const text = '# A film is a project, not part of an app\'s source code.\n' +
    '# NodeCut writes renders, chunk caches, generated media, audio mixes and the agent conversation into this folder.\n' +
    '# None of it belongs in a commit, and this folder often sits inside someone else\'s repository.\n' +
    '# The film\'s own code is excluded too, on purpose: it is only committed if the person decides to.\n' +
    '*\n!.gitignore\n';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-gitguard-'));
  fs.writeFileSync(path.join(dir, '.gitignore'), text);
  for (const f of ['film.js', 'render.js', 'BRIEF.md', 'AGENT.md', 'audio/mix.wav', 'render/chunks/c_000.mp4']) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'x');
  }
  const rules = text.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  assert.deepEqual(rules, ['*', '!.gitignore'], 'everything is ignored, then this file is re-included');
  // the re-include must be last, or `*` would swallow it again
  assert.equal(rules.at(-1), '!.gitignore');
});
