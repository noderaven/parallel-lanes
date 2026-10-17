// Shard 2 of 3 of tests/doctor.cases.mjs (tests/shard.mjs): run-tests runs each shard in
// its own process.
globalThis.PL_TEST_SHARD = { index: 1, count: 3 };
await import('./doctor.cases.mjs');
