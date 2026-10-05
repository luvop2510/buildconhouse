import assert from 'node:assert/strict';
import { probeService, percentile } from './check-service-health.mjs';

assert.equal(percentile([20, 1, 5], 0.5), 5);
let calls = 0;
const request = async (url) => {
  calls++;
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: url.pathname === '/api/quotations' ? 401 : 200,
    headers: { 'server-timing': 'app;dur=12.5' },
  });
};
const good = await probeService('https://app.example', { samples: 3, request });
assert.equal(calls, 9);
assert.equal(good.passed, true);
assert.equal(good.probes[0].firstSample.appMs, 12.5);
assert.equal(good.regionVerified, false);
assert.equal((await probeService('https://app.example', { samples: 2, request: async () => new Response('unready', { status: 200 }) })).passed, false);
assert.equal((await probeService('https://app.example', { samples: 2, request: async () => { throw new Error('secret'); } })).passed, false);
await assert.rejects(probeService('https://user:secret@app.example'), /HTTPS origin/);
await assert.rejects(probeService('https://app.example', { samples: 0 }), /Invalid/);
console.log('Service health probes: success, false readiness, access boundary, timeouts and origin validation passed');
