import { execFileSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const hook = resolve(root, execFileSync('git', ['rev-parse', '--git-path', 'hooks/pre-push'], { encoding: 'utf8' }).trim());
try {
  await access(hook);
  throw new Error(`An existing pre-push hook is present at ${hook}. Preserve it; add npm run test:performance:audit to that hook manually.`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(dirname(hook), { recursive: true });
await writeFile(hook, `#!/bin/sh\n# Forge performance audit. Installed by scripts/install-performance-hook.mjs.\nset -eu\ncd "$(git rev-parse --show-toplevel)"\nnpm run test:performance:audit\n`, { mode: 0o755, flag: 'wx' });
console.log(`Installed ${hook}. Every local push now audits the current release export. Remove this generated hook to uninstall; existing hooks are never replaced.`);
