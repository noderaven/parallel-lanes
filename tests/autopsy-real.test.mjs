// scripts/autopsy on real transcript cases: the r150 and r142 lines that
// exposed three false positives of the first autopsy, kept as regression
// fixtures. Each fixture under tests/fixtures/autopsy-real/ is one real
// agent's transcript, trimmed to the lines that make the case and scrubbed
// (neutral paths under C:/u/, neutral tool and message ids, short commit
// ids). Timestamps, models and token counts are the real ones. Each wf_1.json
// starts 2 s before its agent and ends 2 s after it, so no idle gap shows.
// The tests copy a fixture to a temp dir first, since autopsy writes
// autopsy.json into the folder it reads.
//
// notice-in-output (r150, T3 review, 2026-10-10 22:09:01-22:09:14Z):
//   Bash 22:09:08.072-22:09:10.279  start-task prints the task brief, which
//     quotes 'Command running in background with ID' and 'timed out'
//   Read 22:09:13.019-22:09:13.913  the review package diff, which holds the
//     same table and fixture lines with a background and a timeout notice
//   Before e5032eb both calls counted as a timeout and a background run.
//
// heredoc-inline-script (r150, final review sp, 23:06:18-23:06:44Z; the
// prompt is moved from 23:01:40Z to just before the kept lines):
//   Bash 23:06:24.714-23:06:27.688  cat > probe3.py <<'EOF' ... EOF, then
//     python3 probe3.py on the next line; the write succeeds, the script
//     fails (UnicodeEncodeError), exit 1
//   Bash 23:06:43.362-23:06:44.798  the same for probe4.py, exit 0
//   e5032eb to v1.5.0 counted a heredoc_failure 23:06:24.714-23:06:44.798.
//
// overlapping-slowdowns (r142, A1 implement, 06:31:53-06:34:22Z):
//   Bash 06:32:01.950-06:34:08.275  blocks for its 120 s timeout, then moves
//     to the background (a real timeout)
//   three Edits sent in the same turn, 06:32:04.198, 06:32:05.632 and
//     06:32:07.785, all answered 06:34:08 with 'File has not been read yet'
//   three Reads, then the Edits again: engine.test.mjs ok 06:34:18.468,
//     run.test.mjs ok 06:34:18.485, rules.js fails (string not found) and
//     succeeds 06:34:22.083
//   The three edit_retry spans overlap: union 137.9 s, sum 401.5 s. Before
//   e5032eb the edit_retry suggestion's stake was the sum.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPT = join(SKILL_DIR, 'scripts', 'autopsy');
const FIXTURES = join(SKILL_DIR, 'tests', 'fixtures', 'autopsy-real');
const TMP = tempDir('pl-autopsy-real-');
after(() => rmSync(TMP, { recursive: true, force: true }));

function autopsy(name) {
  const dir = join(TMP, name);
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  const r = spawnSync('python3', [SCRIPT, dir, '--quiet'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = join(dir, 'autopsy.json');
  assert.ok(existsSync(out), 'autopsy.json written');
  return JSON.parse(readFileSync(out, 'utf8'));
}

const ofKind = (a, kind) => a.slowdowns.filter((s) => s.kind === kind);
const suggestion = (a, kind) => a.suggestions.find((s) => s.kind === kind);
const agentOf = (a, label) => a.time.agents.find((x) => x.label === label);
const T = (hms) => `2026-10-10T${hms}Z`;
const close = (actual, expected, what) =>
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= 0.15, `${what}: ${actual} != ${expected}`);

test('real r150 case: notice text in a Read or Bash output is no timeout or background run', () => {
  const a = autopsy('notice-in-output');
  // The agent and both calls were read, each with its result.
  const t3 = agentOf(a, 'T3 review');
  assert.ok(t3, 'T3 review is loaded');
  close(t3.tool_s, 3.1, 'T3 review tool time');
  assert.equal(a.detectors.timeout, 'ok');
  assert.equal(a.detectors.background_check, 'ok');
  // The output only quotes the markers: no notice of Claude Code's.
  assert.deepEqual(ofKind(a, 'timeout'), []);
  assert.deepEqual(ofKind(a, 'background_check'), []);
  assert.equal(suggestion(a, 'timeout'), undefined);
  assert.equal(suggestion(a, 'background_check'), undefined);
});

test('real r150 case: a failing script after a successful heredoc write is no heredoc failure', () => {
  const a = autopsy('heredoc-inline-script');
  const sp = agentOf(a, 'final review sp');
  assert.ok(sp, 'final review sp is loaded');
  close(sp.tool_s, 4.4, 'final review sp tool time');
  assert.equal(a.detectors.heredoc_failure, 'ok');
  // probe3.py was written; python3 failed on it.
  assert.deepEqual(ofKind(a, 'heredoc_failure'), []);
  assert.equal(suggestion(a, 'heredoc_failure'), undefined);
});

test('real r142 case: overlapping edit retries count their shared time once', () => {
  const a = autopsy('overlapping-slowdowns');
  assert.equal(a.detectors.edit_retry, 'ok');
  // Each failed Edit is still its own slowdown, with its own cost.
  const retries = ofKind(a, 'edit_retry')
    .map((s) => [s.agent, s.at, s.cost_s, s.cost_kind, s.evidence.tool, s.evidence.marker])
    .sort((x, y) => x[1].localeCompare(y[1]));
  assert.deepEqual(retries, [
    ['A1 implement', T('06:32:04.198'), 134.3, 'measured', 'Edit', 'has not been read yet'],
    ['A1 implement', T('06:32:05.632'), 132.9, 'measured', 'Edit', 'has not been read yet'],
    ['A1 implement', T('06:32:07.785'), 134.3, 'measured', 'Edit', 'has not been read yet'],
  ]);
  // The suggestion's stake is their union (06:32:04.198 to 06:34:22.083),
  // not the 401.5 s sum.
  const g = suggestion(a, 'edit_retry');
  assert.ok(g, 'an edit_retry suggestion');
  assert.equal(g.count, 3);
  close(g.stake_s, 137.9, 'edit_retry stake');
  const sum = retries.reduce((n, r) => n + r[2], 0);
  assert.ok(g.stake_s < sum, `stake ${g.stake_s} is below the sum ${sum}`);
  // The Bash call that held the Edits back really did time out.
  const timeouts = ofKind(a, 'timeout').map((s) => [s.agent, s.at, s.cost_s, s.cost_kind, s.evidence.tool]);
  assert.deepEqual(timeouts, [['A1 implement', T('06:32:01.950'), 126.3, 'measured', 'Bash']]);
});
