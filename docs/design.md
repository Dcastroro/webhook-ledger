# Storage and coordination

## SQLite transactions

The ledger uses native `node:sqlite`, prepared statements and STRICT tables.
A unique namespace-scoped digest index serializes deduplication. Ingestion,
lease assignment, expiry recovery and pruning use `BEGIN IMMEDIATE` transactions.
Live settlement is a single conditional update. State counts use a read
transaction so their snapshot is consistent while other connections write.

WAL supports concurrent local readers with one active writer. Busy waits are
bounded to at most five seconds. Existing ledgers do not take a writer lock
just to load settings. The opt-in `withBusyRetry` helper yields between finite
retries on lock contention; the worker fixture uses a short per-call busy wait
and bounded backoff. No retry wraps an external business effect.
Do not put the database on a network
filesystem or assume multi-host coordination. Write-heavy use is limited by
SQLite's single-writer model and the host storage.

## Bounded work

Batch ingestion, claims, expired-lease recovery, list pages and pruning are capped
at 1,000 records per call. Retained rows have a persisted capacity checked inside
the writer transaction; triggers maintain its count. Indexed eligibility,
expiration and keyset queries avoid loading the whole ledger for normal work.
Stats intentionally aggregates the state index, so its cost grows with retained
rows; it should not be polled for every event.

The main database is capped at 32,768 pages. WAL auto-checkpointing and a
4 MiB post-checkpoint journal size target reduce ordinary sidecar growth, but
are not a hard total-disk quota. Stalled external readers can pin WAL frames.
Monitor filesystem free space in your host infrastructure. Full storage results
in a failed transaction; do not discard an upstream delivery on that error.

Pruning makes deleted space reusable, without immediate file shrinkage. Do not
delete or copy live SQLite/WAL files as a backup method. Use SQLite's supported
backup process under your established operations procedures. Directory access
and backup protection belong to the application/operator.

## Ownership

Each claim gets fresh random ownership material. Only its digest enters the
database; the material itself remains in a private closure behind the lease.
Completion/failure checks state, receipt, digest and deadline in the same update.
This prevents a stale worker from settling a newly assigned lease. It does not
prevent the stale worker from causing an external side effect: that system must
apply its own idempotency/fencing policy.

## References

- [Node SQLite API](https://nodejs.org/api/sqlite.html)
- [SQLite write-ahead logging](https://www.sqlite.org/wal.html)
- [SQLite RETURNING](https://www.sqlite.org/lang_returning.html)

Those sources describe the underlying APIs; this project's limits and delivery
semantics are its own contract. No provider credential or hosted service is
required.
