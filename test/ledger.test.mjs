import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, LedgerError } from '../src/ledger.mjs';
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'webhook-ledger-test-'));
  const path = join(root, 'ledger.sqlite');
  const ledger = new Ledger(path, options);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, ledger };
}
const code = expected => error => error instanceof LedgerError && error.code === expected;

test('deduplicates retained identifiers across batches and restarts', t => {
  const { path, ledger } = fixture(t);
  const first = ledger.record('fictional-one');
  const repeated = ledger.recordBatch(['fictional-one', 'fictional-two', 'fictional-two']);
  assert.equal(first.inserted, true);
  assert.equal(repeated[0].receipt, first.receipt);
  assert.deepEqual(repeated.map(item => item.inserted), [false, true, false]);
  ledger.close();
  const reopened = new Ledger(path);
  try { assert.equal(reopened.record('fictional-one').receipt, first.receipt); assert.equal(reopened.stats().retained, 2); }
  finally { reopened.close(); }
});

test('complete consumes a live lease once and done records remain deduplicated', t => {
  const { ledger } = fixture(t);
  const record = ledger.record('fictional-one');
  const [lease] = ledger.claim();
  assert.equal(lease.receipt, record.receipt);
  assert.equal(lease.attempt, 1);
  assert.equal(lease.complete().state, 'done');
  assert.throws(() => lease.complete(), code('lease-lost'));
  assert.equal(ledger.claim().length, 0);
  assert.equal(ledger.record('fictional-one').inserted, false);
});

test('failed attempts are delayed, then become dead after the configured limit', t => {
  let now = 1000;
  const { ledger } = fixture(t, { now: () => now, maxAttempts: 2 });
  ledger.record('fictional-one');
  const [first] = ledger.claim();
  assert.equal(first.fail({ delayMs: 500 }).state, 'queued');
  assert.equal(ledger.claim().length, 0);
  now = 1500;
  const [second] = ledger.claim();
  assert.equal(second.attempt, 2);
  assert.equal(second.fail({ delayMs: 0 }).state, 'dead');
  assert.equal(ledger.stats().dead, 1);
  assert.equal(ledger.claim().length, 0);
});

test('expired lease is recovered and stale handles cannot complete new work', t => {
  let now = 1000;
  const { ledger } = fixture(t, { now: () => now, leaseMs: 100 });
  ledger.record('fictional-one');
  const [old] = ledger.claim();
  now = 1100;
  assert.throws(() => old.complete(), code('lease-lost'));
  const [current] = ledger.claim();
  assert.equal(current.attempt, 2);
  assert.throws(() => old.fail({ delayMs: 0 }), code('lease-lost'));
  assert.equal(current.complete().state, 'done');
});

test('expiration at the attempt limit becomes dead rather than being leased forever', t => {
  let now = 1000;
  const { ledger } = fixture(t, { now: () => now, leaseMs: 100, maxAttempts: 1 });
  ledger.record('fictional-one');
  ledger.claim();
  now = 1100;
  assert.equal(ledger.stats().expiredLeases, 1);
  assert.equal(ledger.claim().length, 0);
  assert.equal(ledger.stats().dead, 1);
});

test('capacity rejects a whole batch atomically while duplicates still work', t => {
  const { ledger } = fixture(t, { maxEntries: 2 });
  const first = ledger.record('fictional-one');
  assert.throws(() => ledger.recordBatch(['fictional-two', 'fictional-three']), code('capacity'));
  assert.equal(ledger.stats().retained, 1);
  ledger.record('fictional-two');
  assert.equal(ledger.record('fictional-one').receipt, first.receipt);
  assert.throws(() => ledger.record('fictional-three'), code('capacity'));
});

test('requeue is explicit, terminal-only and resets the attempt count', t => {
  const { ledger } = fixture(t);
  const record = ledger.record('fictional-one');
  assert.throws(() => ledger.requeue(record.receipt), code('not-terminal'));
  const [first] = ledger.claim(); first.complete();
  assert.equal(ledger.requeue(record.receipt).state, 'queued');
  assert.equal(ledger.claim()[0].attempt, 1);
  assert.throws(() => first.complete(), code('lease-lost'));
});

test('prunes only old terminal receipts, in bounded batches, freeing capacity', t => {
  let now = 1000;
  const { ledger } = fixture(t, { now: () => now, maxEntries: 3 });
  const first = ledger.record('fictional-one');
  ledger.recordBatch(['fictional-two', 'fictional-three']);
  const [done, active] = ledger.claim({ limit: 2 });
  done.complete();
  assert.deepEqual(ledger.prune({ before: 1000 }), { removed: 0 });
  now = 1001;
  assert.deepEqual(ledger.prune({ before: now, limit: 1 }), { removed: 1 });
  assert.equal(ledger.stats().retained, 2);
  assert.equal(ledger.stats().leased, 1);
  active.complete();
  const recordedAgain = ledger.record('fictional-one');
  assert.equal(recordedAgain.inserted, true);
  assert.notEqual(recordedAgain.receipt, first.receipt);
});

test('cursor pagination is ordered, bounded and can filter states', t => {
  const { ledger } = fixture(t);
  ledger.recordBatch(['fictional-one', 'fictional-two', 'fictional-three']);
  ledger.claim()[0].complete();
  const a = ledger.list({ limit: 2 });
  const b = ledger.list({ after: a.nextAfter, limit: 2 });
  assert.equal(a.receipts.length, 2);
  assert.equal(b.receipts.length, 1);
  assert.equal(new Set([...a.receipts, ...b.receipts].map(row => row.receipt)).size, 3);
  assert.equal(ledger.list({ state: 'done' }).receipts.length, 1);
});

test('persisted settings cannot be silently changed by a second worker', t => {
  const { path } = fixture(t, { maxEntries: 10, maxAttempts: 2 });
  assert.throws(() => new Ledger(path, { maxEntries: 20 }), code('config-mismatch'));
  const compatible = new Ledger(path);
  try { assert.equal(compatible.stats().maxEntries, 10); } finally { compatible.close(); }
});

test('event identifiers and payload-like objects are never copied into outputs or database files', t => {
  const sentinel = 'PRIVATE_EVENT_SENTINEL_8413ae';
  const { root, ledger } = fixture(t);
  const record = ledger.record(sentinel);
  const [lease] = ledger.claim();
  const output = JSON.stringify({ record, lease, ledger, list: ledger.list(), stats: ledger.stats() });
  assert.equal(output.includes(sentinel), false);
  assert.equal(inspect(lease, { showHidden: true, depth: 8 }).includes(sentinel), false);
  assert.deepEqual(Object.keys(lease.toJSON()).sort(), ['attempt', 'leaseUntil', 'receipt']);
  assert.throws(() => ledger.record({ id: 'one', payload: sentinel }), code('invalid-event-ids'));
  for (const name of readdirSync(root)) {
    assert.equal(readFileSync(join(root, name)).includes(Buffer.from(sentinel)), false);
  }
  lease.complete();
});

test('SQL-like identifier content is bound only as a digest, never executed', t => {
  const { ledger } = fixture(t);
  ledger.record("fictional'; DROP TABLE receipts;--");
  assert.equal(ledger.stats().retained, 1);
  assert.equal(ledger.claim()[0].complete().state, 'done');
});

test('invalid inputs have generic error codes and do not partially write', t => {
  const { ledger } = fixture(t);
  for (const ids of [[], Array(1001).fill('one'), ['good', null], [''], ['x'.repeat(1025)], ['bad\0id'], ['\ud800']]) {
    assert.throws(() => ledger.recordBatch(ids), code('invalid-event-ids'));
  }
  assert.equal(ledger.stats().retained, 0);
  assert.throws(() => ledger.claim({ limit: 1001 }), code('invalid-limit'));
  assert.throws(() => ledger.list({ state: 'PRIVATE_SENTINEL' }), code('invalid-page'));
  assert.throws(() => ledger.list({ after: -1 }), code('invalid-page'));
  assert.throws(() => ledger.prune({ before: -1 }), code('invalid-prune'));
  assert.throws(() => ledger.requeue('PRIVATE_SENTINEL'), code('invalid-receipt'));
});

test('invalid clocks and unsafe constructor options fail before writes', t => {
  assert.throws(() => new Ledger(':memory:', { maxEntries: 0 }), code('invalid-options'));
  assert.throws(() => new Ledger(':memory:', { maxEntries: null }), code('invalid-options'));
  assert.throws(() => new Ledger(':memory:', { payload: 'PRIVATE_SENTINEL' }), code('invalid-options'));
  const { ledger } = fixture(t, { now: () => NaN });
  assert.throws(() => ledger.record('fictional-one'), code('invalid-clock'));
});

test('invalid delays do not consume an active lease', t => {
  const { ledger } = fixture(t);
  ledger.record('fictional-one');
  const [lease] = ledger.claim();
  assert.throws(() => lease.fail({ delayMs: -1 }), code('invalid-delay'));
  assert.throws(() => lease.fail({ error: 'PRIVATE_SENTINEL' }), code('invalid-delay'));
  assert.equal(lease.complete().state, 'done');
});

test('storage errors and closed handles expose fixed codes', t => {
  const { root, ledger } = fixture(t);
  const privatePath = join(root, 'PRIVATE_PATH_SENTINEL');
  writeFileSync(privatePath, 'not a database');
  assert.throws(() => new Ledger(privatePath), error => error.code === 'storage-error' && !error.message.includes('PRIVATE_PATH_SENTINEL'));
  ledger.close(); ledger.close();
  assert.throws(() => ledger.stats(), code('closed'));
});

test('10,000 receipts can be imported, deduplicated and paged without offset scans', t => {
  const { ledger } = fixture(t);
  for (let batch = 0; batch < 10; batch += 1) ledger.recordBatch(Array.from({ length: 1000 }, (_, index) => `fictional-${batch}-${index}`));
  assert.equal(ledger.stats().retained, 10000);
  assert.equal(ledger.recordBatch(Array.from({ length: 1000 }, (_, index) => `fictional-0-${index}`)).filter(row => row.inserted).length, 0);
  let after = 0; let total = 0;
  while (true) {
    const page = ledger.list({ after, limit: 1000 });
    if (!page.receipts.length) break;
    total += page.receipts.length;
    after = page.nextAfter;
  }
  assert.equal(total, 10000);
});
