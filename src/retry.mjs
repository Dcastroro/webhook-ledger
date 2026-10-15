import { setTimeout } from 'node:timers/promises';
import { LedgerError } from './ledger.mjs';

/** Explicitly retry one ledger operation on lock contention, never business side effects. */
export async function withBusyRetry(operation, { attempts = 8, delayMs = 20, maxDelayMs = 250, signal } = {}) {
  if (typeof operation !== 'function' || !Number.isInteger(attempts) || attempts < 1 || attempts > 32
    || !Number.isInteger(delayMs) || delayMs < 1 || delayMs > 1000
    || !Number.isInteger(maxDelayMs) || maxDelayMs < delayMs || maxDelayMs > 1000
    || (signal !== undefined && !(signal instanceof AbortSignal))) throw new LedgerError('invalid-retry');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw new LedgerError('cancelled');
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof LedgerError) || error.code !== 'storage-busy') throw error;
      if (signal?.aborted) throw new LedgerError('cancelled');
      if (attempt + 1 >= attempts) throw error;
      try { await setTimeout(Math.min(maxDelayMs, delayMs * 2 ** attempt), undefined, { signal }); }
      catch (error) {
        // Abort reasons can contain private caller data; expose only our fixed code.
        if (signal?.aborted) throw new LedgerError('cancelled');
        throw error;
      }
    }
  }
}
