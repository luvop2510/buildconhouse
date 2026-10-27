import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { requiredStabilityScenarios, stabilityProjects, stabilityRoutes, stabilityRouteTitle } from './stability-routes.ts';

export function verifyStabilityReport(report, routes = stabilityRoutes()) {
  assert.ok(report && typeof report === 'object', 'Stability report is missing');
  assert.ok(Array.isArray(report.suites) && report.suites.length, 'No stability suites executed');
  assert.ok(!report.errors?.length, 'Stability runner errors are blocking');
  assert.deepEqual(report.config?.projects?.map(project => project.name).sort(), [...stabilityProjects].sort(), 'Every release device must run');
  assert.ok(report.config.projects.every(project => project.retries === 0), 'Stability retries must remain disabled');
  assert.ok(report.config.projects.every(project => project.timeout === 30_000), 'Stability project deadlines must remain unchanged');
  const executed = [];
  function collect(suites) {
    for (const suite of suites) {
      for (const spec of suite.specs || []) for (const test of spec.tests || []) {
        assert.equal(spec.ok, true, `Unhealthy scenario: ${spec.title}`);
        assert.equal(test.expectedStatus, 'passed', `Expected failures/skips are not acceptance: ${spec.title}`);
        assert.equal(test.status, 'expected', `Unsuccessful scenario: ${spec.title}`);
        assert.ok(Number.isInteger(test.timeout) && test.timeout > 0 && test.timeout <= 30_000, `Scenario deadline was increased: ${spec.title}`);
        assert.equal(test.results?.length, 1, `Scenario must pass once without retries: ${spec.title}`);
        assert.equal(test.results[0].status, 'passed', `Scenario did not pass: ${spec.title}`);
        assert.equal(test.results[0].retry, 0, `Retried scenario: ${spec.title}`);
        assert.ok(!test.results[0].errors?.length, `Scenario contains runtime errors: ${spec.title}`);
        executed.push({ file: spec.file, title: spec.title, project: test.projectName });
      }
      collect(suite.suites || []);
    }
  }
  collect(report.suites);
  for (const project of stabilityProjects) {
    for (const route of routes) {
      assert.equal(executed.filter(test => test.project === project && test.file === 'app-audit.spec.ts' && test.title === stabilityRouteTitle(route)).length, 1,
        `Missing or duplicate route acceptance: ${project} ${route}`);
    }
    for (const [file, scenarios] of Object.entries(requiredStabilityScenarios)) for (const title of scenarios) {
      assert.equal(executed.filter(test => test.project === project && test.file === file && test.title === title).length, 1,
        `Missing or duplicate regression scenario: ${project} ${file}: ${title}`);
    }
  }
  assert.equal(report.stats?.expected, executed.length, 'Pass counts must match actual executed evidence');
  for (const key of ['unexpected', 'flaky', 'skipped']) assert.equal(report.stats[key], 0, `${key} stability cases are blocking`);
  return { passed: executed.length, routes: routes.length, devices: stabilityProjects, failures: 0, flaky: 0, skipped: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = JSON.parse(await readFile('output/playwright/stability-results.json', 'utf8'));
  const summary = verifyStabilityReport(report);
  await writeFile('output/playwright/stability-summary.json', JSON.stringify(summary, null, 2));
  const message = `Stability acceptance: ${summary.passed} passes, every ${summary.routes} discovered route on ${summary.devices.length} devices; zero skipped, flaky or failed cases. Populated-response, navigation and update recovery suites also passed.\n`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message);
}
