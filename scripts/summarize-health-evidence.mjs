import { readFile, appendFile } from 'node:fs/promises';

// Keep technical results available in the job summary even when artifact
// storage is exhausted. Probe failures and upload failures still fail the job.
const paths = ['/api/health', '/api/health/ready', '/api/quotations'];
const numeric = value => Number.isFinite(value) && value >= 0 ? String(value) : 'unavailable';
const summaries = [];
for (const [label, file] of [['Vercel', process.argv[2]], ['Railway', process.argv[3]]]) {
  summaries.push(`### ${label} health evidence`);
  try {
    const report = JSON.parse(await readFile(file, 'utf8'));
    const observation = report.observations || report;
    summaries.push(`Probe result: ${report.passed === true ? 'PASS' : 'FAIL'}. Runner geography is unverified.`);
    for (const path of paths) {
      const probe = observation.probes?.find(value => value.path === path);
      summaries.push(`- ${path}: warm p50 ${numeric(probe?.warmP50Ms)} ms; p95 ${numeric(probe?.warmP95Ms)} ms.`);
    }
  } catch {
    summaries.push('Evidence unavailable. Inspect the failed probe step; availability is unverified.');
  }
  summaries.push('');
}
const summary = summaries.join('\n') + '\n';
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
