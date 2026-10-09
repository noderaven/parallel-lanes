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

// Rules every agent gets, task and phase alike.
function agentRules() {
  return [
    'Never amend, rebase, reset, or force-update a branch. Decline commit-message findings with a reason; ' +
      'they are reported to the user.',
    'Do not invoke parallel-lanes or any plan-execution skill.',
    'Combine independent shell commands into one call (with && or ;) when no command depends on reading the ' +
      "previous one's output: every separate call costs a full turn.",
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
