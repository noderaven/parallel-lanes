// Shard 3 of 5 of tests/cleanup.cases.mjs (tests/shard.mjs): run-tests runs each shard in
// its own process.
globalThis.PL_TEST_SHARD = { index: 2, count: 5 };
await import('./cleanup.cases.mjs');
