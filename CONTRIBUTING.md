# Contributing

Use Node.js 24.14+ and run `npm ci --ignore-scripts`, then `npm run check`.
There are no third-party dependencies or native build steps.

Use fictional IDs only. Never add payload/header storage, raw diagnostics,
credential requirements or a command that exports live lease ownership.

For lifecycle changes, cover expiry boundaries, stale handles, crash ambiguity,
retention and retry limits. Storage changes need real file-backed tests and
multi-process concurrency checks on Windows and POSIX. Preserve all-or-nothing
batch imports and the persisted capacity check.

Describe the problem, resulting behavior and validation in changes. Schema
migrations require a versioned design; this release rejects other schema
versions rather than attempting a silent upgrade.
