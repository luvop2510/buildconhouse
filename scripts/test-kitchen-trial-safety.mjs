import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request } from '@playwright/test';
import { candidateRequest, installCandidateBrowserBoundary } from './kitchen-trial-safety.mjs';

let externalHits = 0;
const external = createServer((_request, response) => { externalHits++; response.end('must not receive credentials'); });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const externalOrigin = await listen(external);
const received = [];
const candidate = createServer(async (req, res) => {
  let body = ''; for await (const part of req) body += part;
  received.push({ headers: req.headers, body });
  res.writeHead(307, { location: `${externalOrigin}/redirected` }); res.end();
});
const origin = await listen(candidate);
const context = { request: await request.newContext() };
try {
  const response = await candidateRequest(context, origin, 'post', '/api/auth/login', {
    headers: { 'x-vercel-protection-bypass': 'synthetic-protection-secret' }, data: { password: 'synthetic-qa-password' }, maxRedirects: 5,
  });
  assert.equal(response.status(), 307);
  assert.equal(externalHits, 0, '307 must not forward password or bypass header');
  assert.equal(received[0].headers['x-vercel-protection-bypass'], 'synthetic-protection-secret');
  assert.match(received[0].body, /synthetic-qa-password/);
  assert.throws(() => candidateRequest(context, origin, 'post', `${externalOrigin}/api/auth/login`), /exact candidate origin/);
  let handler;
  await installCandidateBrowserBoundary({ route: async (_pattern, fn) => { handler = fn; } }, origin, 'synthetic-protection-secret');
  for (const [url, method, expected] of [[origin + '/api/auth/me', 'GET', 'synthetic-protection-secret'], [externalOrigin + '/asset', 'GET', undefined], [externalOrigin + '/redirect', 'POST', 'abort'], [origin + '/api/kitchen-projects', 'POST', 'abort']]) {
    let result;
    await handler({ request: () => ({ url: () => url, method: () => method, headers: () => ({ 'x-vercel-protection-bypass': 'inherited-secret' }) }), continue: options => { result = options.headers['x-vercel-protection-bypass']; }, fetch: async options => { assert.equal(options.maxRedirects, 0); result = options.headers['x-vercel-protection-bypass']; return { status: () => 200 }; }, fulfill: () => {}, abort: () => { result = 'abort'; } });
    assert.equal(result, expected);
  }
  console.log('Hosted Kitchen safety: real307 cannot forward credentials/bypass; exact-origin API and read-only browser boundaries passed. No hosted access.');
} finally {
  await context.request.dispose();
  await Promise.all([new Promise(resolve => candidate.close(resolve)), new Promise(resolve => external.close(resolve))]);
}
