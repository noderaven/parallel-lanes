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
//   them and, on Windows, ignoring separator and case differences and
//   reading Git Bash's /c/x as C:/x.

import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

function normalize(p) {
  if (!IS_WINDOWS) return resolve(p);
  // Git Bash prints /c/x for C:/x (pwd, for one).
  const drive = p.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/');
  return resolve(drive).replace(/\\/g, '/').toLowerCase();
}

export function samePath(a, b) {
  return normalize(a) === normalize(b);
}
