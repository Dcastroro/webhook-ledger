# Validation

Verified locally on 15 October 2026 with Windows and Node.js v24.20.0:

- Syntax checks and all 25 tests pass, with none skipped.
- The in-memory lifecycle demo deduplicates one delivery, retries it and
  completes it without printing event data or lease ownership.
- Four independent processes concurrently import overlapping deliveries:
  800 supplied identifiers produce 500 unique retained receipts.
- Four workers complete those 500 receipts with no duplicate receipt claims.
- Concurrent writers respect a shared persisted capacity; over-capacity batches
  roll back completely.
- Four first-time workers initialize and share a newly created ledger.
- A 10,000-receipt fixture covers batched ingestion, retained deduplication and
  complete cursor pagination.
- Tests cover restart persistence, stale handles, deadline boundaries, delay,
  attempt limits, terminal requeue and bounded pruning.
- Sentinel identifiers are absent from public results, CLI output, database
  files and SQLite sidecars; payload-like objects are rejected.

These are correctness/scale regression fixtures, not throughput benchmarks,
an exactly-once guarantee or a distributed-systems performance claim.

CI defines Windows/Ubuntu with Node.js 24/26. Check the Actions tab for actual
remote results. Native SQLite version and API stability follow the Node runtime.

All identifiers in examples/tests are fictional. The runtime CLI/library needs
no provider credential, opens no network connection and spawns no process.
