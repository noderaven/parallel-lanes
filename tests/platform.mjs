// Shared helpers that let the tests run on Linux, macOS and native Windows.
//
// IS_WINDOWS: running on native Windows (not WSL, which reports linux).
// BASH: the bash to start from Node. On Windows a bare 'bash' can resolve to
//   WSL's launcher in System32, so the tests use CLAUDE_CODE_GIT_BASH_PATH,
//   else Git for Windows' standard bash.exe when it exists, else 'bash'.
//   Elsewhere it is 'bash' from PATH.
// SYMLINKS: whether fs.symlinkSync works here (Windows without Developer
//   Mode or admin rights refuses it).
// samePath(a, b): whether two paths name the same place, after resolving
//   them and, on Windows, ignoring separator and case differences, reading
//   Git Bash's /c/x as C:/x and its other paths (/tmp/x) through cygpath,
//   and expanding 8.3 short names (RUNNER~1) of the parts that exist.
// tempDir(prefix): a new temporary directory. On Windows its path has the
//   long names (os.tmpdir() can hold an 8.3 short name such as RUNNER~1,
//   which the scripts' own paths never use).
// withPath(env, path): a copy of env whose PATH is path. On Windows the
//   variable is spelled Path, and a second PATH key would leave the child
//   with either one, so every spelling is replaced.
// pathList(...dirs): dirs joined with the platform's list separator.
// lf(text): text with CRLF line ends read as LF (output of a Python or a
//   tool that is not one of the skill's helpers).
// nativeWhich(name): the absolute path of a tool on PATH, in the host's form
//   (on Windows a C:\ path, which fs.symlinkSync and Node can use).

import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const IS_WINDOWS = process.platform === 'win32';

const STANDARD_GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

function findBash() {
  if (!IS_WINDOWS) return 'bash';
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) return process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (existsSync(STANDARD_GIT_BASH)) return STANDARD_GIT_BASH;
  return 'bash';
}

export const BASH = findBash();

function canSymlink() {
  const dir = mkdtempSync(join(tmpdir(), 'pl-symlink-probe-'));
  try {
    writeFileSync(join(dir, 'target'), '');
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const SYMLINKS = canSymlink();

export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return IS_WINDOWS ? realpathSync.native(dir) : dir;
}

export function withPath(env, path) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() !== 'PATH') out[k] = v;
  out.PATH = path;
  return out;
}

// mergeEnv(...parts): the parts merged left to right, like object spread,
//   except that a PATH in a later part replaces every spelling of PATH
//   before it (on Windows process.env spells it Path).
export function mergeEnv(...parts) {
  const out = {};
  for (const part of parts) {
    for (const [k, v] of Object.entries(part || {})) {
      if (k.toUpperCase() === 'PATH') for (const key of Object.keys(out)) if (key.toUpperCase() === 'PATH') delete out[key];
      out[k] = v;
    }
  }
  return out;
}

export function pathList(...dirs) {
  return dirs.join(delimiter);
}

export function lf(text) {
  return String(text).replace(/\r\n/g, '\n');
}

export function nativeWhich(name) {
  const found = spawnSync(BASH, ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
  if (!IS_WINDOWS || !found) return found;
  return spawnSync(BASH, ['-c', 'cygpath -w "$1"', 'cygpath', found], { encoding: 'utf8' }).stdout.trim();
}

// The long form of p's longest existing part, with the rest appended.
function longNames(p) {
  let head = p;
  const rest = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return p;
    rest.unshift(head.slice(up.length).replace(/^[\\/]/, ''));
    head = up;
  }
  return join(realpathSync.native(head), ...rest);
}

function normalize(p) {
  if (!IS_WINDOWS) return resolve(p);
  let q = p;
  // Git Bash prints /c/x for C:/x (pwd, for one), and /tmp/x for its own mounts.
  if (/^\/[a-zA-Z](\/|$)/.test(q)) q = q.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/');
  else if (q.startsWith('/')) {
    q = spawnSync(BASH, ['-c', 'cygpath -m "$1"', 'cygpath', q], { encoding: 'utf8' }).stdout.trim() || q;
  }
  return longNames(resolve(q)).replace(/\\/g, '/').toLowerCase();
}

export function samePath(a, b) {
  return normalize(a) === normalize(b);
}
