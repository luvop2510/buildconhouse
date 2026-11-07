import { expect, test } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';

const owner = { id: 'retained-owner', email: 'owner@example.test', full_name: 'Retained Owner', role: 'owner', active: true, floor_ids: floors.map(floor => floor.id) };

for (const status of [503, 403]) {
  test(`critical session restoration recovers from ${status} without a password or losing its destination`, async ({ page }) => {
    const health = captureRuntimeHealth(page);
    await mockSession(page, '/customers', false, { seedStorageOnce: true });
    let requests = 0;
    await page.route('**/api/auth/me', route => {
      expect(route.request().headers()['x-floor-id']).toBeUndefined();
      requests += 1;
      return requests === 1
        ? route.fulfill({ status, json: { detail: status === 503 ? 'Deployment in progress' : 'You do not have access to this floor' } })
        : route.fulfill({ json: owner });
    });
    await page.route('**/api/settings/floor-access', route => {
      expect(route.request().headers()['x-floor-id']).toBeUndefined();
      return route.fulfill({ json: { all_floors: true, floors, floor_ids: floors.map(floor => floor.id) } });
    });
    // Begin observing before load: fonts can finish after the automatic
    // one-second reconnect, otherwise a correct transient overlay is missed.
    await page.goto('/customers', { waitUntil: 'commit' });
    await expect(page.getByTestId('session-recovery')).toBeVisible();
    await expect(page).toHaveURL(/\/customers$/);
    expect(await page.evaluate(() => localStorage.getItem('forge.jwt.kind'))).toBe('"staff"');
    // Wait for the bounded automatic recovery to validate the same session.
    await expect(page.getByTestId('session-recovery')).toHaveCount(0);
    await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
    await expect(page.getByTestId('login-submit')).toHaveCount(0);
    await expect(page).toHaveURL(/\/customers$/);
    await page.reload();
    await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('forge.jwt.kind'))).toBe('"staff"');
    await health.assertHealthy();
  });
}

test('critical revoked sessions still clear local identity and require sign in', async ({ page }) => {
  const health = captureRuntimeHealth(page);
  await mockSession(page, '/customers', false, { seedStorageOnce: true });
  await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { detail: 'Session expired or was signed out. Please sign in again.' } }));
  await page.goto('/customers');
  await expect(page.getByTestId('login-submit')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => localStorage.getItem('forge.jwt.kind'))).toBeNull();
  await expect(page.getByTestId('session-recovery')).toHaveCount(0);
  await health.assertHealthy();
});

test('critical session sign out responds immediately and retains the device after failure', async ({ page }) => {
  const health = captureRuntimeHealth(page);
  await mockSession(page, '/settings', false);
  const stamp = new Date().toISOString();
  await page.route('**/api/auth/sessions', route => route.fulfill({ json: [
    { id: 'current', current: true, device_label: 'This browser', login_method: 'password', created_at: stamp, last_seen_at: stamp },
    { id: 'other', current: false, device_label: 'Other browser', login_method: 'password', created_at: stamp, last_seen_at: stamp },
  ] }));
  let release: (() => void) | undefined;
  let fail = true;
  let writes = 0;
  await page.route('**/api/auth/sessions/other', async route => {
    writes++;
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill(fail ? { status: 503, json: { detail: 'Fixture failure' } } : { json: { ok: true } });
  });
  await page.goto('/settings');
  const revoke = page.getByTestId('revoke-session-other');
  await revoke.click();
  await expect(page.getByText('Signing out…', { exact: true })).toBeVisible();
  await expect(revoke).toBeDisabled();
  await expect(page.getByTestId('logout-all-devices')).toBeDisabled();
  await expect.poll(() => writes).toBe(1);
  release!();
  await expect(page.getByText(/Could not confirm sign out/)).toBeVisible();
  await expect(revoke).toBeEnabled();
  await expect(page.getByText('Other browser', { exact: true })).toBeVisible();
  fail = false;
  await revoke.click();
  await expect.poll(() => writes).toBe(2);
  release!();
  await expect(revoke).toHaveCount(0);
  await expect(page.getByText(/This browser/)).toBeVisible();
  await health.assertHealthy();
});
