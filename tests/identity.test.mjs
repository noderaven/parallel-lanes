// scripts/_identity.py: the git identity a run's commit rules pass as
// -c user.name=... and -c user.email=... (setup's git_identity, doctor's
// git_identity check).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');

// identity_pairs(text) through a Python child with scripts/ importable (no
// bytecode); text goes in on stdin as JSON, the pairs come back as JSON.
function identityPairs(text) {
  const code = [
    'import json, sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _identity',
    'print(json.dumps(_identity.identity_pairs(json.load(sys.stdin))))',
  ].join('\n');
  const r = spawnSync('python3', ['-B', '-c', code], { encoding: 'utf8', input: JSON.stringify(text) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('identity_pairs: bare pairs in the order name, email', () => {
  assert.deepEqual(identityPairs('git -c user.name=a -c user.email=b commit'), ['user.name=a', 'user.email=b']);
});

test('identity_pairs: user.name comes first and a bare word loses a sentence end', () => {
  assert.deepEqual(identityPairs('git -c user.email=b -c user.name=a commit.'), ['user.name=a', 'user.email=b']);
  assert.deepEqual(identityPairs('(git -c user.name=a -c user.email=b)'), ['user.name=a', 'user.email=b']);
});

test('identity_pairs: quoted pairs keep their spaces', () => {
  assert.deepEqual(
    identityPairs('git -c "user.name=Riley Q" -c \'user.email=r@x.invalid\' commit'),
    ['user.name=Riley Q', 'user.email=r@x.invalid'],
  );
  assert.deepEqual(identityPairs('git -c user.name="Riley Q" commit'), ['user.name=Riley Q']);
});

test('identity_pairs: keys are lower case and the last pair of a key wins', () => {
  assert.deepEqual(identityPairs('git -c User.Name=a -c user.name=c commit'), ['user.name=c']);
});

test('identity_pairs: no identity pair gives an empty list', () => {
  assert.deepEqual(identityPairs('plain ASCII, no trailers'), []);
  assert.deepEqual(identityPairs('git -c core.autocrlf=false commit'), []);
  assert.deepEqual(identityPairs(''), []);
  assert.deepEqual(identityPairs(null), []);
  assert.deepEqual(identityPairs(['git -c user.name=a commit']), []);
});
