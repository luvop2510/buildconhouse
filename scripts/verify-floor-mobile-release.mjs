import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, webkit, devices, expect } from '@playwright/test';
import { captureRuntimeHealth } from '../e2e/runtime-health.ts';

// Real deployed reads only. Reports contain no customer records or credentials.
const [base, sourceSha, output] = process.argv.slice(2);
const origin = new URL(base).origin;
assert.ok(origin.startsWith('https://'));
assert.match(sourceSha || '', /^[a-f0-9]{40}$/);
assert.ok(process.env.FORGE_RELEASE_SESSION_FILE, 'A short-lived run-owned session is required');
const { token } = JSON.parse(await readFile(process.env.FORGE_RELEASE_SESSION_FILE, 'utf8'));
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const providerHeaders = bypass ? { 'x-vercel-protection-bypass': bypass } : {};
const floors = ['first-floor', 'ground-floor', 'second-floor', 'third-floor'];
const checks = [];
async function api(path, floor) {
  return fetch(origin + '/api' + path, { headers: { ...providerHeaders, Authorization: `Bearer ${token}`, 'X-Floor-Id': floor }, signal: AbortSignal.timeout(25000), redirect: 'error' });
}
for (const floor of floors) {
  const response = await api('/followups/page?page=1&page_size=100&view=pending', floor);
  assert.equal(response.status, 200, `${floor}: shared inbox unavailable`);
  const { items } = await response.json();
  assert.ok(Array.isArray(items));
  assert.ok(items.every(row => row.floor_id === floor), `${floor}: foreign inbox row`);
  if (items.length) for (const other of floors.filter(value => value !== floor)) {
    assert.equal((await api(`/followups/${encodeURIComponent(items[0].id)}`, other)).status, 404, `${other}: foreign follow-up detail accessible`);
    checks.push({ name: 'foreign follow-up detail denied', floor: other, passed: true });
  }
  assert.equal((await api('/purchases/items/page', floor)).status, floor === 'first-floor' ? 200 : 404, `${floor}: Purchases floor restriction failed`);
  checks.push({ name: 'floor-scoped inbox and Purchases access', floor, passed: true });
}
for (const [profile, engine, options] of [
  ['desktop-chrome', chromium, { viewport: { width: 1440, height: 1000 } }],
  ['iphone-safari', webkit, devices['iPhone 13']],
]) {
  const browser = await engine.launch();
  try {
    for (const floor of floors) {
      const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
      context.setDefaultTimeout(20000);
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === origin && url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.abort('blockedbyclient');
        return route.continue(url.origin === origin ? { headers: { ...request.headers(), ...providerHeaders } } : {});
      });
      await context.addCookies([
        { name: 'forge_session', value: token, domain: new URL(origin).hostname, path: '/api', httpOnly: true, secure: true, sameSite: 'Strict' },
        { name: 'forge_csrf', value: 'floor-mobile-readonly-probe', domain: new URL(origin).hostname, path: '/', secure: true, sameSite: 'Strict' },
      ]);
      await context.addInitScript(floor => {
        localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
        localStorage.setItem('forge.active-floor', JSON.stringify(floor));
      }, floor);
      const page = await context.newPage();
      const health = captureRuntimeHealth(page);
      await page.goto(origin + '/followups', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('tab', { name: /^Won orders(?: · \d+)?$/ })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Catalog', exact: true })).toHaveCount(['first-floor', 'ground-floor'].includes(floor) ? 1 : 0);
      if (profile === 'iphone-safari') await page.getByRole('button', { name: 'More', exact: true }).click();
      await expect(page.getByRole('link', { name: 'Purchases', exact: true })).toHaveCount(floor === 'first-floor' ? 1 : 0);
      await expect(page.getByRole('link', { name: /Kitchen lead|Furniture lead|Quotation Follow-up/ })).toHaveCount(0);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('forge.active-floor'))), floor);
      if (profile === 'iphone-safari') await page.getByRole('dialog', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
      await health.assertHealthy();
      checks.push({ name: 'supported navigation and Won orders', profile, floor, passed: true });
      // Click navigation so pending inbox reads finish within the same document.
      const paymentLink = page.getByRole('link', { name: 'Payments', exact: true });
      if (!await paymentLink.isVisible()) await page.getByRole('button', { name: 'More', exact: true }).click();
      await paymentLink.click();
      await expect(page.getByTestId('payments-page-details-toggle')).toHaveAttribute('aria-expanded', String(profile !== 'iphone-safari'));
      await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await health.assertHealthy();
      checks.push({ name: 'mobile payment overview and layout', profile, floor, passed: true });
      await context.close();
    }
  } finally { await browser.close(); }
}
if (output) await writeFile(output, JSON.stringify({ origin, sourceSha, checkedAt: new Date().toISOString(), readOnly: true, checks }, null, 2));
console.log(`Floor/mobile deployed acceptance: ${checks.length} read-only checks passed.`);
