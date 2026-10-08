export const meta = {
  name: 'parallel-lanes',
  description: 'Execute an implementation plan as parallel lanes of tasks with per-task review, then integrate.',
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

if (args !== null && typeof args === 'object' && args.dry_run === true) {
  const errors = validateManifest(args);
  const agents = errors.length === 0 ? planAgents(args) : [];
  return {
    dry_run: true,
    errors,
    agents,
    lanes_effective: errors.length === 0 ? lanesEffective(args, agents) : 0,
  };
}

return await runAll(args, { agent, log, phase, parallel });
