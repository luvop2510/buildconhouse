import assert from 'node:assert/strict';

export function assertPersistentCookies(cookies, expiry, issuedHeaders, now = Date.now() / 1000) {
  const session = cookies.find(cookie => cookie.name === 'forge_session');
  const csrf = cookies.find(cookie => cookie.name === 'forge_csrf');
  assert.ok(session?.httpOnly && session.secure && session.sameSite === 'Strict' && session.path === '/api', 'Session cookie security changed');
  assert.ok(csrf?.secure && !csrf.httpOnly && csrf.sameSite === 'Strict' && csrf.path === '/', 'CSRF cookie security changed');
  assert.ok(session.expires > now && session.expires <= expiry + 2 && csrf.expires > now && csrf.expires <= expiry + 2, 'Cookies must persist without extending the JWT');
  // Chrome computes each Max-Age timestamp separately (observed difference:
  // 63 microseconds). HTTP Expires has whole-second precision. Require exact
  // matching server attributes and matching browser expiry within one second.
  assert.ok(Math.abs(session.expires - csrf.expires) < 1, 'Paired browser cookies expire at different times');
  const attributes = name => issuedHeaders.find(header => header.startsWith(name + '='))?.match(/; Max-Age=(\d+); Expires=([^;]+)/)?.slice(1);
  const sessionExpiry = attributes('forge_session'), csrfExpiry = attributes('forge_csrf');
  assert.ok(sessionExpiry?.length === 2 && csrfExpiry?.length === 2, 'Server did not issue persistent paired cookies');
  assert.deepEqual(sessionExpiry, csrfExpiry, 'Server cookie lifetime attributes must match exactly');
}
