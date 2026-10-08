import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Read-only deployment verification: no credentials and no business writes.
const [baseArg, output] = process.argv.slice(2);
assert(baseArg, 'Usage: node scripts/verify-production-release.mjs https://app.example [report.json]');
const base = new URL(baseArg);
assert.equal(base.protocol, 'https:');
const evidence = [];
const scripts = new Set();
async function read(path) {
  const url = new URL(path, base);
  assert.equal(url.origin, base.origin);
  const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
  const body = await response.text();
  evidence.push({ path: url.pathname, status: response.status, contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'), serverTiming: response.headers.get('server-timing') });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${path}: missing nosniff`);
  return { response, body };
}
for (const path of ['/login', '/privacy', '/terms', '/notebook/kitchen/quotation-follow-up', '/quotations/q-release-probe']) {
  const { response, body } = await read(path);
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors/);
  assert.match(response.headers.get('content-security-policy') || '', /script-src 'self'/);
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('cache-control'), 'no-store', `${path}: stale HTML must not be cached`);
  for (const match of body.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) scripts.add(match[1]);
}
assert(scripts.size > 0, 'No production script references found');
for (const path of scripts) {
  const { response, body } = await read(path);
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get('content-type') || '', /javascript/);
  if (new URL(path, base).pathname === '/release-recovery.js') {
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } else {
    assert.match(response.headers.get('cache-control') || '', /immutable/);
  }
  assert.doesNotMatch(body.slice(0, 100), /<!doctype|<html/i, `${path}: asset fell through to HTML`);
}
for (const path of ['/_expo/static/js/web/missing-release-probe.js', '/assets/missing-release-probe.ttf']) {
  const { response } = await read(path);
  assert.equal(response.status, 404, `${path}: missing assets must not become successful HTML`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
}
for (const path of ['/assets/security-probe.js.map', '/assets/security-probe.js.MAP']) {
  const { response } = await read(path);
  assert.equal(response.status,404,`${path}: source maps must not be published`);
}
for (const path of ['/api/health', '/api/health/ready', '/api/quotations']) {
  const { response, body } = await read(path);
  assert.equal(response.status, path === '/api/quotations' ? 401 : 200, path);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert(response.headers.get('server-timing'), `${path}: missing upstream timing`);
  if (response.status === 200) assert.equal(JSON.parse(body).status, 'ok');
}
if (output) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ base: base.origin, checkedAt: new Date().toISOString(), evidence }, null, 2));
}
console.log(`Read-only release verification passed: ${evidence.length} routes/assets, security/cache headers, missing-asset handling and API health/auth.`);
