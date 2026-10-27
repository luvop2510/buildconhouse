import assert from 'node:assert/strict';
import { probeService, percentile } from './check-service-health.mjs';
import { checkBackendContract } from './verify-backend-contract.mjs';

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

// Healthy HTTP responses do not establish source/deployment compatibility.
const expected = { version: 'test-version', minimumPasswordLength: 6 };
function schema(version = expected.version, minimum = 6) {
  return { info: { version }, components: { schemas: {
    ChangePasswordPayload: { properties: { new_password: { minLength: minimum } } },
    TeamCreatePayload: { properties: { password: { minLength: minimum } } },
    TeamPasswordResetPayload: { properties: { new_password: { minLength: minimum } } },
  } } };
}
const contract = (body, status = 200) => checkBackendContract('https://backend.example', {
  expected, request: async () => new Response(JSON.stringify(body), { status }),
});
assert.equal((await contract(schema())).passed, true);
assert.equal((await contract(schema('old-version'))).passed, false);
assert.equal((await contract(schema(expected.version, 12))).passed, false);
const missingReset = schema();
delete missingReset.components.schemas.TeamPasswordResetPayload;
assert.equal((await contract(missingReset)).passed, false);
assert.equal((await contract({})).passed, false);
assert.equal((await contract(schema(), 503)).passed, false);
const failedRead = await checkBackendContract('https://backend.example', {
  expected, request: async () => { throw new Error('private-provider-detail'); },
});
assert.equal(failedRead.passed, false);
assert.doesNotMatch(JSON.stringify(failedRead), /private-provider-detail/);
await assert.rejects(checkBackendContract('https://user:secret@backend.example', { expected }), /HTTPS origin/);
console.log('Deployment contract checks reject version/password drift, missing schemas, outages and sensitive provider errors');
