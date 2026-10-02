// Offline harness for run.workflow.js.
//
// The Workflow tool runs the script body inside an async function with the
// globals args, agent, parallel, pipeline, phase and log. This harness does
// the same with stubs so the script can be exercised under node:test. The
// script is built from src/ in memory (scripts/build --out -), so tests run
// the modules as they are, not the committed run.workflow.js.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
// The committed build output: the file the Workflow tool runs.
export const SCRIPT_PATH = join(SKILL_DIR, 'run.workflow.js');

const GLOBALS = ['args', 'agent', 'parallel', 'pipeline', 'phase', 'log'];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// The script as scripts/build concatenates it from src/; built once per
// process (src/ does not change during a test run).
let built = null;
function buildScript() {
  if (built === null) {
    built = execFileSync('bash', ['scripts/build', '--out', '-'], { cwd: SKILL_DIR, encoding: 'utf8' });
  }
  return built;
}

// The script body with the leading `export` removed from the meta line, so
// it can be evaluated as the body of a function.
function scriptBody() {
  const source = buildScript();
  if (!/^export const meta = /.test(source)) {
    throw new Error('the built script must begin with "export const meta = "');
  }
  return source.replace(/^export /, '');
}

function notStubbed(name) {
  return () => {
    throw new Error(`harness: ${name}() called but no stub was provided`);
  };
}

// Run the whole script body with the given stubs and return its result.
// Missing stubs: phase and log are no-ops; agent, parallel and pipeline throw.
export async function loadScript(stubs = {}) {
  const defaults = {
    args: undefined,
    agent: notStubbed('agent'),
    parallel: notStubbed('parallel'),
    pipeline: notStubbed('pipeline'),
    phase: () => {},
    log: () => {},
  };
  const env = { ...defaults, ...stubs };
  const run = new AsyncFunction(...GLOBALS, scriptBody());
  return run(...GLOBALS.map((name) => env[name]));
}

// Expose the named top-level functions of the script for unit tests.
// The return is placed before the body (function declarations are hoisted),
// so the script's run logic never executes. Consequence: a helper loaded this
// way must not read top-level const/let bindings of the script.
export async function loadHelpers(names) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error('harness: loadHelpers needs a non-empty list of function names');
  }
  const body = `return { ${names.join(', ')} };\n${scriptBody()}`;
  const run = new AsyncFunction(...GLOBALS, body);
  const helpers = await run(...GLOBALS.map(() => undefined));
  for (const name of names) {
    if (typeof helpers[name] !== 'function') {
      throw new Error(`harness: ${name} is not a function in the script built from src/`);
    }
  }
  return helpers;
}
