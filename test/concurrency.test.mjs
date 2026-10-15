import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../src/ledger.mjs';
const worker = fileURLToPath(new URL('../fixtures/worker.mjs', import.meta.url));
const run = (path, mode, id) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [worker, path, mode, String(id)], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, windowsHide: true });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.resume();
  child.on('error', reject);
  child.on('close', code => {
    try { assert.equal(code, 0); resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
  });
});
function fixture(t, options) {
  const root = mkdtempSync(join(tmpdir(), 'webhook-concurrency-'));
  const path = join(root, 'ledger.sqlite');
  const ledger = new Ledger(path, options);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { path, ledger };
}

test('four processes deduplicate overlapping deliveries and complete each receipt once', { timeout: 30000 }, async t => {
  const { path, ledger } = fixture(t);
  const writes = await Promise.all(Array.from({ length: 4 }, (_, id) => run(path, 'record', id)));
  assert.equal(writes.reduce((sum, result) => sum + result.inserted, 0), 500);
  assert.equal(ledger.stats().retained, 500);
  const claims = await Promise.all(Array.from({ length: 4 }, (_, id) => run(path, 'claim', id)));
  const completed = claims.flatMap(result => result.completed);
  assert.equal(completed.length, 500);
  assert.equal(new Set(completed).size, 500);
  assert.equal(ledger.stats().done, 500);
});

test('concurrent writers cannot overrun the persisted capacity', { timeout: 30000 }, async t => {
  const { path, ledger } = fixture(t, { maxEntries: 100 });
  ledger.recordBatch(Array.from({ length: 90 }, (_, id) => `seed-${id}`));
  const results = await Promise.all(Array.from({ length: 4 }, (_, id) => run(path, 'capacity', id)));
  assert.equal(results.reduce((sum, result) => sum + result.inserted, 0), 10);
  assert.equal(ledger.stats().retained, 100);
});

test('four first-time workers can initialize the same new ledger', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'webhook-first-open-'));
  const path = join(root, 'ledger.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const records = await Promise.all(Array.from({ length: 4 }, (_, id) => run(path, 'record', id)));
  assert.equal(records.reduce((sum, result) => sum + result.inserted, 0), 500);
  const ledger = new Ledger(path);
  try { assert.equal(ledger.stats().retained, 500); } finally { ledger.close(); }
});
