import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POLICY_VERSION = 1;
const REQUIRED = ['README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'RELEASING.md'];
const PUBLIC_ENV = new Set(['.env.example', '.env.sample', 'examples/.env.example', 'examples/.env.valid', 'examples/.env.invalid']);
const TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
export function git(root, args, maxBuffer = 4194304) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('git-operation');
  return result.stdout;
}
export function checkRepository(root, { tag } = {}) {
  const issues = [];
  const add = (code, file, line) => issues.push({ code, ...(file !== undefined ? { file } : {}), ...(line ? { line } : {}) });
  let count = 0;
  try {
    root = resolve(root);
    const files = [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean))];
    count = files.length;
    if (count > 10000) throw new Error('file-limit');
    const texts = new Map();
    let totalBytes = 0;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const full = resolve(root, file);
      const rel = relative(root, full);
      if (isAbsolute(file) || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) { add('unsafe-path', index); continue; }
      let path = root;
      let unsafe = false;
      for (const component of rel.split(sep)) {
        path = resolve(path, component);
        if (lstatSync(path).isSymbolicLink()) { unsafe = true; break; }
      }
      if (unsafe) { add('symlink', index); continue; }
      const stat = lstatSync(full);
      if (!stat.isFile() || stat.size > 8388608) { add('file-limit', index); continue; }
      totalBytes += stat.size;
      if (totalBytes > 67108864) throw new Error('total-limit');
      const text = readFileSync(full).toString('utf8');
      texts.set(file, text);
      const normalized = file.replaceAll('\\', '/');
      const name = normalized.split('/').at(-1);
      if ((!PUBLIC_ENV.has(normalized) && /^\.env(?:\.|$)/i.test(name))
        || /(?:^|\/)(?:id_rsa|id_ed25519|credentials\.json|\.npmrc)$/i.test(normalized)
        || /\.(?:pem|p12|pfx|key|sqlite(?:-(?:wal|shm))?|db(?:-(?:wal|shm))?)$/i.test(name)) add('sensitive-file', index);
      for (const pattern of TOKEN_PATTERNS) {
        const match = pattern.exec(text);
        if (match) { add('credential-pattern', index, text.slice(0, match.index).split('\n').length); break; }
      }
      if (/^(?:<{7} |={7}$|>{7} )/m.test(text)) add('merge-conflict', index);
      if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(normalized)) {
        for (const [lineIndex, line] of text.split('\n').entries()) {
          const match = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/.exec(line);
          if (match && !match[1].startsWith('./') && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}$/.test(match[1])) add('unpinned-action', index, lineIndex + 1);
        }
        if (/^\s*pull_request_target\s*:/m.test(text)) add('privileged-pr-trigger', index);
        if (/persist-credentials:\s*true/.test(text)) add('persisted-checkout-credentials', index);
      }
    }
    for (const file of REQUIRED) if (!texts.get(file)?.trim()) add('required-document');
    const manifest = JSON.parse(texts.get('package.json'));
    const lock = JSON.parse(texts.get('package-lock.json'));
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(manifest.name ?? '') || !/^\d+\.\d+\.\d+$/.test(manifest.version ?? '') || !manifest.license || !manifest.engines?.node) add('package-metadata');
    if (lock.name !== manifest.name || lock.version !== manifest.version || lock.packages?.['']?.version !== manifest.version) add('lock-metadata');
    for (const file of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
      if (texts.has(file) && JSON.parse(texts.get(file)).version !== manifest.version) add('plugin-version');
    }
    if (tag !== undefined && tag !== `v${manifest.version}`) add('tag-version');
  } catch { add('repository-input'); }
  return { version: POLICY_VERSION, ok: issues.length === 0, files: count, issues };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--tag')) {
    console.log(JSON.stringify({ version: POLICY_VERSION, ok: false, issues: [{ code: 'usage' }] }));
    process.exitCode = 2;
  } else {
    const result = checkRepository(resolve(dirname(fileURLToPath(import.meta.url)), '..'), { tag: args[1] });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  }
}
