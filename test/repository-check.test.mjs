import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { checkRepository, git } from '../scripts/repository-check.mjs';
import { buildRelease } from '../scripts/build-release.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'repository-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Release Fixture']);
  git(root, ['config', 'user.email', 'release@example.invalid']);
  for (const name of ['README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'RELEASING.md']) writeFileSync(join(root, name), '# Fixture\n');
  writeFileSync(join(root, '.gitignore'), '.release/\n');
  const metadata = { name: 'release-fixture', version: '1.0.0', license: 'MIT', engines: { node: '>=22' } };
  writeFileSync(join(root, 'package.json'), JSON.stringify(metadata));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: metadata.name, version: metadata.version, packages: { '': metadata } }));
  return root;
}
const codes = report => report.issues.map(issue => issue.code);

function archivePaths(tar) {
  const paths = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const name = field(0, 100);
    const prefix = field(345, 500);
    if (!['x', 'g'].includes(field(156, 157))) paths.push(prefix ? `${prefix}/${name}` : name);
    const size = Number.parseInt(field(124, 136).trim(), 8) || 0;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return paths;
}

test('repository gate accepts aligned metadata and public examples', t => {
  const root = fixture(t);
  writeFileSync(join(root, '.env.example'), 'PORT=3000\n');
  assert.equal(checkRepository(root, { tag: 'v1.0.0' }).ok, true);
  assert.ok(codes(checkRepository(root, { tag: 'v2.0.0' })).includes('tag-version'));
});

test('gate blocks sensitive files and credential patterns without echoing contents or names', t => {
  const root = fixture(t);
  const marker = 'PRIVATE_SENTINEL_FILENAME';
  const token = 'ghp_' + 'A'.repeat(36);
  writeFileSync(join(root, `${marker}.key`), token);
  const report = checkRepository(root);
  assert.ok(codes(report).includes('sensitive-file'));
  assert.ok(codes(report).includes('credential-pattern'));
  assert.equal(JSON.stringify(report).includes(token), false);
  assert.equal(JSON.stringify(report).includes(marker), false);
});

test('tracked sensitive files are checked even when ignored', t => {
  const root = fixture(t);
  writeFileSync(join(root, '.env'), 'PRIVATE=fixture\n');
  git(root, ['add', '.env']);
  writeFileSync(join(root, '.gitignore'), '.env\n.release/\n');
  assert.ok(codes(checkRepository(root)).includes('sensitive-file'));
});

test('workflow gate requires immutable action references', t => {
  const root = fixture(t);
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, '.github/workflows/ci.yml'), 'jobs:\n  check:\n    steps:\n      - uses: actions/checkout@v7\n');
  assert.ok(codes(checkRepository(root)).includes('unpinned-action'));
  writeFileSync(join(root, '.github/workflows/ci.yml'), `jobs:\n  check:\n    steps:\n      - uses: actions/checkout@${'a'.repeat(40)}\n`);
  assert.equal(checkRepository(root).ok, true);
});

test('release source archives are reproducible and omit ignored local files', t => {
  const root = fixture(t);
  git(root, ['add', '.']); git(root, ['commit', '-m', 'fixture']); git(root, ['tag', 'v1.0.0']);
  const first = buildRelease(root, { tag: 'v1.0.0' });
  const bytes = readFileSync(resolve(root, '.release', first.archive));
  const second = buildRelease(root, { tag: 'v1.0.0' });
  assert.equal(first.sha256, second.sha256);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), first.sha256);
  const paths = archivePaths(gunzipSync(bytes));
  assert.equal(paths.some(path => path.split('/').some(part => ['.git', '.release'].includes(part))), false);
  assert.ok(paths.some(path => path.endsWith('/README.md')));
});

test('release build rejects a linked output directory without writing outside the repository', t => {
  const root = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'release-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  git(root, ['add', '.']); git(root, ['commit', '-m', 'fixture']);
  symlinkSync(outside, join(root, '.release'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => buildRelease(root), /unsafe-output/);
  assert.deepEqual(readdirSync(outside), []);
});

test('release build rejects dirty sources and tags pointing to another commit', t => {
  const root = fixture(t);
  git(root, ['add', '.']); git(root, ['commit', '-m', 'first']); git(root, ['tag', 'v1.0.0']);
  writeFileSync(join(root, 'README.md'), '# Changed\n');
  assert.throws(() => buildRelease(root), /dirty-worktree/);
  git(root, ['add', '.']); git(root, ['commit', '-m', 'second']);
  assert.throws(() => buildRelease(root, { tag: 'v1.0.0' }), /tag-commit/);
});
