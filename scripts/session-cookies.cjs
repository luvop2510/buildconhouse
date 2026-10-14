// Only a trusted successful upstream login or identity check may issue these.
// Persistence survives mobile browser restarts without extending JWT validity.
function sessionCookies(token, csrf, now = Date.now()) {
  let lifetime = '';
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
      const seconds = Math.max(0, Math.min(30 * 24 * 60 * 60, Math.floor(payload.exp - now / 1000)));
      lifetime = `; Max-Age=${seconds}; Expires=${new Date(now + seconds * 1000).toUTCString()}`;
    }
  } catch { /* Legacy opaque responses remain browser-session-only. */ }
  const csrfValue = csrf || crypto.randomUUID() + crypto.randomUUID();
  return [
    `forge_session=${encodeURIComponent(token)}; Path=/api${lifetime}; Secure; HttpOnly; SameSite=Strict`,
    `forge_csrf=${csrfValue}; Path=/${lifetime}; Secure; SameSite=Strict`,
  ];
}

module.exports = { sessionCookies };
