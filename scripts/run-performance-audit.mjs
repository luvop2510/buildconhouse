import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const productionBackend = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8')).build.production.env.EXPO_PUBLIC_BACKEND_URL;
export const preparationScripts = ['build', 'test:mobile-budget', 'test:frontend-performance', 'test:page-loading-performance', 'test:catalog-pagination', 'test:api-client', 'test:api-proxy', 'test:sound-feedback', 'test:release-stability'];
const manifestPath = 'output/performance-ci/export.json';
const phaseEvidence = {
  stability: ['output/playwright/stability-results.json', 'output/playwright/stability-summary.json'],
  timing: ['output/playwright/performance-results.json', 'output/playwright/performance-summary.json'],
};
const stabilityShardCount = 4;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
function save(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); }
function identity(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Partial audit phases are restricted to this GitHub Actions run');
  assert.match(env.GITHUB_RUN_ID || '', /^\d+$/); assert.match(env.GITHUB_RUN_ATTEMPT || '', /^\d+$/);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  return { run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, sha: env.GITHUB_SHA };
}
function artifact(env) {
  assert.match(env.PERFORMANCE_EXPORT_ARTIFACT_ID || '', /^\d+$/, 'Missing immutable export artifact ID');
  assert.match(env.PERFORMANCE_EXPORT_ARTIFACT_DIGEST || '', /^[a-f0-9]{64}$/, 'Missing upload-artifact v4 digest');
  return { id: env.PERFORMANCE_EXPORT_ARTIFACT_ID, digest: env.PERFORMANCE_EXPORT_ARTIFACT_DIGEST };
}
function exportFiles(root) {
  const files = {};
  function walk(directory) {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry), stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink(), 'Export artifact must not contain symlinks');
      if (stat.isDirectory()) walk(path);
      else { assert.ok(stat.isFile()); files[relative(root, path)] = digest(readFileSync(path)); }
    }
  }
  walk(join(root, 'dist/client'));
  assert.ok(Object.keys(files).some(path => path.endsWith('.html')), 'Current build has no HTML export');
  const budget = 'output/playwright/bundle-budget.json'; files[budget] = digest(readFileSync(join(root, budget)));
  return files;
}
export function verifyExport(root, env) {
  const manifest = json(join(root, manifestPath));
  assert.equal(manifest.schema, 'performance-export/v1');
  assert.deepEqual(manifest.identity, identity(env), 'Export belongs to another source, run or attempt');
  assert.deepEqual(exportFiles(root), manifest.files, 'Export bytes/bundle evidence changed after preparation');
  return { identity: manifest.identity, artifact: artifact(env), manifestSha256: digest(readFileSync(join(root, manifestPath))) };
}
export function verifyBrowserEvidence(report, phase, partial = false) {
  const profiles = ['android-chrome', 'iphone-safari', 'ipad-safari', 'desktop-chrome'];
  assert.deepEqual(report.config?.projects?.map(project => project.name).sort(), [...profiles].sort(), 'All four browser profiles are mandatory');
  for (const project of report.config.projects) { assert.equal(project.retries, 0); assert.equal(project.timeout, 30000); }
  assert.equal(report.errors?.length || 0, 0, 'Browser runner errors are blocking');
  const executed = [];
  function collect(suites) {
    for (const suite of suites || []) {
      for (const spec of suite.specs || []) for (const test of spec.tests || []) {
        assert.equal(spec.ok, true); assert.equal(test.expectedStatus, 'passed'); assert.equal(test.status, 'expected');
        assert.ok(test.timeout > 0 && test.timeout <= 30000, 'Browser scenario deadlines must not increase');
        assert.equal(test.results?.length, 1, 'Browser retries are forbidden');
        assert.equal(test.results[0].status, 'passed'); assert.equal(test.results[0].retry, 0);
        assert.equal(test.results[0].errors?.length || 0, 0); executed.push({ project: test.projectName, key: `${test.projectName}:${spec.file}:${spec.title}` });
      }
      collect(suite.suites);
    }
  }
  collect(report.suites);
  if (phase === 'timing') assert.equal(executed.length, 60, 'All 60 current timing scenarios are mandatory');
  else if (partial) assert.ok(executed.length > 0, 'Empty stability shard');
  else assert.ok(executed.length >= 620, 'Full current stability scenario evidence is required');
  assert.equal(new Set(executed.map(test => test.key)).size, executed.length, 'Duplicate browser scenarios cannot replace missing evidence');
  assert.equal(report.stats?.expected, executed.length);
  for (const key of ['unexpected', 'flaky', 'skipped']) assert.equal(report.stats[key], 0, `${key} cases block the audit`);
  for (const profile of profiles) {
    const count = executed.filter(test => test.project === profile).length;
    if (phase === 'timing') assert.equal(count, 15, 'Every profile must execute all 15 timing scenarios');
    else if (!partial) assert.ok(count > 0, 'Browser profile has no executed evidence');
  }
  return executed.length;
}

export function mergeStabilityShards(reports) {
  assert.equal(reports.length, stabilityShardCount, 'All four stability shards are mandatory');
  for (const report of reports) verifyBrowserEvidence(report, 'stability', true);
  const merged = structuredClone(reports[0]);
  merged.suites = reports.flatMap(report => report.suites);
  for (const key of ['expected', 'unexpected', 'flaky', 'skipped']) merged.stats[key] = reports.reduce((sum, report) => sum + report.stats[key], 0);
  verifyBrowserEvidence(merged, 'stability');
  return merged;
}

export function runPerformanceAudit({ args = process.argv.slice(2), env = process.env, root = process.cwd(), run = spawnSync } = {}) {
  assert.ok(args.length === 0 || args.length === 1 && /^--ci-phase=(prepare|stability|timing|aggregate)$/.test(args[0]), 'Use the full local audit or an explicit guarded CI phase');
  const phase = args[0]?.split('=')[1];
  if (phase) identity(env);
  const auditEnv = { ...env, EXPO_NO_DOTENV: '1', BACKEND_URL: env.BACKEND_URL || productionBackend };
  const checked = (command, arguments_, options = {}) => {
    const result = run(command, arguments_, { cwd: root, stdio: 'inherit', env: auditEnv, ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) { const error = new Error(`Performance audit command failed: ${command}`); error.exitCode = result.status ?? 1; throw error; }
  };
  const npm = script => { console.log(`Performance audit: npm run ${script}`); checked('npm', ['run', script]); };
  const summary = () => checked(process.execPath, ['scripts/summarize-performance.mjs']);
  if (!phase || phase === 'prepare') {
    const python = env.FORGE_AUDIT_PYTHON || (existsSync(join(root, 'backend/.venv/bin/python')) ? join(root, 'backend/.venv/bin/python') : 'python3');
    checked(python, ['-m', 'pytest', '-q', 'tests/unit/test_catalog_refresh_resilience.py', 'tests/unit/test_backend_page_performance.py', 'tests/unit/test_catalog_hydration_performance.py'], {
      cwd: join(root, 'backend'), env: { ...env, PYTHON_DOTENV_DISABLED: '1', MONGO_URL: 'mongodb://localhost:27017', DB_NAME: 'forge_ci_unit_tests',
        JWT_SECRET: 'ci-unit-test-secret-not-a-real-secret-32chars', JWT_ALGORITHM: 'HS256', JWT_EXP_MINUTES: '43200',
        MEDIA_STORAGE_DRIVER: 'supabase', SUPABASE_URL: 'https://ci-placeholder.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'ci-placeholder-not-real', SUPABASE_ANON_KEY: 'ci-placeholder-not-real',
        SUPABASE_PUBLIC_BUCKET: 'forge-products', SUPABASE_PRIVATE_BUCKET: 'forge-private', FORGE_ALLOW_DEMO_SEED: 'false', ENVIRONMENT: 'production' },
    });
    for (const script of preparationScripts) npm(script);
    if (phase) save(join(root, manifestPath), { schema: 'performance-export/v1', identity: identity(env), files: exportFiles(root) });
  }
  if (!phase) {
    npm('test:e2e:stability'); npm('test:e2e:performance'); summary();
  } else if (phase === 'stability' || phase === 'timing') {
    const binding = verifyExport(root, env);
    if (phase === 'stability' && env.PERFORMANCE_STABILITY_SHARD) {
      const shard = env.PERFORMANCE_STABILITY_SHARD;
      assert.match(shard, /^[1-4]$/, 'Stability shard must be 1 through 4');
      auditEnv.PERFORMANCE_STABILITY_SHARD = shard;
      checked(process.execPath, ['scripts/test-release-network-routing.mjs']);
      checked('npx', ['playwright', 'test', '--config', 'playwright.stability.config.ts', `--shard=${shard}/${stabilityShardCount}`]);
      const reportPath = `output/playwright/stability-shards/${shard}/results.json`;
      const report = json(join(root, reportPath));
      verifyBrowserEvidence(report, 'stability', true);
      assert.deepEqual(verifyExport(root, env), binding, 'Stability shard modified its immutable export');
      save(join(root, `output/performance-ci/stability-${shard}.json`), { schema: 'performance-stability-shard/v1', shard: Number(shard), count: stabilityShardCount,
        ...binding, files: { [reportPath]: digest(readFileSync(join(root, reportPath))) } });
      console.log(`Stability shard ${shard}/${stabilityShardCount} passed; full acceptance requires all shards and the complete route/scenario registry.`);
      return;
    }
    npm(phase === 'stability' ? 'test:e2e:stability' : 'test:e2e:performance');
    if (phase === 'timing') summary();
    verifyBrowserEvidence(json(join(root, phaseEvidence[phase][0])), phase);
    assert.deepEqual(verifyExport(root, env), binding, 'Browser phase modified its immutable export');
    save(join(root, `output/performance-ci/${phase}.json`), { schema: 'performance-phase/v1', phase, ...binding,
      files: Object.fromEntries(phaseEvidence[phase].map(path => [path, digest(readFileSync(join(root, path)))])) });
  } else if (phase === 'aggregate') {
    for (const name of ['PREPARE', 'STABILITY', 'TIMING']) assert.equal(env[`PERFORMANCE_${name}_RESULT`], 'success', `${name} job did not succeed, including required artifact upload`);
    const binding = verifyExport(root, env);
    if (env.PERFORMANCE_STABILITY_SHARDED === 'true') {
      const reports = [];
      for (let shard = 1; shard <= stabilityShardCount; shard++) {
        const receipt = json(join(root, `output/performance-ci/stability-${shard}.json`));
        assert.equal(receipt.schema, 'performance-stability-shard/v1');
        assert.equal(receipt.shard, shard); assert.equal(receipt.count, stabilityShardCount);
        for (const key of ['identity', 'artifact', 'manifestSha256']) assert.deepEqual(receipt[key], binding[key], 'Shard belongs to another export/run');
        const path = `output/playwright/stability-shards/${shard}/results.json`;
        assert.deepEqual(Object.keys(receipt.files), [path], 'Required shard report missing');
        assert.equal(digest(readFileSync(join(root, path))), receipt.files[path], 'Shard evidence changed after its run');
        reports.push(json(join(root, path)));
      }
      save(join(root, phaseEvidence.stability[0]), mergeStabilityShards(reports));
    }
    for (const name of ['stability', 'timing']) {
      if (name === 'stability' && env.PERFORMANCE_STABILITY_SHARDED === 'true') continue;
      const receipt = json(join(root, `output/performance-ci/${name}.json`));
      assert.equal(receipt.schema, 'performance-phase/v1'); assert.equal(receipt.phase, name);
      for (const key of ['identity', 'artifact', 'manifestSha256']) assert.deepEqual(receipt[key], binding[key], 'Browser evidence belongs to another export/run');
      assert.deepEqual(Object.keys(receipt.files).sort(), [...phaseEvidence[name]].sort(), 'Required phase evidence is missing');
      for (const [path, hash] of Object.entries(receipt.files)) assert.equal(digest(readFileSync(join(root, path))), hash, 'Phase evidence changed after its successful run');
      verifyBrowserEvidence(json(join(root, phaseEvidence[name][0])), name);
    }
    // Recompute both summaries from their actual reports, retaining the existing
    // dynamic every-route verifier and performance budget/metric summary.
    checked(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/verify-release-stability.mjs']);
    summary();
  }
  console.log(`Performance audit passed: ${phase || 'full local audit'}; current export, unchanged budgets and complete required evidence.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { runPerformanceAudit(); } catch (error) { console.error(error.message); process.exitCode = error.exitCode || 1; }
}
