# Roadmap

Version 0.1.0 provides local receipts, deduplication, atomic leases, bounded
retry/dead states, retention controls and metadata-only inspection.

Potential follow-ups, not current features:

1. Versioned lease-extension semantics with stale-worker regression tests.
2. Bounded reconciliation helpers for external payload-store mappings.
3. Documented metrics adapters that preserve metadata-only reporting.

Multi-host coordination, payload storage, HTTP receiving and provider signature
verification are outside the current scope. Any expansion must retain explicit
data boundaries and avoid embedding service credentials.
