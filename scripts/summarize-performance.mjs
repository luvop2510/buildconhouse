import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';

const directory = 'output/playwright';
const result = JSON.parse(await readFile(process.env.PERFORMANCE_REPORT || `${directory}/performance-results.json`, 'utf8'));
const bundle = JSON.parse(await readFile(`${directory}/bundle-budget.json`, 'utf8'));
const metrics = [];
function collect(suites) {
  for (const suite of suites) {
    for (const spec of suite.specs || []) for (const test of spec.tests || []) for (const attempt of test.results || []) {
      for (const attachment of attempt.attachments || []) {
        if (attachment.contentType !== 'application/json') continue;
        const content = attachment.body ? Buffer.from(attachment.body, 'base64').toString() : null;
        if (content) metrics.push({ metric: attachment.name, scenario: spec.title, device: test.projectName, result: attempt.status, ...JSON.parse(content) });
      }
    }
    collect(suite.suites || []);
  }
}
// Performance attachments are inline Playwright JSON bodies. Keep this summary
// free of credentials/real data: browser scenarios use only hermetic fixtures.
collect(result.suites);
const summary = { stats: result.stats, bundlePages: bundle.pages.length, largestInitialJsKb: Math.max(...bundle.pages.map(page => page.gzipKb)), metrics };
await writeFile(`${directory}/performance-summary.json`, JSON.stringify(summary, null, 2));
const text = `### Performance acceptance\n\nPasses: ${result.stats.expected}; failures: ${result.stats.unexpected}; flaky: ${result.stats.flaky}; skipped: ${result.stats.skipped}.\n\nAll ${summary.bundlePages} exported pages checked; largest initial JavaScript ${summary.largestInitialJsKb} KiB gzip (576 KiB limit). Detailed startup, interaction, request and CPU evidence is in performance-summary.json. Browser emulation does not certify physical devices or production network latency.\n`;
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
if (result.stats.expected < 40 || result.stats.unexpected || result.stats.flaky || result.stats.skipped || result.errors?.length) process.exitCode = 1;
