#!/usr/bin/env node
import { open, lstat } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { Ledger, LedgerError } from '../src/ledger.mjs';
const HELP = `Webhook Ledger 0.1.0

Usage: node bin/webhook-ledger.mjs <init|import|stats|list|requeue|prune> --db <file> [options]

  --input <file>       Import a JSON array of event ID strings (at most 1000)
  --state <state>      Filter list: queued, leased, done, dead
  --after <cursor>     List cursor (default: 0)
  --limit <1-1000>     List/prune batch size
  --receipt <uuid>     Requeue a terminal receipt
  --before <epoch-ms>  Prune terminal receipts updated before this instant
  --help              Show usage
  --version           Show version

Output is JSON metadata. Event IDs are read from files, never command arguments.
Claim/complete/fail are available through the in-memory API, not CLI output.
Exit codes: 0 success, 2 invalid input or storage/state error.
`;

const fail = () => { throw new LedgerError('usage'); };
function args(values) {
  const result = {};
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === '--help' || flag === '--version') { if (seen.has(flag)) fail(); seen.add(flag); result[flag.slice(2)] = true; continue; }
    if (!flag.startsWith('--')) { if (result.action) fail(); result.action = flag; continue; }
    if (!['--db', '--input', '--state', '--after', '--limit', '--receipt', '--before'].includes(flag) || seen.has(flag)) fail();
    seen.add(flag);
    const value = values[++index];
    if (!value || value.startsWith('--')) fail();
    const key = flag.slice(2);
    if (['after', 'limit', 'before'].includes(key)) {
      if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))) fail();
      result[key] = Number(value);
    } else result[key] = value;
  }
  if (result.help || result.version) return result;
  const allowed = {
    init: [], import: ['input'], stats: [], list: ['state', 'after', 'limit'],
    requeue: ['receipt'], prune: ['before', 'limit'],
  };
  if (!Object.hasOwn(allowed, result.action) || !result.db) fail();
  if (Object.keys(result).some(key => !['action', 'db', ...allowed[result.action]].includes(key))) fail();
  if (result.action === 'import' && !result.input || result.action === 'requeue' && !result.receipt || result.action === 'prune' && result.before === undefined) fail();
  return result;
}
async function ids(path) {
  let handle;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 1048576) throw new Error();
    handle = await open(path, 'r');
    if (!(await handle.stat()).isFile()) throw new Error();
    const buffer = Buffer.alloc(1048577);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 1048576) throw new Error();
    const parsed = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(buffer.subarray(0, size)).replace(/^\uFEFF/, ''));
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 1000 || !parsed.every(value => typeof value === 'string')) throw new Error();
    return parsed;
  } catch { throw new LedgerError('invalid-import'); }
  finally { await handle?.close(); }
}
let ledger;
try {
  const options = args(process.argv.slice(2));
  if (options.help) console.log(HELP);
  else if (options.version) console.log('0.1.0');
  else {
    const eventIds = options.action === 'import' ? await ids(options.input) : undefined;
    ledger = new Ledger(options.db);
    let result;
    switch (options.action) {
      case 'init': result = ledger.stats(); break;
      case 'stats': result = ledger.stats(); break;
      case 'import': {
        const records = ledger.recordBatch(eventIds);
        result = { inserted: records.filter(record => record.inserted).length, duplicates: records.filter(record => !record.inserted).length };
        break;
      }
      case 'list': result = ledger.list({ state: options.state, after: options.after, limit: options.limit }); break;
      case 'requeue': result = ledger.requeue(options.receipt); break;
      case 'prune': result = ledger.prune({ before: options.before, limit: options.limit }); break;
    }
    ledger.close(); ledger = undefined;
    console.log(JSON.stringify({ version: 1, ok: true, result }, null, 2));
  }
} catch (error) {
  try { ledger?.close(); } catch { /* Never log raw storage errors. */ }
  console.log(JSON.stringify({ version: 1, ok: false, error: { code: error instanceof LedgerError ? error.code : 'internal' } }, null, 2));
  process.exitCode = 2;
}
