import { expect, test } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';

const owner = {
  id: 'startup-owner', email: 'owner@example.test', full_name: 'Startup Owner', role: 'owner', active: true,
  floor_ids: floors.map(floor => floor.id),
};

test('critical backend wake retains destination and waits before authenticated reads', async ({ page }) => {
    const health = captureRuntimeHealth(page);
    await mockSession(page, '/customers', false, { seedStorageOnce: true });

    const apiRequests: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) apiRequests.push(url.pathname);
    });

    let healthProbes = 0;
    let backendReady = false;
    let requestsBeforeReady: string[] = [];
    let authCalls = 0;
    let authBeforeReady = false;
    let releaseAuth!: () => void;
    const authHold = new Promise<void>(resolve => { releaseAuth = resolve; });
    await page.route('**/api/health/ready', route => {
      healthProbes += 1;
      if (healthProbes === 1) return route.fulfill({ status: 503, json: { status: 'starting' } });
      requestsBeforeReady = [...apiRequests];
      backendReady = true;
      return route.fulfill({ json: { status: 'ok' } });
    });
    await page.route('**/api/auth/me', async route => {
      authCalls += 1;
      if (!backendReady) authBeforeReady = true;
      await authHold;
      return route.fulfill({ json: owner });
    });

    try {
      await page.goto('/customers', { waitUntil: 'commit' });
      await expect(page.getByTestId('backend-server-status')).toContainText('Starting backend server');
      await expect.poll(() => healthProbes).toBeGreaterThanOrEqual(2);
      await expect(page.getByTestId('backend-server-status')).toContainText('Backend server is awake');

      expect(authCalls).toBe(1);
      expect(authBeforeReady).toBe(false);
      const authIndex = apiRequests.indexOf('/api/auth/me');
      expect(authIndex).toBeGreaterThan(0);
      expect(requestsBeforeReady.length).toBeGreaterThan(0);
      expect(requestsBeforeReady.every(path => path === '/api/health/ready')).toBe(true);
      expect(apiRequests.filter(path => path !== '/api/health/ready')).toEqual(['/api/auth/me']);
      expect(await page.evaluate(() => localStorage.getItem('forge.jwt.kind'))).toBe('"staff"');
      expect(await page.evaluate(() => sessionStorage.getItem('forge.pending-initial-route'))).toBe('/customers');

      // The authenticated response is still held: no business read may mount
      // until startup AND authoritative identity restoration have both passed.
      expect(apiRequests.some(path => path === '/api/customers')).toBe(false);
      releaseAuth();
      await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/customers$/);
      expect(await page.evaluate(() => localStorage.getItem('forge.jwt.kind'))).toBe('"staff"');
      expect(apiRequests).toContain('/api/settings/floor-access');
      expect(apiRequests).toContain('/api/customers');
      await health.assertHealthy();
    } finally {
      releaseAuth();
    }
  });

test('critical backend startup shows failure after the full minute and explicit retry restores the saved route', async ({ page }) => {
  const health = captureRuntimeHealth(page);
  await page.clock.install();
  await mockSession(page, '/customers', false, { seedStorageOnce: true });

  const apiRequests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) apiRequests.push(url.pathname);
  });

  let healthProbes = 0;
  let allowReady = false;
  let backendReady = false;
  let authCalls = 0;
  await page.route('**/api/health/ready', route => {
    healthProbes += 1;
    if (!allowReady) return route.fulfill({ status: 503, json: { status: 'starting' } });
    backendReady = true;
    return route.fulfill({ json: { status: 'ok' } });
  });
  await page.route('**/api/auth/me', route => {
    expect(backendReady, 'identity must never be checked before readiness').toBe(true);
    authCalls += 1;
    return route.fulfill({ json: owner });
  });

  await page.goto('/customers', { waitUntil: 'commit' });
  await expect(page.getByTestId('backend-server-status')).toContainText('Starting backend server');
  const wakeStartedAt = await page.evaluate(() => Date.now());
  await page.clock.fastForward(60_000);
  await expect(page.getByTestId('backend-server-status')).toContainText('Backend server is unavailable');

  const wakeFinishedAt = await page.evaluate(() => Date.now());
  expect(wakeFinishedAt - wakeStartedAt).toBeGreaterThanOrEqual(60_000);
  expect(healthProbes).toBeGreaterThan(0);
  expect(authCalls).toBe(0);
  expect(apiRequests.every(path => path === '/api/health/ready')).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('forge.jwt.kind'))).toBe('"staff"');
  expect(await page.evaluate(() => sessionStorage.getItem('forge.pending-initial-route'))).toBe('/customers');

  const terminalProbeCount = healthProbes;
  await page.clock.fastForward(5_000);
  expect(healthProbes, 'terminal failure must wait for an explicit retry').toBe(terminalProbeCount);

  allowReady = true;
  await page.getByTestId('session-retry').click();
  await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/customers$/);
  expect(backendReady).toBe(true);
  expect(authCalls).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('forge.jwt.kind'))).toBe('"staff"');
  expect(apiRequests).toContain('/api/settings/floor-access');
  expect(apiRequests).toContain('/api/customers');
  await health.assertHealthy();
});
