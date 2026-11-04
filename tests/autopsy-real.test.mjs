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
//   The Edits queued behind the Bash call, so each is charged from the
//   result it waited for (06:34:08.275), not from its own tool_use: the
//   three edit_retry spans are 10.2, 10.2 and 13.8 s, overlapping from
//   06:34:08.275 to 06:34:22.083, so they are one row of 13.8 s (merged 3).
//   Before 1.6.11 they were three rows charged from their tool_use (union
//   137.9 s, sum 401.5 s), which counted the Bash call's timeout again.
//
// queued-timeout (r140, integrate, 02:31:13.6-02:35:44Z):
//   Bash 02:31:16.772-02:33:17.603  the run-checks call blocks for its 120 s
//     timeout and moves to the background (bxr6sy1ob)
//   Bash 02:31:17.130-02:33:17.768  cat join.jsonl | head, sent in the same
//     turn: queued behind it, answered 0.165 s after it
//   then the Monitor error, ToolSearch, two sleep loops on the task output
//     (02:33:22.332-02:35:14.635 and 02:35:16.523-02:35:32.378), the
//     notification 02:35:31.678 and the closing calls to 02:35:43.877
//   Before 1.6.11 the cat call counted as a 120 s long_tool_call, and the
//   background_check as its whole 134.1 s window, not the 129.3 s the agent
//   waited in it (loop 1, the gap between the loops, loop 2 to the notice).
//
// background-loop (r140, J1 implement, 02:38:10-02:51:00Z; the prompt is
// moved to just before the kept lines):
//   Bash 02:38:19.117-02:40:19.625  an inline script, then the test command;
//     it blocks for its 120 s timeout and moves to the background (b5vk9v50o)
//   Bash 02:40:21.814-02:40:22.389  sed and grep (no wait)
//   Bash 02:40:27.734-02:41:28.741  sed, cat >> a test file with a heredoc,
//     then sleep 60; tail -15 on the task output (a wait)
//   Bash 02:41:30.890-02:41:32.092  node --test on one file (no wait)
//   Monitor 02:41:35.427-02:41:35.428  'No such tool available' (a wait)
//   Bash 02:41:37.914-02:50:52.238  for i in $(seq 1 55); ... sleep 10; done
//     on the task output, which outlives the check
//   the notification 02:42:33.631; the run-checks call 02:50:54.555, kept
//     without its result (it came at 02:55:10, after the case)
//   The background window (02:40:19.625-02:42:33.631, 134.0 s) holds 119.2 s
//   of waiting: the sleep-and-tail call 61.007 + the Monitor call 0.001 + the
//   gap before the loop 2.486 + the loop to the notice 55.717. The loop's
//   rest (02:42:33.631-02:50:52.238) is its long_tool_call.
//
// background-not-waited (r150, final review sp, 23:01:55-23:04:15Z; the
// prompt is moved from 23:01:40Z to just before the kept lines):
//   Bash 23:02:01.867-23:02:04.849  git status --short && node
//     tests/run-tests.mjs > a log file, run_in_background (bzd46tr85)
//   21 short Bash and Read calls (reviews, diffs, greps) to 23:04:07.782,
//     none a wait
//   the notification 23:04:10.531, then cat on the task output
//     23:04:12.138-23:04:13.369, after the check ended
//   Before 1.6.11 the window (128.7 s) counted as a background_check though
//   the agent kept working; it is now no slowdown, counted in
//   checks.waits.background_not_waited.

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
  // The three failed Edits overlap: one row over their union (06:34:08.275
  // to 06:34:22.083), not the sum of their spans.
  const retries = ofKind(a, 'edit_retry')
    .map((s) => [s.agent, s.at, s.cost_s, s.cost_kind, s.evidence.tool, s.evidence.marker]);
  assert.deepEqual(retries, [
    ['A1 implement', T('06:34:08.275'), 13.8, 'measured', 'Edit', 'has not been read yet'],
  ]);
  assert.equal(ofKind(a, 'edit_retry')[0].merged, 3);
  const g = suggestion(a, 'edit_retry');
  assert.ok(g, 'an edit_retry suggestion');
  assert.equal(g.count, 1);
  close(g.stake_s, 13.8, 'edit_retry stake');
  // The Bash call that held the Edits back really did time out.
  const timeouts = ofKind(a, 'timeout').map((s) => [s.agent, s.at, s.cost_s, s.cost_kind, s.evidence.tool]);
  assert.deepEqual(timeouts, [['A1 implement', T('06:32:01.950'), 126.3, 'measured', 'Bash']]);
});

test('real r140 case: a call queued behind a timeout is no long call', () => {
  const a = autopsy('queued-timeout');
  assert.equal(a.detectors.long_tool_call, 'ok');
  assert.deepEqual(ofKind(a, 'long_tool_call'), []);
  const timeouts = ofKind(a, 'timeout').map((s) => [s.agent, s.at, s.cost_s, s.cost_kind, s.evidence.tool]);
  assert.deepEqual(timeouts, [['integrate', T('02:31:16.772'), 120.8, 'measured', 'Bash']]);
  // The wait inside the background window: loop 1 112.303 + the gap 1.888 +
  // loop 2 to the notice 15.155 (+ the Monitor error, 0.002).
  assert.deepEqual(ofKind(a, 'background_check').map((s) => [s.agent, s.at, s.cost_s, s.cost_kind, s.background_s]),
    [['integrate', T('02:33:17.603'), 129.3, 'bound', 134.1]]);
});

test('real r140 case: a wait loop that outlives its background check', () => {
  const a = autopsy('background-loop');
  const row = (s) => [s.agent, s.at, s.cost_s, s.cost_kind];
  assert.deepEqual(ofKind(a, 'timeout').map(row), [['J1 implement', T('02:38:19.117'), 120.5, 'measured']]);
  // Only the waiting inside the 134.0 s window counts.
  assert.deepEqual(ofKind(a, 'background_check').map((s) => [...row(s), s.span_s, s.background_s]),
    [['J1 implement', T('02:40:19.625'), 119.2, 'bound', 119.2, 134.0]]);
  // The loop past the notice is a long call of its own.
  assert.deepEqual(ofKind(a, 'long_tool_call').map((s) => [...row(s), s.span_s]),
    [['J1 implement', T('02:41:37.914'), 498.6, 'measured', 554.3]]);
  assert.equal(a.checks.waits.background_not_waited, 0);
});

test('real r150 case: a background suite the agent did not wait for is no slowdown', () => {
  const a = autopsy('background-not-waited');
  assert.equal(a.detectors.background_check, 'ok');
  assert.deepEqual(ofKind(a, 'background_check'), []);
  assert.equal(suggestion(a, 'background_check'), undefined);
  // Nor is the backgrounded call or any other a long call.
  assert.deepEqual(a.slowdowns, []);
  assert.equal(a.checks.waits.background_not_waited, 1);
  const md = readFileSync(join(TMP, 'background-not-waited', 'autopsy.md'), 'utf8');
  assert.match(md, /^Background commands not waited for: 1\.$/m);
});
