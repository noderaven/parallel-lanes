// scripts/_transcripts.py: the transcript parsing run-report is built on.
// build_report must give exactly what run-report prints.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const FIX = join(SKILL_DIR, 'tests', 'fixtures', 'transcripts');
const MANIFEST = join(FIX, 'manifest.json');
const TMP = tempDir('pl-transcripts-');
after(() => rmSync(TMP, { recursive: true, force: true }));

// One usage line of an assistant message.
const usageLine = (id, model, input) => JSON.stringify({
  type: 'assistant', timestamp: '2026-10-02T10:00:00.000Z',
  message: { id, model, stop_reason: model === '<synthetic>' ? 'stop_sequence' : 'end_turn',
    usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});

// read_usage of a transcript holding `lines`, as {model, sums, models, complete}.
function readUsage(name, lines) {
  const path = join(TMP, `${name}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  const code = [
    'import json, sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _transcripts',
    `model, sums, models, complete, _u = _transcripts.read_usage(${JSON.stringify(path)})`,
    'print(json.dumps({"model": model, "sums": sums, "models": models, "complete": complete}))',
  ].join('\n');
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("build_report on the fixture equals run-report's output", () => {
  const code = [
    'import json, sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _transcripts',
    `with open(${JSON.stringify(MANIFEST)}, encoding="utf-8") as f:`,
    '    manifest = json.load(f)',
    `print(json.dumps(_transcripts.build_report(${JSON.stringify(FIX)}, manifest)))`,
  ].join('\n');
  const direct = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(direct.status, 0, direct.stderr);
  const cli = spawnSync('python3', [join(SCRIPTS, 'run-report'), FIX, MANIFEST], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const expected = JSON.parse(cli.stdout);
  assert.deepEqual(JSON.parse(direct.stdout), expected);
  assert.ok(expected.agents.length > 0);
});

test('a <synthetic> usage line never sets the model; its tokens still count', () => {
  // Claude Code writes an API error as an assistant message with model
  // <synthetic>. An agent that ends on one keeps its last real model...
  const ended = readUsage('ended', [usageLine('m1', 'claude-opus-4-6', 3), usageLine('m2', '<synthetic>', 2)]);
  assert.equal(ended.model, 'claude-opus-4-6');
  assert.deepEqual(ended.models, { 'claude-opus-4-6': 1 });
  assert.equal(ended.sums.input_tokens, 5);
  assert.equal(ended.sums.output_tokens, 2);
  // ...one in the middle changes nothing...
  const middle = readUsage('middle', [usageLine('m1', 'claude-sonnet-4-6', 1), usageLine('m2', '<synthetic>', 0),
    usageLine('m3', 'claude-opus-4-6', 1)]);
  assert.equal(middle.model, 'claude-opus-4-6');
  assert.deepEqual(middle.models, { 'claude-sonnet-4-6': 1, 'claude-opus-4-6': 1 });
  // ...and one with only synthetic lines has no resolved model.
  const only = readUsage('only', [usageLine('m1', '<synthetic>', 4), usageLine('m2', '<synthetic>', 0)]);
  assert.equal(only.model, null);
  assert.deepEqual(only.models, {});
  assert.equal(only.sums.input_tokens, 4);
  assert.equal(only.complete, true);
});
