// Quote a string for a POSIX shell (single quotes, embedded ones escaped).
function shellQuote(s) {
  return "'" + String(s).split("'").join("'\\''") + "'";
}

// The shell-quoted Python that starts every helper of the skill: the
// manifest's python (scripts/find-python found it), python3 when unset.
function pythonCommand(m) {
  return shellQuote(m.python || 'python3');
}

// A non-empty string (an agent-reported sha, for instance).
function present(v) {
  return typeof v === 'string' && v.length > 0;
}

// A string with some text in it, not only whitespace (agent-reported
// evidence, for instance).
function hasText(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// A commit sha as an agent reports it: 7 to 40 lowercase hex digits. Any
// other head an agent reports (a note such as 'see below', a branch name)
// counts as no head: the run cannot tell which commit it means.
function isSha(v) {
  return typeof v === 'string' && /^[0-9a-f]{7,40}$/.test(v);
}

// Rules every agent gets, task and phase alike.
function agentRules() {
  return [
    'Never amend, rebase, reset, or force-update a branch. Decline commit-message findings with a reason; ' +
      'they are reported to the user.',
    'Do not invoke parallel-lanes or any plan-execution skill.',
    'Combine independent shell commands into one call (with && or ;) when no command depends on reading the ' +
      "previous one's output: every separate call costs a full turn.",
    'When your role requires running project checks or tests: ask for a 600000 ms (10 minute) timeout on each ' +
      'such command, and read the tool result to see whether the command finished, moved to the background, or ' +
      'was stopped by the timeout. A command running in the background has finished only when its completion ' +
      'notice or exit status says so, never when a line of its output appears (a failing run may never print ' +
      "that line). Before you start a check again, read the earlier run's result, or stop that run and confirm " +
      'it has ended. Do not finish your work while a check you were asked to run is still running or its ' +
      'result is unread.',
    'Change file contents with your file-editing tools (Edit, Write). Text written through shell heredocs, ' +
      'sed, or inline scripts can be corrupted by shell quoting (apostrophes, backslashes, $ and backticks). ' +
      "Running the project's own tools that change files is fine: generators (for example scripts/build), " +
      'formatters, codemods, and other maintenance commands.',
  ].join('\n');
}

// How an agent stays in its checkout: the session running the workflow may
// sit in another checkout of the same repo, and agents start there.
function checkoutRules(dir, branch) {
  const q = shellQuote(dir);
  return [
    'Your shell may start in another checkout of this repo, so never rely on the current directory:',
    `- every shell command starts with cd ${q} && or uses git -C ${q};`,
    `- every project file path you read or write is absolute under ${dir} (the plan, spec, brief, report,`,
    '  review, and ledger files named here are the only paths outside it);',
    `- before each commit, check that git -C ${q} rev-parse --abbrev-ref HEAD prints ${branch}; if it does not,`,
    '  do not commit: stop and report it.',
  ].join('\n');
}

// For agents in the feature checkout (the user's main checkout in git mode).
// The project's setup commands are exempt: they may recreate ignored files
// (npm ci replaces node_modules) and are part of the run.
function keepFilesRule() {
  return 'Never run git clean -x or git clean -X, and never delete ignored or untracked files: they may hold ' +
    "the user's .env files, local databases, or credentials. Exempt from this: the project's own setup commands " +
    '(for example npm ci recreating node_modules), which may replace ignored files; run them as given.';
}
