import { Ledger } from '../src/ledger.mjs';
let now = 1000;
const ledger = new Ledger(':memory:', { now: () => now, maxAttempts: 2 });
try {
  const first = ledger.record('fictional-delivery-one');
  const duplicate = ledger.record('fictional-delivery-one');
  const [lease] = ledger.claim();
  lease.fail({ delayMs: 100 });
  now += 101;
  const [retry] = ledger.claim();
  retry.complete();
  console.log(JSON.stringify({ deduplicated: first.receipt === duplicate.receipt, final: ledger.stats() }, null, 2));
} finally { ledger.close(); }
