import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
for (const dir of ['src', 'bin', 'examples', 'scripts', 'test', 'fixtures']) {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', join(dir, file)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
const result = spawnSync(process.execPath, ['--test'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
