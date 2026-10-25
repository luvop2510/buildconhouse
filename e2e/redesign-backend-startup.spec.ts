import { expect, test } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';

const owner = {
  id: 'startup-owner', email: 'owner@example.test', full_name: 'Startup Owner', role: 'owner', active: true,
  floor_ids: floors.map(floor => floor.id),
};

test('critical startup restores identity and destination without an anonymous health prerequisite', async ({ page }) => {
  const health = captureRuntimeHealth(page);
  await mockSession(page, '/customers', false, { seedStorageOnce: true });
  const apiRequests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) apiRequests.push(url.pathname);
  });
  let healthProbes = 0;
  await page.route('**/api/health/ready', route => { healthProbes++; return route.abort('failed'); });
  let authCalls = 0;
  let releaseAuth!: () => void;
  const held = new Promise<void>(resolve => { releaseAuth = resolve; });
  await page.route('**/api/auth/me', async route => {
    authCalls++;
    await held;
    return route.fulfill({ json: owner });
  });
  try {
    await page.goto('/customers', { waitUntil: 'commit' });
    await expect(page.getByTestId('backend-server-status')).toContainText('Checking account access');
    await expect.poll(() => authCalls).toBe(1);
    expect(healthProbes).toBe(0);
    expect(apiRequests).toEqual(['/api/auth/me']);
    expect(await page.evaluate(() => localStorage.getItem('forge.jwt.kind'))).toBe('"staff"');
    expect(await page.evaluate(() => sessionStorage.getItem('forge.pending-initial-route'))).toBe('/customers');
    releaseAuth();
    await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/customers$/);
    expect(apiRequests).toContain('/api/settings/floor-access');
    expect(apiRequests).toContain('/api/customers');
    expect(healthProbes).toBe(0);
    await health.assertHealthy();
  } finally { releaseAuth(); }
});

test('critical startup identity retry restores the saved route without a minute-long health loop', async ({ page }) => {
  const health = captureRuntimeHealth(page);
  await mockSession(page, '/customers', false, { seedStorageOnce: true });
  let healthProbes = 0;
  let unavailable = true;
  let authCalls = 0;
  await page.route('**/api/health/ready', route => { healthProbes++; return route.abort('failed'); });
  await page.route('**/api/auth/me', route => {
    authCalls++;
    return route.fulfill(unavailable ? { status: 503, json: { detail: 'Temporary identity failure' } } : { json: owner });
  });
  await page.goto('/customers', { waitUntil: 'commit' });
  await expect(page.getByTestId('session-recovery')).toBeVisible();
  expect(authCalls).toBeGreaterThan(0);
  expect(healthProbes).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('forge.jwt.kind'))).toBe('"staff"');
  expect(await page.evaluate(() => sessionStorage.getItem('forge.pending-initial-route'))).toBe('/customers');
  unavailable = false;
  await page.getByTestId('session-retry').click();
  await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/customers$/);
  expect(await page.evaluate(() => localStorage.getItem('forge.jwt.kind'))).toBe('"staff"');
  expect(healthProbes).toBe(0);
  await health.assertHealthy();
});
