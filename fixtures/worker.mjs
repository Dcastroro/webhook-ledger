import { Ledger } from '../src/ledger.mjs';
const [path, mode, id = '0'] = process.argv.slice(2);
let ledger;
try {
  ledger = new Ledger(path);
  let result;
  if (mode === 'record') {
    const records = ledger.recordBatch([
      ...Array.from({ length: 100 }, (_, i) => `shared-${i}`),
      ...Array.from({ length: 100 }, (_, i) => `worker-${id}-${i}`),
    ]);
    result = { inserted: records.filter(row => row.inserted).length };
  } else if (mode === 'claim') {
    const completed = [];
    while (true) {
      const leases = ledger.claim({ limit: 20 });
      if (!leases.length) break;
      for (const lease of leases) { lease.complete(); completed.push(lease.receipt); }
    }
    result = { completed };
  } else if (mode === 'capacity') {
    try {
      const records = ledger.recordBatch(Array.from({ length: 10 }, (_, i) => `capacity-${id}-${i}`));
      result = { inserted: records.length };
    } catch (error) {
      if (error.code !== 'capacity') throw error;
      result = { inserted: 0, capacity: true };
    }
  } else throw new Error();
  ledger.close(); ledger = undefined;
  console.log(JSON.stringify(result));
} catch {
  try { ledger?.close(); } catch { /* Fixed worker error only. */ }
  console.log(JSON.stringify({ error: 'worker-error' }));
  process.exitCode = 1;
}
