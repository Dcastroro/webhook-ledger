import { mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { checkRepository, git, POLICY_VERSION } from './repository-check.mjs';

function rejectLinkedOutput(path, directory = false) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('unsafe-output');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function buildRelease(root, { tag } = {}) {
  root = resolve(root);
  const output = resolve(root, '.release');
  rejectLinkedOutput(output, true);
  if (git(root, ['status', '--porcelain', '--untracked-files=normal']).length) throw new Error('dirty-worktree');
  if (!checkRepository(root, { tag }).ok) throw new Error('repository-gate');
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const commit = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('commit-format');
  if (tag !== undefined && git(root, ['rev-parse', `${tag}^{commit}`]).toString('utf8').trim() !== commit) throw new Error('tag-commit');
  const stem = `${manifest.name}-v${manifest.version}-${commit.slice(0, 12)}`;
  const archive = `${stem}.tar.gz`;
  const tar = git(root, ['archive', '--format=tar', `--prefix=${stem}/`, commit], 67108864);
  const bytes = gzipSync(tar, { level: 9 });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  rejectLinkedOutput(output, true);
  mkdirSync(output, { recursive: true });
  for (const name of [archive, 'SHA256SUMS', 'release-manifest.json', 'RELEASE_NOTES.md']) rejectLinkedOutput(resolve(output, name));
  const metadata = { policyVersion: POLICY_VERSION, project: manifest.name, version: manifest.version, commit, archive, sha256 };
  writeFileSync(resolve(output, archive), bytes);
  writeFileSync(resolve(output, 'SHA256SUMS'), `${sha256}  ${archive}\n`);
  writeFileSync(resolve(output, 'release-manifest.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  writeFileSync(resolve(output, 'RELEASE_NOTES.md'), `Source release ${manifest.version}.\n\nCommit: ${commit}\n\nThe release workflow verifies repository policy and tests before packaging. SHA256SUMS verifies archive integrity; it is not an independent signature. See CHANGELOG.md and RELEASING.md in the source archive for details. This workflow does not publish to npm.\n`);
  return metadata;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== '--tag' || !/^v\d+\.\d+\.\d+$/.test(args[1]))) throw new Error('usage');
    const metadata = buildRelease(resolve(dirname(fileURLToPath(import.meta.url)), '..'), { tag: args[1] });
    console.log(JSON.stringify({ ok: true, ...metadata }, null, 2));
  } catch {
    console.log(JSON.stringify({ ok: false, error: { code: 'release-build-failed' } }));
    process.exitCode = 1;
  }
}
