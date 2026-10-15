import { setTimeout } from 'node:timers/promises';
import { LedgerError } from './ledger.mjs';

/** Explicitly retry one ledger operation on lock contention, never business side effects. */
export async function withBusyRetry(operation, { attempts = 8, delayMs = 20, maxDelayMs = 250 } = {}) {
  if (typeof operation !== 'function' || !Number.isInteger(attempts) || attempts < 1 || attempts > 32
    || !Number.isInteger(delayMs) || delayMs < 1 || delayMs > 1000
    || !Number.isInteger(maxDelayMs) || maxDelayMs < delayMs || maxDelayMs > 1000) throw new LedgerError('invalid-retry');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof LedgerError) || error.code !== 'storage-busy' || attempt + 1 >= attempts) throw error;
      await setTimeout(Math.min(maxDelayMs, delayMs * 2 ** attempt));
    }
  }
}
