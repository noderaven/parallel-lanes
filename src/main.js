export const meta = {
  name: 'parallel-lanes',
  description: 'parallel-lanes v@VERSION@: Execute an implementation plan as parallel lanes of tasks with per-task review, then integrate.',
  phases: [
    { title: 'Pre-flight', detail: 'plan and spec conflicts' },
    { title: 'Prelude', detail: 'shared tasks on the feature branch' },
    { title: 'Integrate', detail: 'merge lanes, rerun all commands' },
    { title: 'Join', detail: 'tasks on the merged branch' },
    { title: 'E2E', detail: 'end-to-end hook' },
    { title: 'Final review', detail: 'three lenses, one fix round' },
    { title: 'Verify', detail: 'checks at the delivered revision, acceptance' },
  ],
};

// ---- Script body ----

// The skill version this script was built from (scripts/build stamps VERSION
// here and in the meta description): the version actually running. Logged
// first and returned with every result, dry runs included.
const VERSION = '@VERSION@';
log(`parallel-lanes v${VERSION} loaded`);

if (args !== null && typeof args === 'object' && args.dry_run === true) {
  const dry = normalizeManifestPaths(withDefaultHooks(args));
  const errors = validateManifest(dry);
  const agents = errors.length === 0 ? planAgents(dry) : [];
  return {
    version: VERSION,
    dry_run: true,
    errors,
    agents,
    lanes_effective: errors.length === 0 ? lanesEffective(dry, agents) : 0,
    // The exact lines the session prints at the launch; null when invalid.
    notices: errors.length === 0 ? launchNotices(dry, agents) : null,
  };
}

return { version: VERSION, ...(await runAll(args, { agent, log, phase, parallel })) };
