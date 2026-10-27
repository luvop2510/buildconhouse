import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium, webkit, devices, expect } from '@playwright/test';
import { captureRuntimeHealth } from '../e2e/runtime-health.ts';
import { assertPersistentCookies } from './verify-release-cookies.mjs';

// Bounded real deployed acceptance, using a run-owned temporary QA session.
// No business writes, fixture responses, saved-document edits, screenshots,
// traces, customer values/ids or credentials are stored in evidence or logs.
const [candidate, sourceSha, requestedOutput] = process.argv.slice(2);
const checks = [];
let origin, output, activeProfile = 'preflight', activeCheck = 'validate verifier inputs';
let completed = false;
try {
  const target = new URL(candidate);
  assert.ok(target.protocol === 'https:' && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash);
  assert.ok(target.hostname.endsWith('.vercel.app') || target.origin === 'https://buildconhouse.in');
  assert.match(sourceSha || '', /^[a-f0-9]{40}$/);
  origin = target.origin;
  output = requestedOutput || `output/release/quotation-${sourceSha.slice(0, 12)}-${target.hostname}.json`;
  assert.ok(process.env.FORGE_RELEASE_SESSION_FILE, 'A run-owned release session is required');
  const { token } = JSON.parse(await readFile(process.env.FORGE_RELEASE_SESSION_FILE, 'utf8'));
  assert.ok(typeof token === 'string' && token.split('.').length === 3);
  const expiry = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp;
  assert.ok(Number.isFinite(expiry) && expiry > Date.now() / 1000 + 600, 'Release session expires too soon');
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const providerHeaders = bypass ? { 'x-vercel-protection-bypass': bypass } : {};
  const get = async (path, floor) => {
    const response = await fetch(origin + '/api' + path, {
      headers: { ...providerHeaders, Authorization: `Bearer ${token}`, 'X-Floor-Id': floor },
      signal: AbortSignal.timeout(25000), redirect: 'error',
    });
    assert.ok(response.status === 200, 'Required read-only release data is unavailable');
    return response.json();
  };
  activeCheck = 'find real pending quotations in both floors';
  const [standardRows, tileRows] = await Promise.all([
    get('/quotations?doc_type=standard&view=pending', 'first-floor'),
    get('/quotations?doc_type=tiles_quotation&view=pending', 'ground-floor'),
  ]);
  assert.ok(Array.isArray(standardRows) && Array.isArray(tileRows));
  const standardRow = standardRows.find(row => row.doc_type === 'standard' && row.floor_id === 'first-floor' && row.customer_id && !row.customer_outcome);
  const tileRow = tileRows.find(row => row.doc_type === 'tiles_quotation' && row.floor_id === 'ground-floor' && row.customer_id && !row.customer_outcome);
  assert.ok(standardRow && tileRow, 'Both floors need an existing pending quotation for this bounded check');
  const [standard, tile, standardCustomer] = await Promise.all([
    get(`/quotations/${encodeURIComponent(standardRow.id)}?with_completion=true`, 'first-floor'),
    get(`/quotations/${encodeURIComponent(tileRow.id)}?with_completion=true`, 'ground-floor'),
    get(`/customers/${encodeURIComponent(standardRow.customer_id)}`, 'first-floor'),
  ]);
  assert.ok(standard.floor_id === 'first-floor' && tile.floor_id === 'ground-floor');
  const expectedStandardCustomer = standardCustomer.company || standardCustomer.name;
  assert.ok(typeof expectedStandardCustomer === 'string' && expectedStandardCustomer.length > 0);
  assert.ok(typeof tile.customer_name === 'string' && tile.customer_name.length > 0);

  for (const [profile, engine, options] of [
    ['desktop-chrome', chromium, { viewport: { width: 1440, height: 1000 } }],
    ['iphone-safari', webkit, devices['iPhone 13']],
  ]) {
    activeProfile = profile;
    activeCheck = 'initialize isolated read-only browser';
    const browser = await engine.launch();
    try {
      let context = await browser.newContext({ ...options, serviceWorkers: 'block' });
      let page, health, pendingApi = new Set(), lastApiActivity = Date.now();
      let businessWriteAttempts = 0, failedApiReads = 0;
      const install = async current => {
        pendingApi = new Set(); lastApiActivity = Date.now();
        current.setDefaultTimeout(20000);
        current.setDefaultNavigationTimeout(30000);
        current.on('request', request => {
          const url = new URL(request.url());
          if (url.origin === origin && /^\/api(?:\/|$)/.test(url.pathname)) {
            pendingApi.add(request); lastApiActivity = Date.now();
          }
        });
        const finish = request => { if (pendingApi.delete(request)) lastApiActivity = Date.now(); };
        current.on('requestfinished', finish);
        current.on('requestfailed', finish);
        current.on('response', response => {
          const url = new URL(response.url());
          if (url.origin === origin && /^\/api(?:\/|$)/.test(url.pathname) && response.status() >= 400) failedApiReads += 1;
        });
        await current.route('**/*', route => {
          const request = route.request(), url = new URL(request.url());
          // Block unsafe methods on every host, including accidental form or
          // external integration writes. Never retry an intercepted mutation.
          if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
            if (url.origin === origin && /^\/api(?:\/|$)/.test(url.pathname)) businessWriteAttempts += 1;
            return route.abort('blockedbyclient');
          }
          const headers = { ...request.headers() };
          delete headers['x-vercel-protection-bypass'];
          if (url.origin === origin) Object.assign(headers, providerHeaders);
          return route.continue({ headers });
        });
      };
      await install(context);
      await context.addCookies([
        { name: 'forge_session', value: token, domain: target.hostname, path: '/api', httpOnly: true, secure: true, sameSite: 'Strict' },
        { name: 'forge_csrf', value: 'quotation-readonly-release-probe', domain: target.hostname, path: '/', secure: true, sameSite: 'Strict' },
      ]);
      // Seed once; direct-link checks deliberately change only the saved floor.
      await context.addInitScript(() => {
        if (!localStorage.getItem('forge.jwt.kind')) localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
        if (!localStorage.getItem('forge.active-floor')) localStorage.setItem('forge.active-floor', JSON.stringify('first-floor'));
      });
      page = await context.newPage(); health = captureRuntimeHealth(page);
      const settle = () => expect.poll(() => pendingApi.size === 0 && Date.now() - lastApiActivity >= 200,
        { timeout: 20000, message: 'Read-only probe requests must finish before navigation' }).toBe(true);
      const boundedLayout = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Quotation workspace exceeds the viewport');
      const healthy = async name => {
        activeCheck = name;
        await settle();
        await expect(page.getByTestId('login-submit')).toHaveCount(0);
        await health.assertHealthy();
        assert.ok(businessWriteAttempts === 0, 'The read-only journey attempted a business write');
        assert.ok(failedApiReads === 0, 'A required browser API read failed');
        await boundedLayout();
        checks.push({ profile, name, passed: true });
        console.log(`${profile}: ${name} passed`);
      };
      const goto = async (path, savedFloor) => {
        await settle();
        if (savedFloor) await page.evaluate(floor => localStorage.setItem('forge.active-floor', JSON.stringify(floor)), savedFloor);
        await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
      };
      const assertFloor = async floor => {
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('forge.active-floor') || 'null'))).toBe(floor);
      };
      const productCards = () => page.locator('[data-testid^="product-card-"]').filter({ visible: true });
      const customerDetails = async () => {
        const exit = page.getByTestId('expand-quotation-workspace');
        if (await exit.isVisible()) await exit.click();
        const details = page.getByTestId('quotation-details-toggle');
        await expect(details).toBeVisible();
        if (await details.getAttribute('aria-expanded') !== 'true') await details.click();
        return page.getByTestId('compact-hdr-customer');
      };

      activeCheck = 'persistent authenticated session';
      const identity = page.waitForResponse(response => response.url() === origin + '/api/auth/me' && response.status() === 200);
      void identity.catch(() => {}); // Navigation failure must not emit an unhandled browser error.
      await goto('/quotations');
      await expect(page.getByTestId('new-quotation-btn')).toBeVisible();
      const issuedHeaders = await (await identity).headerValues('set-cookie');
      await assertFloor('first-floor');
      assertPersistentCookies(await context.cookies(), expiry, issuedHeaders);
      await healthy('persistent authenticated session');

      activeCheck = 'new Sanitary workspace has real catalog products';
      await page.getByTestId('new-quotation-btn').click();
      await expect(page.getByTestId('quotation-workspace')).toBeVisible();
      await expect(productCards().first()).toBeVisible();
      await healthy('new Sanitary workspace has real catalog products');

      activeCheck = 'Sanitary read-only search clearing and room controls';
      const search = page.getByTestId('explorer-search').filter({ visible: true });
      await search.fill('__forge_release_readonly_no_product_7f91c2__');
      await expect(page.getByText('No products match', { exact: true }).filter({ visible: true })).toBeVisible();
      await expect(productCards()).toHaveCount(0);
      await page.getByTestId('explorer-search-clear').filter({ visible: true }).click();
      await search.blur();
      await expect(productCards().first()).toBeVisible();
      if (profile === 'iphone-safari') {
        const rooms = page.getByTestId('browse-room-toggle');
        await expect(rooms).toBeVisible();
        await rooms.click();
        await expect(page.getByTestId('add-room-btn').filter({ visible: true })).toBeVisible();
        await expect(page.locator('[data-testid^="room-"]').filter({ visible: true }).first()).toBeVisible();
        await rooms.click();
      } else await expect(page.getByTestId('add-room-btn').filter({ visible: true })).toBeVisible();
      await healthy('Sanitary read-only search clearing and room controls');

      activeCheck = 'saved Sanitary editor restores its expected customer';
      await goto(`/quotations/new?quotationId=${encodeURIComponent(standard.id)}`);
      await expect(page.getByTestId('quotation-workspace')).toBeVisible();
      const customer = await customerDetails();
      // Compare only a boolean, so assertion failures cannot print the value.
      await expect.poll(async () => (await customer.innerText()).includes(expectedStandardCustomer), { message: 'Saved Sanitary customer did not restore' }).toBe(true);
      await assertFloor('first-floor');
      await healthy('saved Sanitary editor restores its expected customer');

      activeCheck = 'Ground list synchronizes a Sanitary saved floor';
      await goto('/tiles', 'first-floor');
      await expect(page.getByTestId(`tiles-doc-${tile.id}`)).toBeVisible();
      await assertFloor('ground-floor');
      await healthy('Ground list synchronizes a Sanitary saved floor');

      activeCheck = 'saved Ground editor synchronizes floor and restores customer';
      await goto(`/tiles/quotation?id=${encodeURIComponent(tile.id)}`, 'first-floor');
      const tileCustomer = page.locator('[data-testid="tiles-customer-name"], [data-testid="mobile-customer-name"]').filter({ visible: true });
      await expect(tileCustomer).toBeVisible();
      await expect.poll(async () => await tileCustomer.inputValue() === tile.customer_name, { message: 'Saved Ground customer did not restore' }).toBe(true);
      await assertFloor('ground-floor');
      await expect(page.getByTestId('tiles-restore-retry')).toHaveCount(0);
      await healthy('saved Ground editor synchronizes floor and restores customer');

      activeCheck = 'new Ground editor opens a populated read-only tile picker';
      await goto('/tiles/quotation');
      const emptyCustomer = page.locator('[data-testid="tiles-customer-name"], [data-testid="mobile-customer-name"]').filter({ visible: true });
      await expect(emptyCustomer).toBeVisible();
      assert.ok(await emptyCustomer.inputValue() === '', 'New Ground quotation retained a saved customer');
      const pick = profile === 'iphone-safari' ? page.getByTestId('mobile-select-product-0') : page.getByTestId('tiles-product-0');
      await pick.click();
      await expect(page.getByRole('dialog', { name: 'Add tiles', exact: true })).toBeVisible();
      await expect(page.locator('[data-testid^="tiles-picker-card-"]').filter({ visible: true }).first()).toBeVisible();
      await settle();
      await page.getByTestId('tiles-picker-close').click();
      await assertFloor('ground-floor');
      await healthy('new Ground editor opens a populated read-only tile picker');

      activeCheck = 'quotation access survives browser context restoration and reload';
      await settle();
      assertPersistentCookies(await context.cookies(), expiry, issuedHeaders);
      const storageState = await context.storageState();
      await context.close();
      context = await browser.newContext({ ...options, storageState, serviceWorkers: 'block' });
      await install(context);
      page = await context.newPage(); health = captureRuntimeHealth(page);
      await goto('/tiles');
      await expect(page.getByTestId(`tiles-doc-${tile.id}`)).toBeVisible();
      await settle();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId(`tiles-doc-${tile.id}`)).toBeVisible();
      await assertFloor('ground-floor');
      assertPersistentCookies(await context.cookies(), expiry, issuedHeaders);
      await healthy('quotation access survives browser context restoration and reload');
      await settle();
      await context.close();
    } finally { await browser.close(); }
  }
  assert.ok(checks.length === 16, 'Incomplete bounded quotation release acceptance');
  completed = true;
} catch {
  // Playwright errors can contain private DOM text/URLs. Do not emit the
  // original error or stack: identify only the fixed, public check name.
  console.error(`Quotation release verification failed: ${activeProfile}: ${activeCheck}`);
  process.exitCode = 1;
} finally {
  if (output) {
    try {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify({ origin, sourceSha, checkedAt: new Date().toISOString(), readOnly: true, completed, checks,
        ...(completed ? {} : { failure: { profile: activeProfile, name: activeCheck } }),
      }, null, 2));
    } catch {
      console.error('Quotation release verification could not save its sanitized report');
      process.exitCode = 1;
    }
  }
}
if (completed) console.log(`Quotation release verification passed: ${checks.length} bounded read-only checks; no business writes.`);
