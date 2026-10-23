import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium, webkit, devices, expect } from '@playwright/test';
import { captureRuntimeHealth } from '../e2e/runtime-health.ts';
import { assertPersistentCookies } from './verify-release-cookies.mjs';

// Use a short-lived, run-owned QA session. Never sign in as another person's
// browser, save credentials in reports, or mutate business records in a probe.
const [candidate, sha, output] = process.argv.slice(2);
const origin = new URL(candidate).origin;
assert.match(sha || '', /^[a-f0-9]{40}$/);
assert.ok(origin.startsWith('https://') && (new URL(origin).hostname.endsWith('.vercel.app') || origin === 'https://buildconhouse.in'));
assert.ok(process.env.FORGE_RELEASE_SESSION_FILE, 'A short-lived QA session is required for authenticated release acceptance');
const { token } = JSON.parse(await readFile(process.env.FORGE_RELEASE_SESSION_FILE, 'utf8'));
const expiry = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp;
assert.ok(expiry > Date.now() / 1000 + 600, 'QA session expires too soon to verify a release');
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const deploymentHeaders = bypass ? { 'x-vercel-protection-bypass': bypass } : {};
async function get(path) {
  const response = await fetch(origin + '/api' + path, {
    headers: { ...deploymentHeaders, Authorization: `Bearer ${token}`, 'X-Floor-Id': 'first-floor' },
    signal: AbortSignal.timeout(25000), redirect: 'error',
  });
  assert.equal(response.status, 200, 'Authenticated release data is unavailable');
  return response.json();
}
const imports = {};
for (const outcome of ['won', 'lost']) {
  const documents = await get(`/quotations?doc_type=standard&view=${outcome}`);
  assert.ok(Array.isArray(documents), 'Quotation list contract changed');
  // Bounded real-record acceptance supplements the full synthetic document
  // suite. Existing historical imports are checked before ordinary orders.
  imports[outcome] = documents.filter(doc => doc.customer_outcome === outcome).slice(0, 12);
}
const checks = [];
for (const [profile, engine, options] of [
  ['desktop-chrome', chromium, { viewport: { width: 1440, height: 1000 } }],
  ['tablet-chrome', chromium, { viewport: { width: 834, height: 1112 } }],
  ['ipad-safari', webkit, devices['iPad Pro 11']],
  ['iphone-safari', webkit, devices['iPhone 13']],
]) {
  const browser = await engine.launch();
  try {
    let context = await browser.newContext({ ...options, serviceWorkers: 'block' });
    const pendingApi = new Set();
    let lastApiActivity = Date.now();
    const observeApi = current => {
      current.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === origin && url.pathname.startsWith('/api/')) {
          pendingApi.add(request); lastApiActivity = Date.now();
        }
      });
      const finish = request => {
        if (pendingApi.delete(request)) lastApiActivity = Date.now();
      };
      current.on('requestfinished', finish);
      current.on('requestfailed', finish);
    };
    observeApi(context);
    // Hard navigation cancels document-owned background reads. Safari can
    // report that cancellation as a CORS console error. Finish the probe's
    // own reads first; retain the health guard and its existing deadlines.
    const settleApi = () => expect.poll(() => pendingApi.size === 0 && Date.now() - lastApiActivity >= 200,
      { timeout: 20000, message: 'Probe API reads must settle before navigation' }).toBe(true);
    context.setDefaultTimeout(20000);
    context.setDefaultNavigationTimeout(30000);
    const blockWrites = async current => current.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin && /^\/api(?:\/|$)/.test(url.pathname) && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.abort('blockedbyclient');
      // Never send a provider bypass secret to product-image/storage hosts.
      return route.continue(url.origin === origin ? { headers: { ...request.headers(), ...deploymentHeaders } } : {});
    });
    await blockWrites(context);
    await context.addCookies([
      { name: 'forge_session', value: token, domain: new URL(origin).hostname, path: '/api', httpOnly: true, secure: true, sameSite: 'Strict' },
      { name: 'forge_csrf', value: 'release-readonly-probe', domain: new URL(origin).hostname, path: '/', secure: true, sameSite: 'Strict' },
    ]);
    await context.addInitScript(() => {
      if (!localStorage.getItem('forge.jwt.kind')) localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
      if (!localStorage.getItem('forge.active-floor')) localStorage.setItem('forge.active-floor', JSON.stringify('first-floor'));
    });
    let page = await context.newPage(), health = captureRuntimeHealth(page);
    const healthy = async name => {
      await expect(page.getByTestId('login-submit')).toHaveCount(0);
      await settleApi();
      await health.assertHealthy();
      checks.push({ profile, name, passed: true });
      console.log(`${profile}: ${name} passed`);
    };
    const navigate = async label => {
      // Focus recovery restores the phone bar asynchronously; wait before
      // deciding whether the destination belongs in its More sheet.
      if (profile === 'iphone-safari') await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeVisible();
      const link = page.getByRole('link', { name: label, exact: true });
      if (!await link.isVisible()) await page.getByRole('button', { name: 'More', exact: true }).click();
      await link.click();
    };
    const identity = page.waitForResponse(response => response.url() === origin + '/api/auth/me' && response.status() === 200);
    await page.goto(origin + '/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId(profile === 'iphone-safari' ? 'bottom-nav-quotations' : 'nav-quotations')).toBeVisible({ timeout: 25000 });
    await navigate('Quotations');
    await expect(page.getByTestId('new-quotation-btn')).toBeVisible({ timeout: 25000 });
    await healthy('signed-in SPA quotation list');
    const issuedHeaders = await (await identity).headerValues('set-cookie');
    for (const outcome of ['won', 'lost']) {
      for (let index = 0; index < imports[outcome].length; index++) {
        const doc = imports[outcome][index];
        await page.getByTestId(`quotations-${outcome}-toggle`).click();
        await expect(page.getByText(`${outcome === 'won' ? 'Won' : 'Lost'} Customer · Quotations`, { exact: true })).toBeVisible();
        // The quotation ledger virtualizes long customer lists. Use its real
        // search control to select each bounded acceptance record, including
        // records outside the initial rendered window.
        await page.getByTestId('quotations-search').fill(doc.number);
        await page.getByTestId(`quotation-${doc.id}`).click();
        await expect(page.getByTestId('quotation-customer-outcome')).toContainText(`${outcome === 'won' ? 'Won' : 'Lost'} Customer recorded`, { timeout: 20000 });
        await healthy(`${outcome} imported customer ${index + 1} opens by click`);
        await page.getByTestId('edit-quotation').click();
        await expect(page.getByTestId('quotation-workspace')).toBeVisible({ timeout: 25000 });
        await expect(page.getByText(`Restored ${doc.number}`, { exact: true })).toBeVisible({ timeout: 20000 });
        const expand = page.getByTestId('expand-quotation-workspace');
        if (await expand.isVisible()) await expand.click();
        const tab = page.getByTestId('builder-tab-quotation');
        if (await tab.isVisible()) await tab.click();
        await expect(page.getByTestId('builder-customer-outcome')).toContainText(`${outcome === 'won' ? 'Won' : 'Lost'} Customer recorded`);
        await healthy(`${outcome} imported customer ${index + 1} restores its editor`);
        // A full document navigation also checks that direct links retain the
        // same cookie. List/detail/editor transitions above must remain clicks.
        await settleApi();
        await page.goto(origin + '/quotations', { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('new-quotation-btn')).toBeVisible({ timeout: 20000 });
      }
    }
    await page.getByTestId('new-quotation-btn').click();
    await expect(page.getByTestId('quotation-workspace')).toBeVisible({ timeout: 25000 });
    await healthy('new quotation opens by click');
    await settleApi();
    await page.goto(origin + '/quotations', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('new-quotation-btn')).toBeVisible({ timeout: 20000 });
    await navigate('Godown stock');
    const search = page.getByRole('textbox', { name: 'Search godown stock', exact: true });
    await expect(search).toBeVisible({ timeout: 25000 });
    const stock = await get('/godown-stock');
    const mounted = await page.locator('[data-testid^="godown-lot-"]').count();
    assert.ok(mounted <= 60, 'Stock initial rendering exceeded its bounded card budget');
    if (stock.lots.length) {
      const last = stock.lots.at(-1);
      await search.fill(last.sku);
      await expect(page.getByTestId(`godown-lot-${last.id}`)).toBeVisible();
      await search.fill('');
      // End editing before using phone navigation, which is hidden during focus.
      await search.blur();
    }
    await healthy('populated stock opens by click and searches beyond initial cards');
    await navigate('Follow-ups');
    await expect(page.getByRole('tab', { name: /^Won orders(?: · \d+)?$/ })).toBeVisible({ timeout: 20000 });
    await healthy('Won orders wording');
    const cookies = await context.cookies();
    assertPersistentCookies(cookies, expiry, issuedHeaders);
    const storageState = await context.storageState();
    await context.close();
    pendingApi.clear();
    lastApiActivity = Date.now();
    // No credential reseeding or init script in this new browser context.
    context = await browser.newContext({ ...options, storageState, serviceWorkers: 'block' });
    observeApi(context);
    context.setDefaultTimeout(20000);
    context.setDefaultNavigationTimeout(30000);
    await blockWrites(context);
    page = await context.newPage(); health = captureRuntimeHealth(page);
    await page.goto(origin + '/quotations', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('new-quotation-btn')).toBeVisible({ timeout: 25000 });
    await settleApi();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('new-quotation-btn')).toBeVisible({ timeout: 20000 });
    await healthy('persistent signed-in browser restart and refresh');
  } finally { await browser.close(); }
}
assert.ok(checks.length >= 10, 'Incomplete browser acceptance');
if (output) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ origin, sourceSha: sha, checkedAt: new Date().toISOString(), readOnly: true, importedDocuments: Object.values(imports).reduce((sum, docs) => sum + docs.length, 0), checks }, null, 2));
}
console.log(`Authenticated release verification passed: ${checks.length} browser checks; no business writes.`);
