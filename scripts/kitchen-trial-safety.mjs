import assert from 'node:assert/strict';

/** API redirects must never forward a QA password or protection secret. */
export function candidateRequest(context, origin, method, path, options = {}) {
  const target = new URL(path, origin);
  assert.equal(target.origin, origin, 'QA requests must stay on the exact candidate origin');
  assert.ok(!target.username && !target.password, 'QA request URL contains credentials');
  return context.request.fetch(target.href, { ...options, method: method.toUpperCase(), maxRedirects: 0 });
}

/** Browser probes are read only and strip the secret at each redirect hop. */
export async function installCandidateBrowserBoundary(context, origin, bypass) {
  await context.route('**/*', async route => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method())) return route.abort('blockedbyclient');
    const headers = { ...request.headers() };
    delete headers['x-vercel-protection-bypass'];
    if (new URL(request.url()).origin === origin && bypass) headers['x-vercel-protection-bypass'] = bypass;
    if (new URL(request.url()).origin !== origin) return route.continue({ headers });
    // Header overrides can survive browser redirects without another route
    // callback. Fetch exactly once and reject redirect responses explicitly.
    const response = await route.fetch({ headers, maxRedirects: 0 });
    if (response.status() >= 300 && response.status() < 400) return route.abort('blockedbyclient');
    return route.fulfill({ response });
  });
}
