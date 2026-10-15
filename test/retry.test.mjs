import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sqlite from 'node:sqlite';
import { Ledger, LedgerError, withBusyRetry } from '../src/ledger.mjs';
const Database = sqlite.Database ?? sqlite.DatabaseSync;

test('bounded retry recovers a real writer lock without duplicating ingestion', async t => {
  const root = mkdtempSync(join(tmpdir(), 'webhook-busy-'));
  const path = join(root, 'ledger.sqlite');
  const ledger = new Ledger(path, { busyMs: 10 });
  const lock = new Database(path);
  t.after(() => { lock.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); });
  lock.exec('BEGIN IMMEDIATE');
  const release = setTimeout(() => lock.exec('ROLLBACK'), 40);
  try {
    let calls = 0;
    const result = await withBusyRetry(() => { calls += 1; return ledger.record('fictional-busy-event'); }, { attempts: 8, delayMs: 10 });
    assert.equal(result.inserted, true);
    assert.ok(calls > 1);
    assert.equal(ledger.stats().retained, 1);
  } finally { clearTimeout(release); }
});

test('retry exhaustion and non-busy errors remain explicit and bounded', async () => {
  let calls = 0;
  await assert.rejects(() => withBusyRetry(() => { calls += 1; throw new LedgerError('storage-busy'); }, { attempts: 2, delayMs: 1 }), /storage-busy/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(() => withBusyRetry(() => { calls += 1; throw new LedgerError('capacity'); }), /capacity/);
  assert.equal(calls, 1);
  await assert.rejects(() => withBusyRetry(() => {}, { attempts: 33 }), /invalid-retry/);
});

test('pre-cancelled retries execute no operation and omit the abort reason', async () => {
  const controller = new AbortController(); controller.abort(new Error('PRIVATE_ABORT_REASON'));
  let calls = 0;
  await assert.rejects(withBusyRetry(() => { calls++; return true; },{signal:controller.signal}),error => {
    assert.ok(error instanceof LedgerError);
    assert.equal(error.code,'cancelled'); assert.equal(error.message,'cancelled');
    assert.equal(error.cause,undefined); return true;
  });
  assert.equal(calls,0);
});

test('cancelling during a busy backoff starts no additional operation', async t => {
  const controller = new AbortController(); let calls = 0;
  let notify;
  const started = new Promise(resolve => { notify = resolve; });
  const pending = withBusyRetry(() => { calls++; notify(); throw new LedgerError('storage-busy'); },{attempts:32,delayMs:1000,maxDelayMs:1000,signal:controller.signal});
  const result = assert.rejects(pending,{code:'cancelled',message:'cancelled'});
  await started;
  const cancellation = setImmediate(() => controller.abort('PRIVATE_REASON'));
  t.after(() => clearImmediate(cancellation));
  await result;
  assert.equal(calls,1);
});

test('cancellation preserves a successful in-flight operation result', async () => {
  const controller = new AbortController(); const committed = {inserted:true};
  const result = await withBusyRetry(async () => { controller.abort(); return committed; },{signal:controller.signal});
  assert.equal(result,committed);
});

test('cancellation after a busy result wins over exhaustion without exposing its reason', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(withBusyRetry(() => {
    calls++; controller.abort('PRIVATE_REASON'); throw new LedgerError('storage-busy');
  },{attempts:1,signal:controller.signal}),{code:'cancelled',message:'cancelled'});
  assert.equal(calls,1);
});

test('non-busy failures remain explicit even if cancellation races with the operation', async () => {
  const controller = new AbortController();
  const failure = new LedgerError('capacity');
  await assert.rejects(withBusyRetry(() => { controller.abort(); throw failure; },{signal:controller.signal}),error => error === failure);
});

test('invalid cancellation signals are rejected before any operation', async () => {
  let calls = 0;
  await assert.rejects(withBusyRetry(() => { calls++; },{signal:{aborted:false}}),{code:'invalid-retry'});
  assert.equal(calls,0);
});
