import assert from 'node:assert/strict';
import { promoteVerified } from './promote-verified-vercel.mjs';
import { assertPersistentCookies } from './verify-release-cookies.mjs';
const sha = 'a'.repeat(40);
const base = { id: 'dpl_fixture', projectId: 'prj_RuZWSvov1AkP2UDmWaea6925wWlU', readyState: 'READY', meta: { releaseSha: sha } };
function exercise({ metadata = base, fail = -1, candidate = 'https://candidate.vercel.app' } = {}) {
  const calls = [];
  let error;
  try {
    promoteVerified({ candidate, sha, cli: 'fixture-vercel', run(command, args) {
      const stage = calls.length; calls.push({ command, args });
      return { status: stage === fail ? 1 : 0, stdout: stage === 0 ? JSON.stringify(metadata) : '' };
    } });
  } catch (failure) { error = failure; }
  return { calls, error };
}
const good = exercise();
assert.equal(good.error, undefined);
assert.equal(good.calls.length, 4);
assert.equal(good.calls[0].args[0], 'api');
assert.ok(good.calls[1].args[0].endsWith('verify-production-release.mjs'));
assert.ok(good.calls[2].args[0].endsWith('verify-authenticated-release.mjs'));
assert.equal(good.calls[2].args[2], sha);
assert.deepEqual(good.calls[3].args.slice(0, 2), ['promote', 'dpl_fixture']);
for (const [fail, expected] of [[0, 1], [1, 2], [2, 3], [3, 4]]) {
  const result = exercise({ fail }); assert.ok(result.error); assert.equal(result.calls.length, expected);
}
for (const metadata of [{ ...base, readyState: 'ERROR' }, { ...base, projectId: 'other-project' }, { ...base, meta: { releaseSha: 'b'.repeat(40) } }]) {
  const result = exercise({ metadata }); assert.ok(result.error); assert.equal(result.calls.length, 1);
}
for (const candidate of ['http://candidate.vercel.app', 'https://evil.test', 'https://user:password@candidate.vercel.app', 'https://candidate.vercel.app/other']) {
  const result = exercise({ candidate }); assert.ok(result.error); assert.equal(result.calls.length, 0);
}
console.log('Production promotion requires the reviewed READY candidate, real API/assets and authenticated browser/session acceptance; every failure stops before promotion.');

const cookieFixture = [
  { name: 'forge_session', expires: 2000.358264, path: '/api', httpOnly: true, secure: true, sameSite: 'Strict' },
  { name: 'forge_csrf', expires: 2000.358327, path: '/', httpOnly: false, secure: true, sameSite: 'Strict' },
];
const issued = ['forge_session=fixture; Path=/api; Max-Age=1000; Expires=Thu, 01 Jan 1970 00:33:20 GMT; Secure; HttpOnly; SameSite=Strict', 'forge_csrf=fixture; Path=/; Max-Age=1000; Expires=Thu, 01 Jan 1970 00:33:20 GMT; Secure; SameSite=Strict'];
assertPersistentCookies(cookieFixture, 2001, issued, 1000);
for (const patch of [{ expires: -1 }, { expires: 2010 }, { expires: 1990 }, { secure: false }, { httpOnly: true }, { sameSite: 'Lax' }]) {
  assert.throws(() => assertPersistentCookies([cookieFixture[0], { ...cookieFixture[1], ...patch }], 2001, issued, 1000));
}
assert.throws(() => assertPersistentCookies(cookieFixture, 2001, [issued[0], issued[1].replace('Max-Age=1000', 'Max-Age=1001')], 1000));
assert.throws(() => assertPersistentCookies(cookieFixture, 2001, [], 1000));
console.log('Persistent-cookie acceptance tolerates browser timestamp precision while rejecting mismatched server expiry, session-only cookies, insecure flags and JWT lifetime extension.');
