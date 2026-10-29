import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requiredStabilityScenarios, stabilityProjects, stabilityRoutes, stabilityRouteTitle } from './stability-routes.ts';
import { verifyStabilityInventory, verifyStabilityReport } from './verify-release-stability.mjs';

// Use Playwright's real collection, including generated test titles, instead of
// synthesizing both expected and actual titles from the same registry.
const inventoryEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PLAYWRIGHT_JSON_OUTPUT')));
const inventoryProcess = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.stability.config.ts', '--list', '--reporter=json'], { encoding: 'utf8', env: inventoryEnv, maxBuffer: 16 * 1024 * 1024 });
assert.equal(inventoryProcess.status, 0, inventoryProcess.stderr || 'Stability test collection failed');
const inventory = JSON.parse(inventoryProcess.stdout);
const collected = verifyStabilityInventory(inventory);
const missingInventory = structuredClone(inventory);
function renameRequired(suites) {
  for (const suite of suites) {
    for (const spec of suite.specs || []) if (spec.file === 'redesign-font-readiness.spec.ts' && spec.title === requiredStabilityScenarios['redesign-font-readiness.spec.ts'][0]) { spec.title = 'Renamed requirement without registry update'; return true; }
    if (renameRequired(suite.suites || [])) return true;
  }
  return false;
}
assert.ok(renameRequired(missingInventory.suites));
assert.throws(() => verifyStabilityInventory(missingInventory), /Missing or duplicate regression scenario/);
console.log(`Release stability inventory: ${collected} current scenarios collected; every required route, title and device is present.`);

// Platform roots must consume one guard; a native-only repair once left web
// redirecting transient session failures to login. Browser scenarios below the
// release gate validate the behavior as well as this architectural constraint.
for (const path of ['../app/_layout.tsx', '../app/_layout.web.tsx']) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  assert.match(source, /import \{ AuthGate \} from "@\/src\/components\/AuthGate"/);
  assert.doesNotMatch(source, /function AuthGate\(/, 'Session routing must not fork between platforms');
}
const routes = ['/godown-stock', '/quotations/new'];
const specs = [];
for (const projectName of stabilityProjects) {
  for (const [file, title] of [
    ...routes.map(route => ['app-audit.spec.ts', stabilityRouteTitle(route)]),
    ...Object.entries(requiredStabilityScenarios).flatMap(([file, titles]) => titles.map(title => [file, title])),
  ]) specs.push({ file, title, ok: true, tests: [{ projectName, timeout: 30_000, expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', retry: 0, errors: [] }] }] });
}
const passing = {
  config: { projects: stabilityProjects.map(name => ({ name, retries: 0, timeout: 30_000 })) },
  suites: [{ specs }], stats: { expected: specs.length, unexpected: 0, flaky: 0, skipped: 0 }, errors: [],
};
assert.equal(verifyStabilityReport(passing, routes).passed, specs.length);
const reject = (mutate, pattern) => {
  const report = structuredClone(passing);
  mutate(report);
  assert.throws(() => verifyStabilityReport(report, routes), pattern);
};
reject(report => { report.suites = []; }, /No stability suites/);
reject(report => { report.errors.push({ message: 'Runner crashed' }); }, /runner errors/);
reject(report => { report.config.projects.pop(); }, /Every release device/);
reject(report => { report.config.projects[0].retries = 1; }, /retries must remain disabled/);
reject(report => { report.config.projects[0].timeout = 60_000; }, /deadlines must remain unchanged/);
reject(report => { report.suites[0].specs[0].tests[0].timeout = 90_000; }, /deadline was increased/);
reject(report => { report.suites[0].specs.shift(); }, /Missing or duplicate route/);
reject(report => { report.suites[0].specs.push(report.suites[0].specs[0]); }, /Missing or duplicate route/);
reject(report => { report.suites[0].specs.splice(2, 1); }, /Missing or duplicate regression scenario/);
reject(report => { report.stats.expected = 999; }, /Pass counts/);
reject(report => { report.stats.skipped = 1; }, /skipped stability/);
reject(report => { report.stats.flaky = 1; }, /flaky stability/);
reject(report => { report.suites[0].specs[0].tests[0].expectedStatus = 'failed'; }, /Expected failures/);
reject(report => { report.suites[0].specs[0].tests[0].results[0].status = 'skipped'; }, /did not pass/);
reject(report => { report.suites[0].specs[0].tests[0].results.push({ status: 'passed', retry: 1 }); }, /without retries/);
reject(report => { report.suites[0].specs[0].tests[0].results[0].errors.push({ message: 'React render failed' }); }, /runtime errors/);

// New routes become mandatory without editing a hand-maintained allowlist.
const directory = await mkdtemp(join(tmpdir(), 'forge-stability-routes-'));
try {
  const app = join(directory, 'app', '(admin)');
  await mkdir(join(app, 'new-feature'), { recursive: true });
  for (const file of ['_layout.tsx', '+html.tsx', 'login.tsx', 'set-new-password.tsx', 'new-feature/index.tsx', 'new-feature/index.web.tsx', 'new-feature/[id].tsx', 'new-feature/browser-only.web.tsx', 'new-feature/native-only.ios.tsx']) {
    await writeFile(join(app, file), 'export default function Page() {}');
  }
  assert.deepEqual(stabilityRoutes(directory), ['/new-feature', '/new-feature/audit-record', '/new-feature/browser-only']);
  // Official browser containers mount the repository under /__w. Only route
  // segments may be classified as private; an ancestor must never erase coverage.
  for (const parent of ['__w', '+container']) {
    const containerRoot = join(directory, parent, 'repo');
    await mkdir(join(containerRoot, 'app', '(admin)'), { recursive: true });
    for (const file of ['_layout.tsx', '+html.tsx', 'visible.tsx']) {
      await writeFile(join(containerRoot, 'app', file), 'export default function Page() {}');
    }
    await writeFile(join(containerRoot, 'app', '(admin)', 'customers.tsx'), 'export default function Page() {}');
    assert.deepEqual(stabilityRoutes(containerRoot), ['/customers', '/visible']);
  }
  assert.throws(() => verifyStabilityReport(passing, [...routes, '/new-feature']), /Missing or duplicate route/);
} finally { await rm(directory, { recursive: true, force: true }); }
console.log('Release stability gate rejects missing routes/devices/suites, skips, flakes, retries, runner errors and misleading pass counts; new routes inherit required coverage.');
