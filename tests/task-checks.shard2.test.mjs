// Shard 2 of 2 of tests/task-checks.cases.mjs (tests/shard.mjs): run-tests runs each shard in
// its own process.
globalThis.PL_TEST_SHARD = { index: 1, count: 2 };
await import('./task-checks.cases.mjs');
