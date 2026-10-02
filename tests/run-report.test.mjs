import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const SCRIPT = join(SKILL_DIR, 'scripts', 'run-report');
const FIX = join(SKILL_DIR, 'tests', 'fixtures', 'transcripts');
const MANIFEST = join(FIX, 'manifest.json');
const TMP = mkdtempSync(join(tmpdir(), 'pl-report-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

function run(args) {
  const r = spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const res = run([FIX, MANIFEST]);
const report = res.code === 0 ? JSON.parse(res.stdout) : null;
const find = (pred) => report.agents.find(pred);

test('exits 0 and prints JSON', () => {
  assert.equal(res.code, 0, res.stderr);
  assert.ok(report);
});

test('per-agent token sums and resolved model', () => {
  const a = find((x) => x.label === 'T1 implement' && x.tier === 'sonnet');
  assert.equal(a.input_tokens, 11);
  assert.equal(a.output_tokens, 7);
  assert.equal(a.cache_read_input_tokens, 103);
  assert.equal(a.cache_creation_input_tokens, 24);
  assert.equal(a.resolved_model, 'claude-sonnet-4-6');
  assert.equal(a.requested_model, 'sonnet');
  assert.equal(a.phase, 'Lane A');
  assert.equal(a.task, 'T1');
  assert.equal(a.role, 'implement');
});

test('per-tier and run totals sum only known values', () => {
  assert.equal(report.tiers.sonnet.agents, 5);
  assert.equal(report.tiers.sonnet.input_tokens, 28);
  assert.equal(report.tiers.opus.agents, 4);
  assert.equal(report.tiers.opus.input_tokens, 36);
  assert.equal(report.tiers.opus.cache_read_input_tokens, 59);
  assert.equal(report.totals.input_tokens, 64);
  assert.equal(report.totals.output_tokens, 40);
  assert.equal(report.totals.agents, 9);
});

test('a died agent is unavailable and counted', () => {
  const a = find((x) => x.label === 'T2 implement');
  assert.equal(a.input_tokens, 'unavailable');
  assert.equal(a.output_tokens, 'unavailable');
  assert.equal(a.resolved_model, 'unavailable');
  assert.equal(a.tier, 'sonnet');
  assert.equal(report.unavailable, 1);
});

test('an implement label rerun at a different model is an escalation under the earlier tier', () => {
  assert.equal(report.escalations, 1);
  assert.equal(report.tiers.sonnet.escalations, 1);
  assert.equal(report.tiers.opus.escalations, 0);
});

test('fix rounds are counted per tier', () => {
  assert.equal(report.fix_rounds, 2);
  assert.equal(report.tiers.sonnet.fix_rounds, 1);
  assert.equal(report.tiers.opus.fix_rounds, 1);
});

test('a retry label parses to its base label and is counted', () => {
  const retried = report.agents.filter((x) => x.label === 'T2 implement retry');
  assert.equal(retried.length, 1);
  assert.equal(retried[0].task, 'T2');
  assert.equal(retried[0].role, 'implement');
  assert.equal(report.retries, 1);
  // the retry is not an escalation: same model as the died attempt
  assert.equal(report.escalations, 1);
});

test('a phase label has task null and the full label as role', () => {
  const a = find((x) => x.label === 'final review sp');
  assert.equal(a.task, null);
  assert.equal(a.role, 'final review sp');
});

test('a batch range of manifest ids sets task; meta effort wins', () => {
  const a = find((x) => x.label === 'T3-T4 implement');
  assert.equal(a.task, 'T3-T4');
  assert.equal(a.role, 'implement');
  assert.equal(a.effort, 'xhigh');
});

test('effort: manifest rule for implement and fix, unavailable for review', () => {
  assert.equal(find((x) => x.label === 'T1 fix 1').effort, 'high');
  assert.equal(find((x) => x.label === 'T1 review').effort, 'unavailable');
  assert.equal(find((x) => x.label === 'final review sp').effort, 'unavailable');
});

test('--out writes the report to a file', () => {
  const out = join(TMP, 'report.json');
  const r = run([FIX, MANIFEST, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), report);
});

test('bad usage exits 2', () => {
  assert.equal(run([FIX]).code, 2);
  assert.equal(run([join(TMP, 'nope'), MANIFEST]).code, 2);
});

test('real meta shape: description, workflowPhase and absent model come through', () => {
  const a = find((x) => x.label === 'T2 fix 1');
  assert.equal(a.phase, 'Lane A');
  assert.equal(a.task, 'T2');
  assert.equal(a.role, 'fix 1');
  assert.equal(a.requested_model, 'unavailable');
  assert.equal(a.tier, 'sonnet');
  assert.equal(a.effort, 'high');
});

test('agents are ordered by first timestamp, not filename', () => {
  const labels = report.agents.map((x) => x.label);
  assert.equal(labels[0], 'T1 implement');
  assert.equal(report.agents[0].tier, 'sonnet');
  // agent-azz1 sorts last by name but ran first; escalation stays under sonnet
  assert.equal(report.tiers.sonnet.escalations, 1);
});

test('lines sharing a message id count that message once, with its last usage', () => {
  const dir = join(TMP, 'dedupe');
  mkdirSync(dir, { recursive: true });
  const usage = (output) => ({
    input_tokens: 5, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 20,
  });
  const line = (id, output, extra = {}) => JSON.stringify({
    type: 'assistant', requestId: id ? `req-${id}` : undefined, timestamp: '2026-10-02T10:00:00.000Z',
    message: { ...(id ? { id } : {}), model: 'opus-test', usage: usage(output) }, ...extra,
  });
  writeFileSync(join(dir, 'agent-b1.meta.json'),
    JSON.stringify({ description: 'T1 review', workflowPhase: 'Lane A', model: 'opus' }));
  writeFileSync(join(dir, 'agent-b1.jsonl'), [
    line('msg-1', 1), line('msg-1', 4), line('msg-1', 9),
    line('msg-2', 3),
    line(null, 2), line(null, 2),
  ].join('\n') + '\n');
  const r = run([dir, MANIFEST]);
  assert.equal(r.code, 0, r.stderr);
  const a = JSON.parse(r.stdout).agents[0];
  assert.equal(a.input_tokens, 5 * 4, 'msg-1 and msg-2 once each, plus two lines without an id');
  assert.equal(a.cache_read_input_tokens, 100 * 4);
  assert.equal(a.cache_creation_input_tokens, 20 * 4);
  assert.equal(a.output_tokens, 9 + 3 + 2 + 2, 'the last running output value of each message');
});

test('mid-stream usage lines (stop_reason null) make output a lower bound; fallback models are listed', () => {
  const dir = join(TMP, 'midstream');
  mkdirSync(dir, { recursive: true });
  const line = (id, model, output, stop) => JSON.stringify({
    type: 'assistant', requestId: `req-${id}`, timestamp: '2026-10-02T10:00:00.000Z',
    message: { id, model, stop_reason: stop, usage: {
      input_tokens: 1, output_tokens: output, cache_read_input_tokens: 10, cache_creation_input_tokens: 2,
    } },
  });
  writeFileSync(join(dir, 'agent-c1.meta.json'),
    JSON.stringify({ description: 'T1 implement', workflowPhase: 'Lane A', model: 'opus' }));
  writeFileSync(join(dir, 'agent-c1.jsonl'), [
    line('m1', 'opus-new', 7, null), line('m1', 'opus-new', 7, null),
    line('m2', 'opus-old', 96, 'tool_use'),
    line('m3', 'opus-old', 8, null),
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'agent-c2.meta.json'),
    JSON.stringify({ description: 'T1 review', workflowPhase: 'Lane A', model: 'opus' }));
  writeFileSync(join(dir, 'agent-c2.jsonl'), line('m9', 'opus-new', 50, 'end_turn') + '\n');
  const r = run([dir, MANIFEST]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const impl = out.agents.find((x) => x.label === 'T1 implement');
  assert.equal(impl.output_tokens, 'unavailable');
  assert.equal(impl.output_tokens_min, 7 + 96 + 8);
  assert.equal(impl.input_tokens, 3, 'input counts are complete at stream start');
  assert.deepEqual(impl.resolved_models, { 'opus-new': 1, 'opus-old': 2 });
  const rev = out.agents.find((x) => x.label === 'T1 review');
  assert.equal(rev.output_tokens, 50);
  assert.equal(out.output_incomplete, 1);
  assert.equal(out.totals.output_tokens, 50, 'totals sum only known values');
  assert.equal(out.totals.output_tokens_min, 7 + 96 + 8 + 50);
  assert.deepEqual(out.models, { 'opus-new': 2, 'opus-old': 1 });
});

test('resolved_models counts a message once even with a non-string requestId or a late model field', () => {
  const dir = join(TMP, 'modelcount');
  mkdirSync(dir, { recursive: true });
  const line = (id, model, rid) => JSON.stringify({
    type: 'assistant', requestId: rid, timestamp: '2026-10-02T10:00:00.000Z',
    message: { id, ...(model ? { model } : {}), usage: { input_tokens: 1, output_tokens: 1,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
  writeFileSync(join(dir, 'agent-d1.meta.json'),
    JSON.stringify({ description: 'T1 review', workflowPhase: 'Lane A', model: 'opus' }));
  writeFileSync(join(dir, 'agent-d1.jsonl'), [
    line('m1', 'opus-a', 7), line('m1', 'opus-a', 7), line('m1', 'opus-a', 7),
    line('m2', null, 'r2'), line('m2', 'opus-a', 'r2'),
  ].join('\n') + '\n');
  const r = run([dir, MANIFEST]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).agents[0].resolved_models, { 'opus-a': 2 });
});
