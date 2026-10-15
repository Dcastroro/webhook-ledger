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
