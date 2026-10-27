import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from 'playwright';

const verifierSource = await readFile(new URL('./verify-authenticated-release.mjs', import.meta.url), 'utf8');
const blockWritesMatch = verifierSource.match(/    const blockWrites = async current => \{[\s\S]*?\n    \};/);
assert.ok(blockWritesMatch, 'Extract the real blockWrites implementation from the hosted verifier');
const blockWritesSource = blockWritesMatch[0].trim().replace(/^const blockWrites/, 'const blockWrites');
assert.match(blockWritesSource, /route\.abort\('blockedbyclient'\)/, 'unsafe same-origin requests must be aborted by the existing body');
assert.match(blockWritesSource, /return bypass && url\.origin === origin\s*\? route\.continue\(\{ headers: \{ \.\.\.request\.headers\(\), \.\.\.deploymentHeaders \} \}\)\s*: route\.continue\(\);/,
  'native headers must pass through unchanged without bypass; bypass headers must remain same-origin only');

const API_PATHS = ['/api', '/api?x=1', '/api/foo'];
const startServer = (handler) => {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
};
const closeServer = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

const primaryRequests = [];
const foreignRequests = [];
const primary = await startServer((request, response) => {
  primaryRequests.push({ method: request.method, url: request.url, headers: request.headers });
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><html><head><script src="/static-app.js"></script></head><body><p>ready</p></body></html>');
  } else if (request.url === '/static-app.js') {
    response.writeHead(200, { 'content-type': 'application/javascript' });
    response.end('window.fixtureAssetLoaded=true;');
  } else if (request.url.startsWith('/api')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  } else {
    response.writeHead(404); response.end('missing');
  }
});
const foreign = await startServer((request, response) => {
  foreignRequests.push({ method: request.method, url: request.url, headers: request.headers });
  response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  response.end('foreign-safe');
});

async function registerActualBlockWrites(context, { bypassEnabled = false } = {}) {
  const patterns = [];
  const instrumentedContext = {
    route(pattern, handler) {
      patterns.push(pattern);
      return context.route(pattern, handler);
    },
  };
  const deploymentHeaders = bypassEnabled ? { 'x-vercel-protection-bypass': 'test-only-bypass-secret' } : {};
  const script = `(async () => { const origin = ${JSON.stringify(primary.origin)}; const bypass = ${JSON.stringify(bypassEnabled)}; const deploymentHeaders = ${JSON.stringify(deploymentHeaders)}; ${blockWritesSource}; await blockWrites(current); })()`;
  await vm.runInNewContext(script, { current: instrumentedContext, URL });
  return patterns;
}

const browser = await chromium.launch({ headless: true });
try {
  const normalContext = await browser.newContext();
  await normalContext.addCookies([{ name: 'native_probe_cookie', value: 'kept', url: `${primary.origin}/api`, sameSite: 'Lax' }]);
  const normalPatterns = await registerActualBlockWrites(normalContext);
  assert.deepEqual(normalPatterns, [`${primary.origin}/api`, `${primary.origin}/api?**`, `${primary.origin}/api/**`],
    'without provider bypass only the three literal same-origin API patterns should be routed');
  const normalPage = await normalContext.newPage();
  await normalPage.goto(primary.origin);
  await normalPage.waitForFunction(() => window.fixtureAssetLoaded === true);
  assert.equal(primaryRequests.filter(request => request.url === '/static-app.js').length, 1,
    'static asset downloads should pass without a broad route intercept');
  const normalResults = await normalPage.evaluate(async ({ paths, foreignUrl }) => {
    const blocked = await Promise.all(paths.map(async path => {
      try { await fetch(path, { method: 'POST', body: 'must-not-send' }); return false; }
      catch { return true; }
    }));
    const safe = await fetch('/api/foo', { headers: { 'x-native-probe': 'preserved' } }).then(response => response.json());
    const crossOrigin = await fetch(foreignUrl).then(response => response.text());
    return { blocked, safe, crossOrigin };
  }, { paths: API_PATHS, foreignUrl: `${foreign.origin}/external` });
  assert.deepEqual(normalResults.blocked, [true, true, true], 'POST /api, query-root POST and nested POST must be blocked');
  assert.deepEqual(normalResults.safe, { ok: true }, 'same-origin API GET must pass through');
  const nativeRead = primaryRequests.find(request => request.method === 'GET' && request.url === '/api/foo');
  assert.equal(nativeRead?.headers['x-native-probe'], 'preserved', 'native custom headers should pass through without reserialization');
  assert.match(nativeRead?.headers.cookie || '', /native_probe_cookie=kept/, 'native cookies should pass through without reserialization');
  assert.equal(nativeRead?.headers['x-vercel-protection-bypass'], undefined);
  assert.equal(normalResults.crossOrigin, 'foreign-safe', 'unrelated cross-origin reads must remain available');
  assert.equal(primaryRequests.filter(request => request.method === 'POST').length, 0, 'blocked writes must never reach the API server');
  assert.equal(primaryRequests.find(request => request.method === 'GET' && request.url === '/api/foo')?.headers['x-vercel-protection-bypass'], undefined);
  assert.equal(foreignRequests.at(-1)?.headers['x-vercel-protection-bypass'], undefined, 'bypass secrets must not leak to a foreign origin');
  await normalContext.close();

  primaryRequests.length = 0;
  foreignRequests.length = 0;
  const bypassContext = await browser.newContext();
  const bypassPatterns = await registerActualBlockWrites(bypassContext, { bypassEnabled: true });
  assert.deepEqual(bypassPatterns, ['**/*'], 'provider bypass must retain the existing broad handler');
  const bypassPage = await bypassContext.newPage();
  await bypassPage.goto(primary.origin);
  await bypassPage.waitForFunction(() => window.fixtureAssetLoaded === true);
  await bypassPage.evaluate(async url => fetch(url).then(response => response.text()), `${foreign.origin}/external`);
  assert.equal(primaryRequests.find(request => request.url === '/')?.headers['x-vercel-protection-bypass'], 'test-only-bypass-secret');
  assert.equal(primaryRequests.find(request => request.url === '/static-app.js')?.headers['x-vercel-protection-bypass'], 'test-only-bypass-secret');
  assert.equal(foreignRequests.at(-1)?.headers['x-vercel-protection-bypass'], undefined, 'broad provider bypass routing remains origin-scoped');
  await bypassContext.close();
  console.log('Authenticated release network routing: API write guards, static downloads, safe reads and bypass origin isolation passed.');
} finally {
  await browser.close();
  await Promise.all([closeServer(primary.server), closeServer(foreign.server)]);
}
