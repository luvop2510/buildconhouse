import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { preparationScripts, runPerformanceAudit, verifyBrowserEvidence, verifyExport, mergeStabilityShards } from './run-performance-audit.mjs';

// Exercise the actual orchestrator with disposable files/command adapters.
// No build, browser, provider or operating database is started by these tests.
const directory = mkdtempSync(join(tmpdir(), 'forge-performance-gate-'));
const profiles = ['android-chrome', 'iphone-safari', 'ipad-safari', 'desktop-chrome'];
const stages = ['backend', ...preparationScripts, 'test:e2e:stability', 'test:e2e:performance', 'summary'];
const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: 'a'.repeat(40),
  PERFORMANCE_EXPORT_ARTIFACT_ID: '987', PERFORMANCE_EXPORT_ARTIFACT_DIGEST: 'b'.repeat(64),
  PERFORMANCE_PREPARE_RESULT: 'success', PERFORMANCE_STABILITY_RESULT: 'success', PERFORMANCE_TIMING_RESULT: 'success' };
delete env.BACKEND_URL;
function write(path, value) { const target = join(directory, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value)); }
function read(path) { return JSON.parse(readFileSync(join(directory, path), 'utf8')); }
function report(phase) {
  const perDevice = phase === 'stability' ? 155 : 15;
  const specs = profiles.flatMap(projectName => Array.from({ length: perDevice }, (_, index) => ({ file: `${phase}.spec.ts`, title: `case ${index}`, ok: true,
    tests: [{ projectName, timeout: 30000, expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', retry: 0, errors: [] }] }] })));
  return { config: { projects: profiles.map(name => ({ name, retries: 0, timeout: 30000 })) }, suites: [{ specs }],
    stats: { expected: specs.length, unexpected: 0, skipped: 0, flaky: 0 }, errors: [] };
}
let calls = [], failAt;
function run(command, args, options) {
  if (command === 'npx') {
    const shard = Number(options.env.PERFORMANCE_STABILITY_SHARD);
    assert.deepEqual(args, ['playwright', 'test', '--config', 'playwright.stability.config.ts', `--shard=${shard}/4`]);
    const partial = report('stability');
    partial.suites[0].specs = partial.suites[0].specs.slice((shard - 1) * 155, shard * 155);
    partial.stats.expected = 155;
    write(`output/playwright/stability-shards/${shard}/results.json`, partial);
    calls.push(`shard-${shard}`);
    return { status: failAt === 'shard' ? 42 : 0 };
  }
  if (args.includes('scripts/test-release-network-routing.mjs')) { calls.push('network'); return { status: 0 }; }
  const stage = command === 'npm' ? args[1] : args.includes('scripts/summarize-performance.mjs') ? 'summary' : args.includes('scripts/verify-release-stability.mjs') ? 'verify-stability' : 'backend';
  calls.push(stage);
  if (stage !== 'backend') { assert.equal(options.env.EXPO_NO_DOTENV, '1'); assert.match(options.env.BACKEND_URL, /^https:\/\/forge20-production-a8b0\.up\.railway\.app$/); }
  else { assert.equal(options.env.DB_NAME, 'forge_ci_unit_tests'); assert.equal(options.env.PYTHON_DOTENV_DISABLED, '1'); }
  if (stage === failAt) return { status: 42 };
  if (stage === 'build') { write('dist/client/index.html', '<html>fresh export</html>'); write('dist/client/chunk.js', 'current source'); }
  if (stage === 'test:mobile-budget') write('output/playwright/bundle-budget.json', { pages: [{ gzipKb: 480 }] });
  if (stage === 'test:e2e:stability') { write('output/playwright/stability-results.json', report('stability')); write('output/playwright/stability-summary.json', { passed: 620 }); }
  if (stage === 'test:e2e:performance') write('output/playwright/performance-results.json', report('timing'));
  if (stage === 'summary') write('output/playwright/performance-summary.json', { stats: read('output/playwright/performance-results.json').stats });
  return { status: 0 };
}
const audit = (phase, overrides = {}) => runPerformanceAudit({ args: phase ? [`--ci-phase=${phase}`] : [], env: { ...env, ...overrides }, root: directory, run });
try {
  for (const failure of stages) {
    calls = []; failAt = failure;
    assert.throws(() => audit(), error => error.exitCode === 42);
    assert.deepEqual(calls, stages.slice(0, stages.indexOf(failure) + 1), 'Full default must preserve exact order and failure status');
  }
  failAt = undefined; calls = []; audit(); assert.deepEqual(calls, stages, 'Full default includes fresh build, all contracts, both browser suites and summary');
  for (const phase of ['prepare', 'stability', 'timing', 'aggregate']) {
    calls = []; assert.throws(() => audit(phase, { GITHUB_ACTIONS: '' }), /restricted/); assert.deepEqual(calls, []);
  }
  assert.throws(() => runPerformanceAudit({ args: ['--reuse-export'], env, root: directory, run }));
  assert.throws(() => runPerformanceAudit({ args: ['--ci-phase=timing', '--grep=x'], env, root: directory, run }));
  calls = []; audit('prepare'); assert.deepEqual(calls, ['backend', ...preparationScripts]);
  assert.deepEqual(read('output/performance-ci/export.json').identity, { run: '1234', attempt: '2', sha: 'a'.repeat(40) });
  for (const override of [{ GITHUB_RUN_ID: 'foreign' }, { GITHUB_RUN_ID: '999' }, { GITHUB_RUN_ATTEMPT: '1' }, { GITHUB_SHA: 'c'.repeat(40) },
    { PERFORMANCE_EXPORT_ARTIFACT_ID: '' }, { PERFORMANCE_EXPORT_ARTIFACT_DIGEST: '' }]) {
    calls = []; assert.throws(() => audit('stability', override)); assert.deepEqual(calls, [], 'Foreign/missing artifact identity stops before browser execution');
  }
  write('dist/client/chunk.js', 'tampered'); assert.throws(() => verifyExport(directory, env), /bytes/); write('dist/client/chunk.js', 'current source');
  write('dist/client/extra.js', 'foreign'); assert.throws(() => verifyExport(directory, env), /bytes/); rmSync(join(directory, 'dist/client/extra.js'));
  for (const [phase, stage] of [['stability', 'test:e2e:stability'], ['timing', 'test:e2e:performance']]) {
    calls = []; failAt = stage; assert.throws(() => audit(phase), error => error.exitCode === 42); assert.deepEqual(calls, [stage]);
    assert.equal(readFileSync(join(directory, 'output/performance-ci/export.json'), 'utf8').includes('1234'), true);
  }
  failAt = undefined; calls = []; audit('stability'); assert.deepEqual(calls, ['test:e2e:stability']);
  calls = []; audit('timing'); assert.deepEqual(calls, ['test:e2e:performance', 'summary']);
  calls = []; audit('aggregate'); assert.deepEqual(calls, ['verify-stability', 'summary']);
  const receiptPath = 'output/performance-ci/timing.json', receipt = read(receiptPath);
  for (const change of [v => { v.identity.run = '999'; }, v => { v.identity.attempt = '1'; }, v => { v.identity.sha = 'f'.repeat(40); },
    v => { v.artifact.id = '123'; }, v => { v.artifact.digest = 'f'.repeat(64); }, v => { v.manifestSha256 = 'f'.repeat(64); },
    v => { delete v.files['output/playwright/performance-results.json']; }]) {
    const mutated = structuredClone(receipt); change(mutated); write(receiptPath, mutated); calls = [];
    assert.throws(() => audit('aggregate')); assert.deepEqual(calls, [], 'Foreign/tampered receipt never reaches aggregate acceptance');
  }
  write(receiptPath, receipt);
  rmSync(join(directory, receiptPath)); assert.throws(() => audit('aggregate')); write(receiptPath, receipt);
  const timing = read('output/playwright/performance-results.json'); write('output/playwright/performance-results.json', { ...timing, errors: ['tampered'] });
  assert.throws(() => audit('aggregate'), /evidence changed/); write('output/playwright/performance-results.json', timing);
  for (const phase of ['PREPARE', 'STABILITY', 'TIMING']) for (const status of ['', 'skipped', 'cancelled', 'failure']) {
    calls = []; assert.throws(() => audit('aggregate', { [`PERFORMANCE_${phase}_RESULT`]: status }), /job did not succeed/); assert.deepEqual(calls, []);
  }
  for (const phase of ['stability', 'timing']) for (const change of [v => { v.stats.skipped = 1; }, v => { v.stats.flaky = 1; }, v => { v.errors = ['crash']; },
    v => { v.config.projects.pop(); }, v => { v.config.projects[0].retries = 1; }, v => { v.config.projects[0].timeout = 60000; },
    v => { v.suites[0].specs.pop(); v.stats.expected--; }, v => { v.suites[0].specs[0].tests[0].results[0].retry = 1; },
    v => { v.suites[0].specs[0].tests[0].results.push({ status: 'passed', retry: 1 }); }, v => { v.suites[0].specs[1] = v.suites[0].specs[0]; }]) {
    const value = report(phase); change(value); assert.throws(() => verifyBrowserEvidence(value, phase));
  }
  const partials = [1, 2, 3, 4].map(shard => {
    const value = report('stability');
    value.suites[0].specs = value.suites[0].specs.slice((shard - 1) * 155, shard * 155);
    value.stats.expected = 155; return value;
  });
  assert.equal(mergeStabilityShards(partials).stats.expected, 620);
  assert.throws(() => mergeStabilityShards(partials.slice(1)), /four/);
  assert.throws(() => mergeStabilityShards([partials[0], partials[0], partials[2], partials[3]]), /Duplicate/);
  const skippedShard = structuredClone(partials); skippedShard[1].stats.skipped = 1;
  assert.throws(() => mergeStabilityShards(skippedShard), /skipped/);
  for (const shard of ['0', '5', '1/4', 'x']) {
    calls = []; assert.throws(() => audit('stability', { PERFORMANCE_STABILITY_SHARD: shard }), /1 through 4/); assert.deepEqual(calls, []);
  }
  failAt = 'shard'; assert.throws(() => audit('stability', { PERFORMANCE_STABILITY_SHARD: '1' }), error => error.exitCode === 42); failAt = undefined;
  for (const shard of ['1', '2', '3', '4']) {
    calls = []; audit('stability', { PERFORMANCE_STABILITY_SHARD: shard }); assert.deepEqual(calls, ['network', `shard-${shard}`]);
  }
  calls = []; audit('aggregate', { PERFORMANCE_STABILITY_SHARDED: 'true' }); assert.deepEqual(calls, ['verify-stability', 'summary']);
  const shardPath = 'output/performance-ci/stability-2.json', shardReceipt = read(shardPath);
  for (const change of [v => { v.shard = 3; }, v => { v.count = 3; }, v => { v.identity.sha = 'f'.repeat(40); }, v => { v.artifact.digest = 'f'.repeat(64); }, v => { v.files = {}; }]) {
    const value = structuredClone(shardReceipt); change(value); write(shardPath, value);
    assert.throws(() => audit('aggregate', { PERFORMANCE_STABILITY_SHARDED: 'true' }));
  }
  write(shardPath, shardReceipt);
  rmSync(join(directory, shardPath)); assert.throws(() => audit('aggregate', { PERFORMANCE_STABILITY_SHARDED: 'true' })); write(shardPath, shardReceipt);
  const partialPath = 'output/playwright/stability-shards/2/results.json', originalPartial = read(partialPath);
  write(partialPath, { ...originalPartial, errors: ['tampered'] });
  assert.throws(() => audit('aggregate', { PERFORMANCE_STABILITY_SHARDED: 'true' }), /evidence changed/); write(partialPath, originalPartial);
  audit('stability');
  for (const failure of ['verify-stability', 'summary']) { failAt = failure; assert.throws(() => audit('aggregate'), error => error.exitCode === 42); }
  const workflow = readFileSync(new URL('../.github/workflows/performance.yml', import.meta.url), 'utf8');
  assert.equal((workflow.match(/timeout-minutes: 20/g) || []).length, 4);
  assert.match(workflow, /performance:\n    if: always\(\)\n    needs: \[prepare, stability, timing\]/);
  assert.equal((workflow.match(/uses: actions\/upload-artifact@v4/g) || []).length, 4);
  assert.equal((workflow.match(/if-no-files-found: error/g) || []).length, 4);
  assert.match(workflow, /shard: \[1, 2, 3, 4\]/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /PERFORMANCE_STABILITY_SHARDED: "true"/);
  assert.match(workflow, /pattern: performance-stability-/);
  assert.match(workflow, /artifact-digest/); assert.match(workflow, /artifact-ids: \$\{\{ needs.prepare.outputs.export_id \}\}/);
  const { packageManager } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(packageManager, /^npm@\d+\.\d+\.\d+$/, 'Dependency setup must use an exact npm version');
  const verifyDependencySetup = job => {
    const setup = job.match(/^\s+- run:\s*(npm install --global[^\n]+)$/m)?.[1];
    assert.ok(setup, 'Pin npm before the clean dependency install');
    assert.deepEqual(setup.trim().split(/\s*&&\s*/).map(command => command.trim().split(/\s+/)), [
      ['npm', 'install', '--global', packageManager, '--ignore-scripts', '--no-audit', '--no-fund'],
      ['npm', 'ci', '--ignore-scripts'],
      ['npm', 'run', 'prepare:dependencies'],
    ], 'Pinned npm, clean lockfile install and explicit dependency preparation must all succeed in order');
  };
  verifyDependencySetup(workflow.split('  prepare:\n')[1]?.split(/\n  [a-z]+:\n/)[0]);
  const browserChecks = [];
  const image = 'mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27';
  for (const phase of ['stability', 'timing']) {
    const job = workflow.split(`  ${phase}:\n`)[1]?.split(/\n  [a-z]+:\n/)[0];
    assert.ok(job, 'Both browser phases must exist');
    assert.ok(job.includes(`image: ${image}`), 'Use the immutable matching official browser image');
    assert.match(job, /options: --ipc=host/);
    assert.match(job, /node-version: "22"/);
    verifyDependencySetup(job);
    assert.doesNotMatch(job, /playwright install|apt-get|apt install/, 'Browser jobs must not depend on OS mirror installs');
    assert.ok(job.includes(`--ci-phase=${phase}`));
    const check = job.match(/node <<'NODE'\n([\s\S]*?)\n          NODE/);
    assert.ok(check, 'Fail fast when the pinned image and installed browsers differ');
    browserChecks.push(check[1].replace(/^          /gm, ''));
  }
  assert.equal(browserChecks[0], browserChecks[1]);
  const verifyInstalledBrowsers = (version, missing) => {
    const checked = [];
    runInNewContext(browserChecks[0], { console: { log() {} }, require(name) {
      if (name === 'node:assert/strict') return assert;
      if (name === 'node:fs') return { constants: { X_OK: 1 }, accessSync(path, mode) {
        assert.equal(mode, 1); if (path === missing) throw new Error('Missing browser executable'); checked.push(path);
      } };
      if (name === '@playwright/test/package.json') return { version };
      if (name === '@playwright/test') return { chromium: { executablePath: () => '/browsers/chromium' }, webkit: { executablePath: () => '/browsers/webkit' } };
      throw new Error('Unexpected module');
    } });
    return checked;
  };
  assert.deepEqual(verifyInstalledBrowsers('1.63.0'), ['/browsers/chromium', '/browsers/webkit']);
  assert.throws(() => verifyInstalledBrowsers('1.64.0'), /pinned browser image/);
  for (const browser of ['chromium', 'webkit']) assert.throws(() => verifyInstalledBrowsers('1.63.0', `/browsers/${browser}`), /Missing browser executable/);
  console.log('Performance orchestration guards passed: unchanged full local order, every failure propagates; same-run immutable export, full 620/60 four-profile evidence, cross-run/tamper/truncation rejection and all-phase aggregate/artifact failures remain blocking. No build/browser/live calls.');
} finally { rmSync(directory, { recursive: true, force: true }); }
