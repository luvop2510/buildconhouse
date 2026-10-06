import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { probeService } from './check-service-health.mjs';

// Availability monitoring has no approved latency SLO. Preserve timing evidence,
// debounce transient failures, and immediately flag unauthenticated success.
export function evaluateAvailability(report) {
  const expected = [['/api/health', 200], ['/api/health/ready', 200], ['/api/quotations', 401]];
  if (!report || !Array.isArray(report.probes) || report.probes.length !== expected.length) {
    throw new Error('Incomplete availability report');
  }
  const endpoints = report.probes.map((probe, index) => {
    const [path, status] = expected[index];
    if (probe.path !== path || probe.expectedStatus !== status || !Array.isArray(probe.samples) || probe.samples.length < 3 || probe.samples.length > 100) {
      throw new Error('Invalid availability probe');
    }
    let failures = 0, maxConsecutiveFailures = 0, unauthorizedSuccess = false;
    for (const sample of probe.samples) {
      if (!sample || typeof sample.valid !== 'boolean' ||
          (sample.status !== null && (!Number.isInteger(sample.status) || sample.status < 100 || sample.status > 599)) ||
          (sample.valid && sample.status !== status)) {
        throw new Error('Malformed availability sample');
      }
      failures = sample.valid ? 0 : failures + 1;
      maxConsecutiveFailures = Math.max(maxConsecutiveFailures, failures);
      unauthorizedSuccess ||= path === '/api/quotations' && sample.status >= 200 && sample.status < 300;
    }
    return { path, maxConsecutiveFailures, unauthorizedSuccess,
      alertTriggered: maxConsecutiveFailures >= 3 || unauthorizedSuccess };
  });
  return { endpoints, passed: endpoints.every(endpoint => !endpoint.alertTriggered),
    consecutiveFailureThreshold: 3, latencySloEnforced: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, output, region = 'unverified'] = process.argv.slice(2);
  try {
    if (!output) throw new Error('Report path required');
    const observations = await probeService(base, { maxP95Ms: 30000, region });
    const decision = evaluateAvailability(observations);
    const report = { ...decision, checkedAt: observations.checkedAt, origin: observations.origin,
      regionVerified: false, observations,
      note: 'Hourly diagnostic checks; GitHub scheduling and operator notification delivery are not guaranteed. Timing is evidence, not an approved regional SLO.' };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2));
    for (const endpoint of decision.endpoints) {
      console.log(`${endpoint.path}: ${endpoint.alertTriggered ? 'ALERT' : 'PASS'}, consecutive failures=${endpoint.maxConsecutiveFailures}, unauthorized success=${endpoint.unauthorizedSuccess}`);
    }
    process.exitCode = decision.passed ? 0 : 1;
  } catch {
    console.error('Uptime monitor could not verify availability; inspect configuration and connectivity.');
    process.exitCode = 1;
  }
}
