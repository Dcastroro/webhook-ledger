# Security design

## Stored data

The API accepts event ID strings, not event objects. Before SQLite sees an ID,
the library converts it to an HMAC-SHA-256 digest using a random per-database
namespace. No original ID, payload, header, URL, account credential or failure
message is inserted into the ledger. Reports contain only random receipt UUIDs,
states, counts, attempts, cursors, settings and timestamps.

The namespace is stored with the database. It is not a service credential or
encryption key, and this design is not encrypted storage. A database reader can
test guesses for low-entropy IDs. Keep raw input files and any separate payload
store under your own access controls. The tool does not scan those files for
secrets or certify their content.

## Lease material

Random lease ownership material stays in a private closure, and only its digest
is written to SQLite. JSON serialization and Node inspection show receipt,
attempt and deadline only. The CLI cannot export or import live claims.
This reduces accidental logging; it is not a defense against process-memory
inspection, debugger access or host compromise.

## Capabilities and diagnostics

The shipped CLI/library requires no service credential and does not load `.env`,
read credential stores, open network listeners, make HTTP calls, execute a shell
or load SQLite extensions. Public errors are fixed codes without raw input,
filenames, SQL parameters or native error messages. Application logging added
around the library remains the application's responsibility.

New database files are created with mode `0600` where the OS honors POSIX modes.
Windows ACLs and parent-directory access must be controlled by the operator.
The database and sidecar files are ignored by Git. CI uses GitHub's ephemeral,
read-only checkout authentication with credential persistence disabled; it
requires no custom secret.

## Local trust boundary

Any process with database write access can change coordination state. Lease
checks handle concurrency and stale workers, not a hostile database writer.
Do not open arbitrary untrusted SQLite files. The library checks an application
ID/schema version, rejects known database-path symlinks and disables extension
loading, but it is not a filesystem sandbox or a protection against concurrent
filesystem replacement. Existing ledger files are not modified to change ACLs.

Input size, identifiers, retained records, API pages, lock waits and main database
pages are bounded. WAL sidecar growth depends on checkpoints/readers and host
disk space. Native SQLite calls are synchronous. See the README for scale and
delivery limits.

Report vulnerabilities through the contact channel on the maintainer's GitHub
profile, using fictional reproductions. Never post real event data, identifiers,
database files or credentials in public issues.
