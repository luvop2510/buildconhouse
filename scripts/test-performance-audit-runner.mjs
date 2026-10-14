import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Execute the actual release gate with disposable command stubs. A failed
// stage must stop publication checks, and normal push shells must rebuild
// without loading .env or needing an ad hoc BACKEND_URL export.
const directory = await mkdtemp(join(tmpdir(), 'forge-performance-gate-'));
try {
  await mkdir(join(directory, 'backend'));
  const log = join(directory, 'commands.jsonl');
  const command = `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst stage = process.argv[1].endsWith('npm') ? process.argv[3] : 'backend';\nappendFileSync(process.env.AUDIT_TEST_LOG, JSON.stringify({ stage, backend: process.env.BACKEND_URL, noDotenv: process.env.EXPO_NO_DOTENV }) + '\\n');\nprocess.exit(stage === process.env.AUDIT_FAIL_STAGE ? 42 : 0);\n`;
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'npm'), command, { mode: 0o755 });
  await writeFile(join(directory, 'python'), command, { mode: 0o755 });
  const stages = ['backend', 'build', 'test:mobile-budget', 'test:frontend-performance', 'test:page-loading-performance', 'test:catalog-pagination', 'test:api-client', 'test:sound-feedback', 'test:release-stability', 'test:e2e:stability', 'test:e2e:performance'];
  for (const failAt of ['backend', 'build', 'test:release-stability', 'test:e2e:stability', 'test:e2e:performance']) {
    await writeFile(log, '');
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, FORGE_AUDIT_PYTHON: join(directory, 'python'), AUDIT_TEST_LOG: log, AUDIT_FAIL_STAGE: failAt };
    delete env.BACKEND_URL;
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run-performance-audit.mjs', import.meta.url))], { cwd: directory, env, encoding: 'utf8' });
    assert.equal(result.status, 42, result.stderr);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call.stage), stages.slice(0, stages.indexOf(failAt) + 1));
    for (const call of calls.filter(call => call.stage !== 'backend')) {
      assert.match(call.backend, /^https:\/\/forge20-production-a8b0\.up\.railway\.app$/);
      assert.equal(call.noDotenv, '1');
    }
  }
  console.log('Actual performance runner stops on backend/build/browser failures and rebuilds with production configuration and dotenv disabled.');
} finally { await rm(directory, { recursive: true, force: true }); }
