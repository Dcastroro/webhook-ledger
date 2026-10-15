import { Ledger, withBusyRetry } from '../src/ledger.mjs';
const [path, mode, id = '0'] = process.argv.slice(2);
let ledger;
let phase = 'init';
const retry = operation => withBusyRetry(operation, { attempts: 32 });
try {
  ledger = await retry(() => new Ledger(path, { busyMs: 100 }));
  phase = mode;
  let result;
  if (mode === 'record') {
    const records = await retry(() => ledger.recordBatch([
      ...Array.from({ length: 100 }, (_, i) => `shared-${i}`),
      ...Array.from({ length: 100 }, (_, i) => `worker-${id}-${i}`),
    ]));
    result = { inserted: records.filter(row => row.inserted).length };
  } else if (mode === 'claim') {
    const completed = [];
    while (true) {
      phase = 'claim';
      const leases = await retry(() => ledger.claim({ limit: 20 }));
      if (!leases.length) break;
      for (const lease of leases) { phase = 'complete'; await retry(() => lease.complete()); completed.push(lease.receipt); }
    }
    result = { completed };
  } else if (mode === 'capacity') {
    try {
      const records = await retry(() => ledger.recordBatch(Array.from({ length: 10 }, (_, i) => `capacity-${id}-${i}`)));
      result = { inserted: records.length };
    } catch (error) {
      if (error.code !== 'capacity') throw error;
      result = { inserted: 0, capacity: true };
    }
  } else throw new Error();
  ledger.close(); ledger = undefined;
  console.log(JSON.stringify(result));
} catch (error) {
  try { ledger?.close(); } catch { /* Fixed worker error only. */ }
  const code = ['storage-busy', 'storage-error', 'storage-capacity', 'lease-lost', 'config-mismatch'].includes(error?.code) ? error.code : 'worker-error';
  console.log(JSON.stringify({ error: code, phase }));
  process.exitCode = 1;
}
