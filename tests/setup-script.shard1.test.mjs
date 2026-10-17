// Shard 1 of 3 of tests/setup-script.cases.mjs (tests/shard.mjs): run-tests runs each shard in
// its own process.
globalThis.PL_TEST_SHARD = { index: 0, count: 3 };
await import('./setup-script.cases.mjs');
