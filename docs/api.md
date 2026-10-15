# API and fixed errors

`new Ledger(path, options)` opens or creates a ledger. `:memory:` is supported
for tests/demos. Supported options: `maxEntries`, `maxAttempts`, `leaseMs`,
`busyMs`, and a `now()` clock for deterministic tests. Production workers should
share a consistent system clock. Capacity/attempt/deadline settings persist;
busy wait and clock are connection-local.

| Method | Result |
| --- | --- |
| `record(id)` | `{ inserted, receipt, state }` |
| `recordBatch(ids)` | Ordered array of record results; transaction is all-or-nothing |
| `claim({ limit = 1 })` | Lease objects, with private ownership retained internally |
| `lease.complete()` | `{ receipt, state: 'done', attempts }` |
| `lease.fail({ delayMs = 1000 })` | `{ receipt, state: 'queued' or 'dead', attempts }` |
| `requeue(receipt)` | Terminal receipt reset to queued, attempt count zero |
| `list({ state, after = 0, limit = 100 })` | `{ version, nextAfter, receipts }` |
| `stats()` | State counts, retained count, expired-lease count and persisted settings |
| `prune({ before, limit = 1000 })` | `{ removed }` |
| `close()` | Closes connection; repeat calls are harmless |

All timestamps are epoch milliseconds. Expiration is inclusive: at exactly
`leaseUntil`, the old lease can no longer settle. Attempts increment when work
is claimed, including work abandoned by a crashed worker. `claim()` performs
bounded recovery before assigning ready work.

Ready work is ordered by availability and sequence. List cursors follow
insertion sequence; they are useful for inspection, not a durable event stream.
State changes do not move a receipt's sequence. An empty page returns the same
cursor; consumers should stop when `receipts` is empty.

Leases serialize only `receipt`, `attempt`, `leaseUntil`. They cannot be
serialized and transferred to another process for later completion. Each worker
must claim through its own open connection and settle through that handle.

Public errors are `LedgerError` with a fixed `code`; there is no raw cause or
database message. Common codes: `usage`, `invalid-import`, `invalid-event-ids`,
`invalid-limit`, `invalid-page`, `invalid-prune`, `invalid-delay`,
`invalid-receipt`, `invalid-options`, `invalid-path`, `invalid-clock`,
`capacity`, `config-mismatch`, `lease-lost`, `not-terminal`, `closed`,
`database-format`, `database-version`, `storage-busy`, `storage-capacity`,
`storage-error`, `invalid-retry`, `cancelled`.

`storage-busy` means the bounded lock wait was exhausted. The exported
`withBusyRetry(operation, { attempts = 8, delayMs = 20, maxDelayMs = 250, signal })`
retries only that fixed error with capped exponential pauses. Attempts range
from 1 to 32, delay from 1 to 1,000 ms, and maximum delay from the initial delay
to 1,000 ms. Use it only around an individual ledger call, never an external
business action. Other errors and retry exhaustion propagate unchanged.

An optional `AbortSignal` cancels pending backoff and prevents the next operation
from starting. A pre-aborted signal starts no operation. Cancellation throws
`LedgerError('cancelled')` without copying the abort reason or cause. An already
running operation is not interrupted: its successful result is returned, including
a committed write, and its non-busy errors remain unchanged. The synchronous SQLite
busy wait itself cannot be interrupted; bound it with `busyMs`. Invalid signal
objects fail with `invalid-retry` before any operation runs.
A reported successful commit
is durable according to SQLite/host guarantees, but a process can crash after
commit before the caller observes success. Re-recording the same retained ID
resolves ingestion ambiguity; business effects still need idempotency.
