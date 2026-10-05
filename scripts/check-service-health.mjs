import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
}

export async function probeService(base, { samples = 10, maxP95Ms = 3000, region = 'unverified', request = fetch } = {}) {
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use an HTTPS origin without credentials, query or path');
  }
  if (!Number.isInteger(samples) || samples < 2 || samples > 100 || !Number.isFinite(maxP95Ms) || maxP95Ms <= 0) {
    throw new Error('Invalid sample count or latency threshold');
  }
  const probes = [];
  for (const [path, expected] of [['/api/health', 200], ['/api/health/ready', 200], ['/api/quotations', 401]]) {
    const timings = [];
    for (let index = 0; index < samples; index++) {
      const started = performance.now();
      try {
        const response = await request(new URL(path, url), { redirect: 'error', signal: AbortSignal.timeout(10000) });
        const body = await response.text();
        const elapsed = Math.round(performance.now() - started);
        const appMs = Number(/app;dur=([\d.]+)/.exec(response.headers.get('server-timing') || '')?.[1]);
        let valid = response.status === expected;
        if (expected === 200) {
          try { valid &&= JSON.parse(body).status === 'ok'; } catch { valid = false; }
        }
        timings.push({ elapsedMs: elapsed, status: response.status, valid, appMs: Number.isFinite(appMs) ? appMs : null });
      } catch {
        timings.push({ elapsedMs: Math.round(performance.now() - started), status: null, valid: false, appMs: null });
      }
    }
    const warm = timings.slice(1).map(sample => sample.elapsedMs);
    const p95Ms = percentile(warm, 0.95);
    probes.push({ path, expectedStatus: expected, firstSample: timings[0], samples: timings,
      warmP50Ms: percentile(warm, 0.5), warmP95Ms: p95Ms,
      passed: timings.every(sample => sample.valid) && p95Ms <= maxP95Ms });
  }
  return { origin: url.origin, checkedAt: new Date().toISOString(), probeRegion: region,
    regionVerified: false, thresholdMs: maxP95Ms,
    note: 'Runner label is operator supplied; first sample excluded from warm percentiles. This is a health probe, not a load test.',
    passed: probes.every(probe => probe.passed), probes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, output, region = 'unverified', threshold = '3000'] = process.argv.slice(2);
  try {
    const report = await probeService(base, { region, maxP95Ms: Number(threshold) });
    if (output) {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify(report, null, 2));
    }
    for (const probe of report.probes) console.log(`${probe.path}: ${probe.passed ? 'PASS' : 'FAIL'}, warm p50=${probe.warmP50Ms}ms p95=${probe.warmP95Ms}ms`);
    process.exitCode = report.passed ? 0 : 1;
  } catch {
    console.error('Health probe failed; check origin, configuration and connectivity.');
    process.exitCode = 1;
  }
}
