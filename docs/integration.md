# Integration boundaries

Webhook Ledger coordinates receipt state. It does not receive HTTP, validate
signatures, store payloads or know a provider's delivery guarantees.

For an offline/batch workflow:

1. Start with verified events in a trusted, durable source.
2. Record their IDs and prepare a separate mapping from returned receipt UUIDs
   to the data that workers need. Keep that data outside the ledger.
3. Start workers only when the mapping is ready.
4. Claim bounded batches, run idempotent handlers, then complete or fail leases.
5. Retain receipts for the required deduplication window; prune terminal work
   only when replay semantics are understood.

For an online integration, receipt insertion and a separate payload-store write
are not atomic. A crash can leave a receipt without a mapping, or a prepared
payload without a receipt. The application needs an outbox, a coordinated
ingestion protocol or explicit reconciliation before transport acknowledgement.
Repeated delivery is not a reason to silently skip repairing a missing mapping.

Workers should not complete a receipt if its data is missing. Recover/retry it
using the application's policy; terminal/dead work requires explicit operator
attention. Do not log a payload or raw exception to diagnose the ledger state.

## Use with the other developer tools

[Task Relay](https://github.com/Dcastroro/task-relay) can run the ledger's demo
or a bounded batch command as part of a development workflow:

```json
{
  "version": 1,
  "tasks": {
    "receipt-demo": {
      "command": ["$node", "tools/webhook-ledger/examples/lifecycle.mjs"],
      "timeoutMs": 10000
    }
  }
}
```

Place a reviewed checkout at the illustrative path above. This demo uses
fictional identifiers and memory-only storage; it does not replay real events.
Task Relay executes the explicitly configured command, while the ledger itself
opens no network connection and spawns no process.
