import * as sqlite from 'node:sqlite';
import { createHmac, createHash, randomBytes, randomUUID } from 'node:crypto';
import { openSync, closeSync, lstatSync } from 'node:fs';
import { inspect } from 'node:util';

const Database = sqlite.Database ?? sqlite.DatabaseSync;
const APP_ID = 1464616007;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATES = new Set(['queued', 'leased', 'done', 'dead']);
const FIELDS = 'seq, receipt, state, attempts, available_at AS availableAt, leased_until AS leaseUntil, created_at AS createdAt, updated_at AS updatedAt';
export const LIMITS = Object.freeze({ batch: 1000, idBytes: 1024, page: 1000, maxEntries: 1000000, mainPages: 32768 });
const int = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const digest = value => createHash('sha256').update(value).digest();

export class LedgerError extends Error {
  constructor(code) { super(code); this.name = 'LedgerError'; this.code = code; }
}
const fail = code => { throw new LedgerError(code); };
const storageError = error => new LedgerError(error?.errcode === 5 || error?.errcode === 6 ? 'storage-busy'
  : error?.errcode === 13 ? 'storage-capacity' : 'storage-error');

class Lease {
  #finish;
  #metadata;
  constructor(metadata, finish) { this.#metadata = Object.freeze(metadata); this.#finish = finish; Object.freeze(this); }
  get receipt() { return this.#metadata.receipt; }
  get attempt() { return this.#metadata.attempt; }
  get leaseUntil() { return this.#metadata.leaseUntil; }
  complete() { return this.#finish('complete'); }
  fail(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'delayMs')) fail('invalid-delay');
    return this.#finish('fail', options.delayMs === undefined ? 1000 : options.delayMs);
  }
  toJSON() { return { ...this.#metadata }; }
  [inspect.custom]() { return this.toJSON(); }
}

/** Synchronous, bounded local receipt coordination. Never accepts event payloads. */
export class Ledger {
  #db;
  #config;
  #namespace;
  #now;
  #statements = new Map();
  #closed = false;

  constructor(path = ':memory:', options = {}) {
    if (typeof path !== 'string' || !path || path.includes('\0')) fail('invalid-path');
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['maxEntries', 'maxAttempts', 'leaseMs', 'busyMs', 'now'].includes(key))) fail('invalid-options');
    const requested = { maxEntries: options.maxEntries === undefined ? 100000 : options.maxEntries,
      maxAttempts: options.maxAttempts === undefined ? 5 : options.maxAttempts,
      leaseMs: options.leaseMs === undefined ? 30000 : options.leaseMs };
    if (!int(requested.maxEntries, 1, LIMITS.maxEntries) || !int(requested.maxAttempts, 1, 100)
      || !int(requested.leaseMs, 100, 3600000) || (options.busyMs !== undefined && !int(options.busyMs, 1, 5000))
      || (options.now !== undefined && typeof options.now !== 'function')) fail('invalid-options');
    this.#now = options.now ?? Date.now;
    try {
      if (path !== ':memory:') {
        try { const fd = openSync(path, 'wx', 0o600); closeSync(fd); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (!lstatSync(path).isFile()) fail('invalid-path');
      }
      this.#db = new Database(path, { timeout: options.busyMs ?? 5000, allowExtension: false, defensive: true });
      this.#db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=4194304; PRAGMA wal_autocheckpoint=1000;');
      const app = this.#db.prepare('PRAGMA application_id').get().application_id;
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      if (app !== 0 && app !== APP_ID) fail('database-format');
      if (app === 0 && this.#db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n !== 0
        && this.#db.prepare('PRAGMA application_id').get().application_id !== APP_ID) fail('database-format');
      if (app === APP_ID && version !== 1) fail('database-version');
      this.#db.exec('PRAGMA journal_mode=WAL;');
      if (this.#db.prepare('PRAGMA page_count').get().page_count > LIMITS.mainPages) fail('storage-capacity');
      this.#db.exec(`PRAGMA max_page_count=${LIMITS.mainPages};`);
      this.#transaction(() => {
        // Recheck under the writer lock: concurrent initializers may have won.
        const actual = this.#db.prepare('PRAGMA application_id').get().application_id;
        if (actual === 0) {
          if (this.#db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n !== 0) fail('database-format');
          this.#db.exec(`
            CREATE TABLE settings (
              id INTEGER PRIMARY KEY CHECK(id=1), namespace BLOB NOT NULL,
              entries INTEGER NOT NULL CHECK(entries>=0), max_entries INTEGER NOT NULL,
              max_attempts INTEGER NOT NULL, lease_ms INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE receipts (
              seq INTEGER PRIMARY KEY AUTOINCREMENT, receipt TEXT NOT NULL UNIQUE,
              event_digest BLOB NOT NULL UNIQUE,
              state TEXT NOT NULL CHECK(state IN ('queued','leased','done','dead')),
              attempts INTEGER NOT NULL CHECK(attempts>=0), available_at INTEGER NOT NULL,
              leased_until INTEGER, lease_digest BLOB,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            ) STRICT;
            CREATE INDEX ready_receipts ON receipts(state,available_at,seq);
            CREATE INDEX expired_receipts ON receipts(state,leased_until,seq);
            CREATE INDEX paged_receipts ON receipts(state,seq);
            CREATE INDEX finished_receipts ON receipts(state,updated_at,seq);
            CREATE TRIGGER receipt_added AFTER INSERT ON receipts BEGIN UPDATE settings SET entries=entries+1 WHERE id=1; END;
            CREATE TRIGGER receipt_removed AFTER DELETE ON receipts BEGIN UPDATE settings SET entries=entries-1 WHERE id=1; END;
          `);
          this.#db.prepare('INSERT INTO settings VALUES (1,?,0,?,?,?)').run(randomBytes(32), requested.maxEntries, requested.maxAttempts, requested.leaseMs);
          this.#db.exec(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;`);
        } else if (actual !== APP_ID || this.#db.prepare('PRAGMA user_version').get().user_version !== 1) fail('database-format');
        const stored = this.#db.prepare('SELECT * FROM settings WHERE id=1').get();
        this.#config = { maxEntries: stored.max_entries, maxAttempts: stored.max_attempts, leaseMs: stored.lease_ms };
        this.#namespace = Buffer.from(stored.namespace);
        for (const key of ['maxEntries', 'maxAttempts', 'leaseMs']) {
          if (options[key] !== undefined && options[key] !== this.#config[key]) fail('config-mismatch');
        }
      });
    } catch (error) {
      try { this.#db?.close(); } catch { /* Do not expose storage errors. */ }
      if (error instanceof LedgerError) throw error;
      throw storageError(error);
    }
  }

  #time() {
    const time = this.#now();
    if (!int(time, 0, 8640000000000000 - 3600000)) fail('invalid-clock');
    return time;
  }
  #query(sql) {
    if (!this.#statements.has(sql)) this.#statements.set(sql, this.#db.prepare(sql));
    return this.#statements.get(sql);
  }
  #guard(fn) {
    if (this.#closed) fail('closed');
    try { return fn(); }
    catch (error) { if (error instanceof LedgerError) throw error; throw storageError(error); }
  }
  #transaction(fn, readOnly = false) {
    this.#db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try { const result = fn(); this.#db.exec('COMMIT'); return result; }
    catch (error) { try { this.#db.exec('ROLLBACK'); } catch { /* Preserve only a fixed public error. */ } throw error; }
  }
  record(eventId) { return this.recordBatch([eventId])[0]; }
  recordBatch(eventIds) {
    if (!Array.isArray(eventIds) || eventIds.length < 1 || eventIds.length > LIMITS.batch
      || !eventIds.every(id => typeof id === 'string' && id.length > 0 && id.isWellFormed() && Buffer.byteLength(id) <= LIMITS.idBytes && !id.includes('\0'))) fail('invalid-event-ids');
    // Only one-way, namespace-scoped identifiers ever reach SQLite.
    const keys = eventIds.map(id => createHmac('sha256', this.#namespace).update(id, 'utf8').digest());
    return this.#guard(() => this.#transaction(() => {
      const now = this.#time();
      let count = this.#query('SELECT entries FROM settings WHERE id=1').get().entries;
      return keys.map(key => {
        const existing = this.#query('SELECT receipt,state FROM receipts WHERE event_digest=?').get(key);
        if (existing) return { inserted: false, receipt: existing.receipt, state: existing.state };
        if (count >= this.#config.maxEntries) fail('capacity');
        const receipt = randomUUID();
        this.#query("INSERT INTO receipts(receipt,event_digest,state,attempts,available_at,created_at,updated_at) VALUES (?,?,'queued',0,?,?,?)").run(receipt, key, now, now, now);
        count += 1;
        return { inserted: true, receipt, state: 'queued' };
      });
    }));
  }

  claim({ limit = 1 } = {}) {
    if (!int(limit, 1, LIMITS.page)) fail('invalid-limit');
    return this.#guard(() => this.#transaction(() => {
      const now = this.#time();
      this.#query(`UPDATE receipts SET state=CASE WHEN attempts>=? THEN 'dead' ELSE 'queued' END,
        available_at=?,leased_until=NULL,lease_digest=NULL,updated_at=?
        WHERE seq IN (SELECT seq FROM receipts WHERE state='leased' AND leased_until<=? ORDER BY leased_until,seq LIMIT 1000)`)
        .run(this.#config.maxAttempts, now, now, now);
      const ready = this.#query("SELECT seq,receipt,attempts FROM receipts WHERE state='queued' AND available_at<=? ORDER BY available_at,seq LIMIT ?").all(now, limit);
      return ready.map(row => {
        const token = randomBytes(32);
        const leaseUntil = now + this.#config.leaseMs;
        this.#query("UPDATE receipts SET state='leased',attempts=attempts+1,leased_until=?,lease_digest=?,updated_at=? WHERE seq=?")
          .run(leaseUntil, digest(token), now, row.seq);
        return new Lease({ receipt: row.receipt, attempt: row.attempts + 1, leaseUntil }, (action, delayMs) => this.#settle(row.receipt, token, action, delayMs));
      });
    }));
  }
  #settle(receipt, token, action, delayMs = 0) {
    if (!int(delayMs, 0, 3600000)) fail('invalid-delay');
    return this.#guard(() => {
      const now = this.#time();
      const state = action === 'complete' ? "'done'" : "CASE WHEN attempts>=? THEN 'dead' ELSE 'queued' END";
      const args = action === 'complete' ? [] : [this.#config.maxAttempts];
      const result = this.#query(`UPDATE receipts SET state=${state},available_at=?,leased_until=NULL,lease_digest=NULL,updated_at=?
        WHERE receipt=? AND state='leased' AND lease_digest=? AND leased_until>? RETURNING receipt,state,attempts`)
        .get(...args, now + delayMs, now, receipt, digest(token), now);
      if (!result) fail('lease-lost');
      return { ...result };
    });
  }
  requeue(receipt) {
    if (typeof receipt !== 'string' || !UUID.test(receipt)) fail('invalid-receipt');
    return this.#guard(() => {
      const now = this.#time();
      const result = this.#query("UPDATE receipts SET state='queued',attempts=0,available_at=?,updated_at=? WHERE receipt=? AND state IN ('done','dead') RETURNING receipt,state,attempts")
        .get(now, now, receipt);
      if (!result) fail('not-terminal');
      return { ...result };
    });
  }
  stats() {
    return this.#guard(() => this.#transaction(() => {
      const counts = { queued: 0, leased: 0, done: 0, dead: 0 };
      for (const row of this.#query('SELECT state,count(*) AS n FROM receipts GROUP BY state').all()) counts[row.state] = row.n;
      const retained = this.#query('SELECT entries FROM settings WHERE id=1').get().entries;
      const expiredLeases = this.#query("SELECT count(*) AS n FROM receipts WHERE state='leased' AND leased_until<=?").get(this.#time()).n;
      return { version: 1, retained, ...counts, expiredLeases, ...this.#config };
    }, true));
  }
  list({ state, after = 0, limit = 100 } = {}) {
    if ((state !== undefined && !STATES.has(state)) || !int(after, 0, Number.MAX_SAFE_INTEGER) || !int(limit, 1, LIMITS.page)) fail('invalid-page');
    return this.#guard(() => {
      const rows = state === undefined
        ? this.#query(`SELECT ${FIELDS} FROM receipts WHERE seq>? ORDER BY seq LIMIT ?`).all(after, limit)
        : this.#query(`SELECT ${FIELDS} FROM receipts WHERE state=? AND seq>? ORDER BY seq LIMIT ?`).all(state, after, limit);
      const nextAfter = rows.length ? rows.at(-1).seq : after;
      return { version: 1, nextAfter, receipts: rows.map(({ seq, ...metadata }) => ({ ...metadata })) };
    });
  }
  prune({ before, limit = 1000 } = {}) {
    if (!int(before, 0, Number.MAX_SAFE_INTEGER) || !int(limit, 1, LIMITS.page)) fail('invalid-prune');
    return this.#guard(() => this.#transaction(() => {
      const result = this.#query("DELETE FROM receipts WHERE seq IN (SELECT seq FROM receipts WHERE state IN ('done','dead') AND updated_at<? ORDER BY updated_at,seq LIMIT ?)").run(before, limit);
      return { removed: result.changes };
    }));
  }
  close() {
    if (this.#closed) return;
    this.#guard(() => this.#db.close());
    this.#closed = true;
  }
  toJSON() { return { type: 'WebhookLedger', closed: this.#closed }; }
  [inspect.custom]() { return this.toJSON(); }
}
