import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const cli = fileURLToPath(new URL('../bin/webhook-ledger.mjs', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'webhook-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, path: join(root, 'ledger.sqlite'), input: join(root, 'input.json') };
}
function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  return result;
}

test('CLI initializes, imports and lists opaque metadata without original identifiers', t => {
  const { path, input } = fixture(t);
  const sentinel = 'PRIVATE_EVENT_SENTINEL_CLI_8932';
  writeFileSync(input, JSON.stringify([sentinel, sentinel, 'fictional-other']));
  assert.equal(run(['init', '--db', path]).status, 0);
  const imported = run(['import', '--db', path, '--input', input]);
  assert.equal(imported.status, 0);
  assert.deepEqual(JSON.parse(imported.stdout).result, { inserted: 2, duplicates: 1 });
  const listed = run(['list', '--db', path, '--limit', '1']);
  assert.equal(JSON.parse(listed.stdout).result.receipts.length, 1);
  const stats = run(['stats', '--db', path]);
  assert.equal(JSON.parse(stats.stdout).result.retained, 2);
  assert.equal((imported.stdout + listed.stdout + stats.stdout).includes(sentinel), false);
});

test('CLI rejects payload objects, invalid UTF-8 and oversized imports', t => {
  const { path, input } = fixture(t);
  for (const data of [JSON.stringify([{ id: 'one', payload: 'PRIVATE_SENTINEL' }]), '{PRIVATE_SENTINEL', Buffer.from([0xc3, 0x28]), Buffer.alloc(1048577)]) {
    writeFileSync(input, data);
    const result = run(['import', '--db', path, '--input', input]);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).error.code, 'invalid-import');
    assert.equal((result.stdout + result.stderr).includes('PRIVATE_SENTINEL'), false);
  }
});

test('CLI errors never echo filenames, invalid options or state input', t => {
  const { path } = fixture(t);
  for (const args of [[], ['--PRIVATE_SENTINEL'], ['stats'], ['stats', '--db', path, '--input', 'PRIVATE_SENTINEL'], ['list', '--db', path, '--state', 'PRIVATE_SENTINEL'], ['stats', '--db', 'PRIVATE_PATH_SENTINEL/missing.sqlite']]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal((result.stdout + result.stderr).includes('PRIVATE_SENTINEL'), false);
    assert.equal((result.stdout + result.stderr).includes('PRIVATE_PATH_SENTINEL'), false);
  }
});

test('CLI has no command that exports claims or lease credentials', t => {
  const { path } = fixture(t);
  const result = run(['claim', '--db', path]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, 'usage');
});

test('help and version work without opening a ledger', () => {
  assert.match(run(['--help']).stdout, /Usage:/);
  assert.equal(run(['--version']).stdout.trim(), '0.1.0');
});
