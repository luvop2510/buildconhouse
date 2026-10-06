import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { probeService } from './check-service-health.mjs';
import { evaluateAvailability } from './check-uptime-monitor.mjs';

function report(health = [true, true, true, true, true, true]) {
  return { passed: false, probes: [['/api/health', 200], ['/api/health/ready', 200], ['/api/quotations', 401]].map(([path, expectedStatus]) => ({
    path, expectedStatus, warmP95Ms: 9000,
    samples: (path === '/api/health/ready' ? health : [true, true, true, true, true, true]).map(valid => ({ valid, status: valid ? expectedStatus : 503 })),
  })) };
}
assert.equal(evaluateAvailability(report()).passed, true, 'An unapproved latency threshold must not create an availability alert');
assert.equal(evaluateAvailability(report([false, true, true, true, true, true])).passed, true);
assert.equal(evaluateAvailability(report([false, false, true, false, false, true])).passed, true, 'Recovery must reset consecutive failures');
assert.equal(evaluateAvailability(report([true, false, false, false, true, true])).passed, false);
const unreadyPayload = report([false, false, false, true, true, true]);
unreadyPayload.probes[1].samples.slice(0, 3).forEach(sample => { sample.status = 200; });
assert.equal(evaluateAvailability(unreadyPayload).passed, false, 'HTTP 200 with false readiness must alert');
const leakedAccess = report();
leakedAccess.probes[2].samples[0] = { valid: false, status: 200 };
assert.equal(evaluateAvailability(leakedAccess).passed, false, 'Unauthenticated success must alert immediately');
assert.equal(evaluateAvailability(leakedAccess).endpoints[2].unauthorizedSuccess, true);
for (const broken of [null, { probes: [] }, report()]) {
  if (broken?.probes.length) broken.probes[0].samples[0] = { valid: true, status: 500 };
  assert.throws(() => evaluateAvailability(broken));
}
const privateMarker = 'TEST_PRIVATE_CUSTOMER_NOT_REAL';
const observations = await probeService('https://app.example', { samples: 3, request: async url =>
  new Response(JSON.stringify({ status: 'ok', customer: privateMarker }), { status: url.pathname === '/api/quotations' ? 401 : 200 }) });
assert.equal(JSON.stringify(observations).includes(privateMarker), false, 'Response bodies must never enter monitoring evidence');
const rejected = spawnSync(process.execPath, ['scripts/check-uptime-monitor.mjs', `https://${privateMarker}:password@app.example`, '/unused-report.json'], { encoding: 'utf8' });
assert.equal(rejected.status, 1);
assert.equal((rejected.stdout + rejected.stderr).includes(privateMarker), false, 'CLI failures must not echo credentials');
console.log('Uptime policy: recovery, repeated failures, false readiness, unauthenticated success and fail-closed reports passed');
