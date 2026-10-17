// Shard 1 of 2 of tests/shadow.cases.mjs (tests/shard.mjs): run-tests runs each shard in
// its own process.
globalThis.PL_TEST_SHARD = { index: 0, count: 2 };
await import('./shadow.cases.mjs');
