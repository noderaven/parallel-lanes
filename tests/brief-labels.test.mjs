import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

// task-brief and derive-lanes read the same Consumes and Produces label
// forms: a '-', '*' or '+' bullet, the label bold or not, any case.

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = tempDir('pl-brief-labels-');
after(() => rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
// Write a plan into a fresh directory whose path contains a space.
function planFile(text) {
  counter += 1;
  const dir = join(TMP, `case ${counter}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'plan.md');
  writeFileSync(path, text);
  return path;
}

function run(name, ...args) {
  const res = spawnSync('python3', [join(SCRIPTS, name), ...args], { encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// The brief task-brief writes for taskId.
function brief(plan, taskId) {
  const out = join(plan, '..', `${taskId}.md`);
  const res = run('task-brief', plan, taskId, out);
  assert.equal(res.code, 0, res.stderr);
  return readFileSync(out, 'utf8');
}

// derive-lanes' deps for taskId.
function deps(plan, taskId) {
  const res = run('derive-lanes', plan);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout).tasks.find((t) => t.id === taskId).deps;
}

const HEADING = '## Produces of Task P1: Producer (consumed by this task)';

// A plan with producer P1 and consumer C1; the given lines go into each
// task's body.
function plan(producerLines, consumerLines) {
  return [
    '# Plan',
    '',
    '### Task P1: Producer',
    '',
    '**Files:** Create `src/p.py`.',
    '',
    ...producerLines,
    '',
    '- [ ] Step 1: make it.',
    '',
    '### Task C1: Consumer',
    '',
    '**Files:** Create `src/c.py`.',
    '',
    ...consumerLines,
    '- [ ] Step 1: use it.',
    '',
  ].join('\n');
}

const PRODUCES = ['- Produces: `made()` returns 7.', '  It never raises.'];
const C1_SECTION = (consumes) =>
  [
    '### Task C1: Consumer',
    '',
    '**Files:** Create `src/c.py`.',
    '',
    ...consumes,
    '- [ ] Step 1: use it.',
  ].join('\n');

test('bold labels reach the brief', () => {
  const produces = ['- **Produces:** `made()` returns 7.', '  It never raises.'];
  const consumes = ['- **Consumes:** Task P1'];
  const path = planFile(plan(produces, consumes));
  assert.equal(
    brief(path, 'C1'),
    `${C1_SECTION(consumes)}\n\n${HEADING}\n\n${produces.join('\n')}\n`,
  );
  assert.deepEqual(deps(path, 'C1'), ['P1']);
});

test('every Consumes form derive-lanes accepts works in briefs', () => {
  for (const line of [
    '- **Consumes**: Task P1',
    '* Consumes: Task P1',
    '+ consumes: Task P1',
    '- Consumes Task P1',
  ]) {
    const path = planFile(plan(PRODUCES, [line]));
    assert.deepEqual(deps(path, 'C1'), ['P1'], line);
    assert.equal(
      brief(path, 'C1'),
      `${C1_SECTION([line])}\n\n${HEADING}\n\n${PRODUCES.join('\n')}\n`,
      line,
    );
  }
});

test('the Produces forms work', () => {
  for (const label of ['- **Produces**:', '* Produces:', '+ produces:']) {
    const produces = [`${label} \`made()\` returns 7.`, '  It never raises.'];
    const path = planFile(plan(produces, ['- Consumes: Task P1']));
    assert.ok(
      brief(path, 'C1').endsWith(`${HEADING}\n\n${produces.join('\n')}\n`),
      label,
    );
  }
});

test('a step bullet without a colon is not the Produces block', () => {
  const produces = ['- produces a cache file', ...PRODUCES];
  const path = planFile(plan(produces, ['- Consumes: Task P1']));
  assert.ok(brief(path, 'C1').endsWith(`${HEADING}\n\n${PRODUCES.join('\n')}\n`));
});

// Built with task-brief before the label forms were widened.
const PLAIN_BRIEF = [
  '### Task C1: Consumer',
  '',
  '**Files:** Create `src/c.py`.',
  '',
  '- Consumes: Task P1',
  '- [ ] Step 1: use it.',
  '',
  '## Produces of Task P1: Producer (consumed by this task)',
  '',
  '- Produces: `made()` returns 7.',
  '  It never raises.',
  '',
].join('\n');

test('plain labels are unchanged', () => {
  const path = planFile(plan(PRODUCES, ['- Consumes: Task P1']));
  assert.equal(brief(path, 'C1'), PLAIN_BRIEF);
});

test('a label inside fenced code still does not count', () => {
  const produces = ['```', '- **Produces:** `fake()` returns 0.', '```', '', ...PRODUCES];
  const fencedConsumes = ['```', '- **Consumes:** Task P1', '```', ''];
  const path = planFile(plan(produces, fencedConsumes));
  assert.equal(brief(path, 'C1'), `${C1_SECTION(fencedConsumes)}\n`);
  const consumed = planFile(plan(produces, ['- **Consumes:** Task P1']));
  assert.ok(brief(consumed, 'C1').endsWith(`${HEADING}\n\n${PRODUCES.join('\n')}\n`));
});
