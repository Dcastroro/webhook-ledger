# Changelog

## 0.1.2 — 2026-10-15

- Add AbortSignal cancellation to bounded storage-busy backoff.
- Prevent additional attempts after cancellation without copying abort reasons.
- Preserve successful in-flight writes and unrelated storage errors.
- Cover pre-cancellation, pending timers, exhaustion races and invalid signals.

## 0.1.1 — 2026-10-15

- Add a bounded repository policy check with value-free diagnostics.
- Build reproducible committed-source archives with SHA-256 manifests.
- Gate tag-based GitHub Releases with cross-platform tests and isolated publishing.
- Pin workflow actions and group monthly dependency update proposals.

## 0.1.0 — 2026-10-15

- Local SQLite receipt deduplication with no stored raw IDs or payloads.
- Atomic multi-process claims, private ownership handles and stale-worker checks.
- Opt-in bounded writer-contention retries and read-only settings on reopen.
- Bounded retry delays, expired-lease recovery and dead states.
- Persisted capacity, all-or-nothing imports and cursor-based inspection.
- Explicit terminal requeue and bounded retention pruning.
- Fixed-code diagnostics, lifecycle demo and cross-platform native SQLite CI.
