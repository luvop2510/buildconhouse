import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url)));
function headersFor(path) {
  const headers = {};
  for (const rule of config.routes) {
    if (rule.handle === 'filesystem') break;
    if (rule.src && new RegExp(`^(?:${rule.src})$`).test(path)) Object.assign(headers, rule.headers);
  }
  return headers;
}
for (const path of ['/', '/login', '/login/', '/login.html', '/index.html']) {
  const headers = headersFor(path);
  assert.equal(headers['Cache-Control'], 'no-store', 'Browser always rechecks the current release');
  assert.equal(headers['Vercel-CDN-Cache-Control'], 'public, max-age=60');
}
for (const path of ['/api', '/api/auth/me', '/api/payments', '/api/login', '/api/login.html', '/api/downloads/file', '/login.json', '/login/secret', '/release-recovery.js', '/expo-hydrate.js', '/runtime-health.js']) {
  const headers = headersFor(path);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(headers['Vercel-CDN-Cache-Control'], undefined, `${path} cannot inherit public HTML caching`);
}
assert.equal(headersFor('/_expo/static/js/entry-abc.js')['Cache-Control'], 'public, max-age=31536000, immutable');
for (const path of ['login.html', 'index.html']) {
  const html = readFileSync(new URL(`../dist/client/${path}`, import.meta.url), 'utf8');
  assert.match(html, /<html[^>]+lang="en"/);
  assert.match(html, /Preparing the sign-in screen/);
  assert.doesNotMatch(html, /(?:access_token|refresh_token|"customer_name"|"grand_total"|"floor_ids")/);
}
console.log('Public static shells use a 60-second edge cache; APIs and recovery scripts retain no-store.');
