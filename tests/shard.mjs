// Splits one slow test file across several processes. Its tests live in
// tests/<name>.cases.mjs, which imports test from here instead of node:test;
// each tests/<name>.shard<k>.test.mjs sets globalThis.PL_TEST_SHARD to
// { index: k - 1, count: n } and imports the cases file, and this test()
// registers only every n-th test, starting at that index. run-tests runs the
// shard files like any others, a few processes at once. Without a shard
// setting (node --test tests/<name>.cases.mjs, or tests/index.js) every test
// is registered.
import { test as nodeTest } from 'node:test';

const shard = globalThis.PL_TEST_SHARD;
if (shard !== undefined) {
  const ok = shard !== null && typeof shard === 'object'
    && Number.isInteger(shard.count) && shard.count >= 1
    && Number.isInteger(shard.index) && shard.index >= 0 && shard.index < shard.count;
  if (!ok) throw new Error(`PL_TEST_SHARD must be { index, count } with 0 <= index < count, not ${JSON.stringify(shard)}`);
}

let registered = 0;

export function test(...args) {
  const n = registered;
  registered += 1;
  if (shard !== undefined && n % shard.count !== shard.index) return undefined;
  return nodeTest(...args);
}
