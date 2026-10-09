// scripts/_shell.py: finding Git Bash, the one Windows path form, and LF
// UTF-8 output. Each test runs a Python snippet with scripts/ on sys.path
// and reads its JSON output. Platform, environment, which and isfile are
// injected, so the Windows rules are exercised on every platform.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'pl-platform-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

const PRELUDE = [
  'import json, os, sys',
  `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
  'import _shell',
  'def attempt(f):',
  '    try:',
  "        return {'ok': f()}",
  '    except Exception as e:',
  "        return {'error': type(e).__name__, 'message': str(e)}",
  'def files(*paths):',
  '    return lambda p: p in paths',
  'def found(path):',
  '    return lambda name: path if name == "bash" else None',
  '',
].join('\n');

// Runs PRELUDE + code; code prints one JSON value, returned parsed.
function py(code, env = {}) {
  const res = spawnSync('python3', ['-c', PRELUDE + code], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(res.status, 0, `python failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

const WIN_ENV = "{'SystemRoot': 'C:\\\\Windows', 'LOCALAPPDATA': 'C:\\\\Users\\\\me\\\\AppData\\\\Local'}";
const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';

test('find_bash uses CLAUDE_CODE_GIT_BASH_PATH first on Windows', () => {
  const out = py(`print(json.dumps(attempt(lambda: _shell.find_bash(
    env={'CLAUDE_CODE_GIT_BASH_PATH': 'D:/tools/Git/bin/bash.exe'},
    platform='win32',
    which=found('C:/Program Files/Git/bin/bash.exe'),
    isfile=files('D:/tools/Git/bin/bash.exe', '${GIT_BASH}')))))`);
  assert.deepEqual(out, { ok: 'D:/tools/Git/bin/bash.exe' });
});

test('find_bash rejects a bad CLAUDE_CODE_GIT_BASH_PATH', () => {
  // Never a silent fallback: a bash on PATH and in the standard place exist.
  const out = py(`print(json.dumps([attempt(lambda: _shell.find_bash(
    env={'CLAUDE_CODE_GIT_BASH_PATH': value},
    platform='win32',
    which=found('${GIT_BASH}'),
    isfile=files('C:/Git/bin/git.exe', '${GIT_BASH}')))
    for value in ['C:/Git/bin', 'C:/Git/bin/git.exe']]))`);
  assert.equal(out.length, 2);
  for (const r of out) {
    assert.equal(r.error, 'BashNotFound', JSON.stringify(r));
    assert.match(r.message, /CLAUDE_CODE_GIT_BASH_PATH/);
  }
  assert.match(out[0].message, /C:\/Git\/bin\b/);
  assert.match(out[1].message, /git\.exe/);
});

test('find_bash accepts the names Claude Code allows for CLAUDE_CODE_GIT_BASH_PATH', () => {
  const out = py(`print(json.dumps([attempt(lambda: _shell.find_bash(
    env={'CLAUDE_CODE_GIT_BASH_PATH': value},
    platform='win32',
    which=found(None),
    isfile=files(value)))
    for value in ['D:\\\\Git\\\\bin\\\\BASH.EXE', 'D:/x/bash', 'D:/x/sh.exe', 'D:/x/sh']]))`);
  assert.deepEqual(out, [
    { ok: 'D:/Git/bin/BASH.EXE' },
    { ok: 'D:/x/bash' },
    { ok: 'D:/x/sh.exe' },
    { ok: 'D:/x/sh' },
  ]);
});

// WIN_ENV with PATH set to the given folders, as a Python dict literal.
const winEnv = (...folders) => `dict(${WIN_ENV}, PATH=${JSON.stringify(folders.join(';'))})`;

test('find_bash skips WSL launchers on PATH', () => {
  const out = py(`print(json.dumps([attempt(lambda: _shell.find_bash(
    env=dict(${WIN_ENV}, PATH=folder),
    platform='win32',
    which=found(None),
    isfile=files(launcher, '${GIT_BASH}')))
    for folder, launcher in [
      ('C:\\\\Windows\\\\System32', 'C:/Windows/System32/bash.exe'),
      ('c:/windows/SYSTEM32', 'C:/windows/SYSTEM32/bash.exe'),
      ('C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Microsoft\\\\WindowsApps',
       'C:/Users/me/AppData/Local/Microsoft/WindowsApps/bash.exe'),
      ('c:/users/ME/appdata/local/microsoft/windowsapps', 'C:/users/ME/appdata/local/microsoft/windowsapps/bash.exe'),
    ]]))`);
  assert.deepEqual(out, Array(4).fill({ ok: GIT_BASH }));
});

test('find_bash keeps searching PATH after a WSL launcher', () => {
  const out = py(`print(json.dumps(attempt(lambda: _shell.find_bash(
    env=${winEnv('C:\\Windows\\System32', 'D:\\Git\\usr\\bin')},
    platform='win32',
    which=found('C:/Windows/System32/bash.exe'),
    isfile=files('C:/Windows/System32/bash.exe', 'D:/Git/usr/bin/bash.exe', '${GIT_BASH}')))))`);
  assert.deepEqual(out, { ok: 'D:/Git/usr/bin/bash.exe' });
});

test('find_bash finds Git Bash from the cmd folder of Git on PATH', () => {
  const out = py(`print(json.dumps(attempt(lambda: _shell.find_bash(
    env=${winEnv('C:/Windows/System32', '"D:\\Tools\\Git\\cmd"')},
    platform='win32',
    which=found(None),
    isfile=files('C:/Windows/System32/bash.exe', 'D:/Tools/Git/cmd/git.exe',
                 'D:/Tools/Git/bin/bash.exe', '${GIT_BASH}')))))`);
  assert.deepEqual(out, { ok: 'D:/Tools/Git/bin/bash.exe' });
});

test('find_bash ignores relative PATH folders, the current directory and bash.cmd', () => {
  // Windows' own search would return .\\bash.exe from the current directory,
  // or a bash.cmd that routes -c through cmd.exe; neither is Git Bash.
  // Every relative path exists here, so only the absolute rule keeps them out.
  const out = py(`print(json.dumps(attempt(lambda: _shell.find_bash(
    env=${winEnv('', '.', 'tools', '.\\\\bin', 'C:/x')},
    platform='win32',
    which=found('.\\\\bash.exe'),
    isfile=lambda p: p in ('${GIT_BASH}', 'C:/x/bash.cmd', 'C:/x/bash.bat')
        or not _shell._absolute_windows(p)))))`);
  assert.deepEqual(out, { ok: GIT_BASH });
});

test('find_bash falls back to the x86 Git folder', () => {
  const out = py(`print(json.dumps(attempt(lambda: _shell.find_bash(
    env=${WIN_ENV},
    platform='win32',
    which=found(None),
    isfile=files('C:/Program Files (x86)/Git/bin/bash.exe')))))`);
  assert.deepEqual(out, { ok: 'C:/Program Files (x86)/Git/bin/bash.exe' });
});

test('find_bash prefers the Git bin launcher over usr/bin', () => {
  const out = py(`print(json.dumps([attempt(lambda: _shell.find_bash(
    platform='win32',
    env=dict(${WIN_ENV}, PATH=folder),
    which=found(None),
    isfile=files(onpath, '${GIT_BASH}', 'C:/program files/git/bin/bash.exe')))
    for folder, onpath in [
      ('C:\\\\Program Files\\\\Git\\\\usr\\\\bin', 'C:/Program Files/Git/usr/bin/bash.exe'),
      ('c:/program files/git/USR/BIN', 'C:/program files/git/USR/BIN/bash.exe'),
    ]]))`);
  assert.deepEqual(out, [{ ok: GIT_BASH }, { ok: 'C:/program files/git/bin/bash.exe' }]);
  // Without the launcher the usr/bin bash is kept.
  const kept = py(`print(json.dumps(attempt(lambda: _shell.find_bash(
    env=${winEnv('D:\\Git\\usr\\bin')},
    platform='win32',
    which=found(None),
    isfile=files('D:/Git/usr/bin/bash.exe')))))`);
  assert.deepEqual(kept, { ok: 'D:/Git/usr/bin/bash.exe' });
});

test('find_bash fails clearly when nothing is found', () => {
  const out = py(`print(json.dumps(attempt(lambda: _shell.find_bash(
    env=${WIN_ENV},
    platform='win32',
    which=found(None),
    isfile=files()))))`);
  assert.equal(out.error, 'BashNotFound');
  assert.match(out.message, /CLAUDE_CODE_GIT_BASH_PATH/);
});

test('find_bash on Linux and macOS is the bash on PATH and ignores the Windows variable', () => {
  const out = py(`print(json.dumps([attempt(lambda: _shell.find_bash(
    env={'CLAUDE_CODE_GIT_BASH_PATH': '/x'},
    platform=plat,
    which=found('/usr/bin/bash'),
    isfile=files()))
    for plat in ['linux', 'darwin']]))`);
  assert.deepEqual(out, [{ ok: '/usr/bin/bash' }, { ok: '/usr/bin/bash' }]);
  const none = py(`print(json.dumps(attempt(lambda: _shell.find_bash(
    env={}, platform='linux', which=found(None), isfile=files()))))`);
  assert.equal(none.error, 'BashNotFound');
});

test('find_bash with defaults and bash_argv use the bash on PATH', () => {
  const out = py(`import shutil
first = _shell.find_bash()
# An injected call neither reads nor replaces the cached default.
injected = _shell.find_bash(env={}, platform='linux', which=found('/other/bash'), isfile=files())
print(json.dumps({'first': first, 'injected': injected, 'again': _shell.find_bash(),
  'which': shutil.which('bash'), 'argv': _shell.bash_argv('-c', 'true')}))`);
  if (process.platform === 'win32') {
    // Windows: Git Bash in C:/ form, never a WSL launcher, whatever which says.
    assert.match(out.first, /^[A-Z]:\/[^\\]*bash\.exe$/i, out.first);
    assert.doesNotMatch(out.first, /\/system32\/|\/windowsapps\//i, out.first);
  } else {
    assert.equal(out.first, out.which);
  }
  assert.equal(out.injected, '/other/bash');
  assert.equal(out.again, out.first);
  assert.deepEqual(out.argv, [out.first, '-c', 'true']);
});

test('native_path gives one Windows form', () => {
  let cygpath;
  if (process.platform === 'win32') {
    cygpath = join(TMP, 'cygpath.cmd');
    writeFileSync(cygpath, '@echo C:/Users/me/AppData/Local/Temp/x\r\n');
  } else {
    cygpath = join(TMP, 'cygpath');
    writeFileSync(cygpath, '#!/bin/sh\n[ "$1" = -m ] || exit 9\necho "C:/Users/me/AppData/Local/Temp/x"\n');
    chmodSync(cygpath, 0o755);
  }
  const out = py(`cyg = ${JSON.stringify(cygpath)}
win = lambda p: _shell.native_path(p, platform='win32', cygpath=cyg)
print(json.dumps({
  'back': win('C:\\\\Users\\\\me\\\\x'),
  'lower': win('c:/Users/me'),
  'msys': win('/c/Users/me'),
  'msys_root': win('/c'),
  'drive_root': win('D:\\\\'),
  'posix': win('/tmp/x'),
  'linux': [_shell.native_path(p, platform='linux') for p in ['/tmp/x', 'C:\\\\x', '/c/x']],
}))`);
  assert.deepEqual(out, {
    back: 'C:/Users/me/x',
    lower: 'C:/Users/me',
    msys: 'C:/Users/me',
    msys_root: 'C:/',
    drive_root: 'D:/',
    posix: 'C:/Users/me/AppData/Local/Temp/x',
    linux: ['/tmp/x', 'C:\\x', '/c/x'],
  });
});

// A fake cygpath (a .cmd on Windows, a sh script elsewhere) running the given body.
function fakeCygpath(name, posixBody, windowsBody) {
  if (process.platform === 'win32') {
    const file = join(TMP, `${name}.cmd`);
    writeFileSync(file, `@${windowsBody}\r\n`);
    return file;
  }
  const file = join(TMP, name);
  writeFileSync(file, `#!/bin/sh\n${posixBody}\n`);
  chmodSync(file, 0o755);
  return file;
}

test('native_path decodes cygpath output as UTF-8 whatever the locale', () => {
  // cygpath prints UTF-8 bytes; the child Python runs in a non-UTF-8 locale.
  const cygpath = fakeCygpath(
    'cygpath-utf8',
    "[ \"$1\" = -m ] || exit 9\nprintf 'C:/Users/Jos\\303\\251/AppData/Local/Temp/x\\n'",
    `"${process.execPath}" -e "process.stdout.write('C:/Users/Jos\\u00e9/AppData/Local/Temp/x\\n')"`,
  );
  const out = py(`print(json.dumps(attempt(lambda: _shell.native_path(
    '/tmp/x', platform='win32', cygpath=${JSON.stringify(cygpath)}))))`,
  { LC_ALL: 'C', LANG: 'C', PYTHONUTF8: '0', PYTHONCOERCECLOCALE: '0' });
  assert.deepEqual(out, { ok: 'C:/Users/Jos\u00e9/AppData/Local/Temp/x' });
});

test('native_path fails clearly without cygpath for a POSIX path on Windows', () => {
  const failing = fakeCygpath('cygpath-fails', 'echo broken >&2\nexit 1', 'exit /b 1');
  const out = py(`print(json.dumps([attempt(lambda: _shell.native_path(
    '/tmp/x', platform='win32', cygpath=cyg))
    for cyg in [${JSON.stringify(join(TMP, 'missing', 'cygpath.exe'))}, ${JSON.stringify(failing)}]]))`);
  assert.equal(out.length, 2);
  for (const r of out) {
    assert.equal(r.error, 'CygpathNotFound', JSON.stringify(r));
    assert.match(r.message, /cygpath/);
    assert.match(r.message, /\/tmp\/x/);
    assert.match(r.message, /CLAUDE_CODE_GIT_BASH_PATH/);
  }
  assert.match(out[1].message, /exited 1/);
});

test('native_path finds cygpath next to the Git Bash find_bash returns', () => {
  const out = py(`_shell.find_bash = lambda: 'C:/NoSuchGit/bin/bash.exe'
print(json.dumps(attempt(lambda: _shell.native_path('/tmp/x', platform='win32'))))`);
  assert.ok(out.error, JSON.stringify(out));
  assert.match(out.message, /C:\/NoSuchGit\/usr\/bin\/cygpath\.exe/);
});

test('write_text and setup_io write LF only', () => {
  const file = join(TMP, 'lf.txt');
  py(`_shell.write_text(${JSON.stringify(file)}, 'a\\nb\\n\\u00e9\\n')
print('null')`);
  const bytes = readFileSync(file);
  assert.ok(!bytes.includes(0x0d), 'no carriage return in the file');
  assert.equal(bytes.toString('utf8'), 'a\nb\n\u00e9\n');

  // A child that calls setup_io: LF and UTF-8 even when Python was told otherwise.
  const child = spawnSync('python3', ['-c', [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _shell',
    '_shell.setup_io()',
    "print('a\\nb')",
    "print('\\u00e9')",
    "print('\\u00e9', file=sys.stderr)",
  ].join('\n')], { env: { ...process.env, PYTHONIOENCODING: 'latin-1' } });
  assert.equal(child.status, 0, String(child.stderr));
  assert.ok(!child.stdout.includes(0x0d), 'no carriage return on stdout');
  assert.equal(child.stdout.toString('utf8'), 'a\nb\n\u00e9\n');
  assert.equal(child.stderr.toString('utf8'), '\u00e9\n');
});
