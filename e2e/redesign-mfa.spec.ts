import { expect, test } from '@playwright/test';
import { floors, mockSession } from './audit-fixtures';
import { readFileSync } from 'node:fs';

test.beforeEach(async ({ page }) => {
  const policy = JSON.parse(readFileSync('vercel.json', 'utf8')).routes[0].headers['Content-Security-Policy'];
  await page.route('**/*', async route => {
    if (!route.request().isNavigationRequest()) return route.fallback();
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), 'Content-Security-Policy': policy } });
  });
});

for (const recovery of [false, true]) {
  test(`critical login requires ${recovery ? 'recovery' : 'authenticator'} proof before entering workspace`, async ({ page }) => {
    await mockSession(page, '/login', false, { signedIn: false });
    await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { detail: 'Not signed in' } }));
    const requests: Record<string, string>[] = [];
    await page.route('**/api/auth/login', route => {
      const body = route.request().postDataJSON(); requests.push(body);
      if (!body.mfa_code && !body.recovery_code) return route.fulfill({ status: 401, json: { detail: 'mfa_required' } });
      return route.fulfill({ json: { access_token: '', user: { id: 'mfa-owner', email: 'owner@example.test', full_name: 'MFA Owner', role: 'owner', active: true, mfa_enabled: true, floor_ids: floors.map(f => f.id) } } });
    });
    await page.goto('/login');
    await expect(page.getByRole('textbox', { name: 'Email or username', exact: true })).toBeVisible();
    await page.getByTestId('login-email').fill('owner@example.test');
    await page.getByTestId('login-password').fill('fixture-only-password');
    await page.getByTestId('login-submit').click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toMatchObject({ email: 'owner@example.test', password: 'fixture-only-password' });
    await expect(page.getByTestId('login-mfa-code')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    if (recovery) await page.getByTestId('login-mfa-recovery').click();
    const factor = recovery ? '00112233-44556677-8899aabb-ccddeeff' : '123456';
    await page.getByTestId('login-mfa-code').fill(factor);
    await page.getByTestId('login-submit').click();
    await expect(page).toHaveURL(/\/dashboard$/);
    expect(requests).toHaveLength(2);
    expect(requests[1][recovery ? 'recovery_code' : 'mfa_code']).toBe(factor);
    expect(await page.evaluate(() => localStorage.getItem('forge.jwt'))).toBeNull();
  });
}

test('critical authenticator enrollment displays recovery codes once and excludes them from browser storage', async ({ page }) => {
  await mockSession(page, '/settings-mfa', false);
  let enabled = false;
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const codes = ['00112233-44556677-8899aabb-ccddeeff'];
  await page.route('**/api/auth/mfa/status', route => route.fulfill({ json: { enabled, recovery_codes_remaining: enabled ? 10 : 0 } }));
  await page.route('**/api/auth/mfa/enroll', route => {
    expect(route.request().postDataJSON().current_password).toBe('fixture-only-password');
    return route.fulfill({ json: { secret, uri: `otpauth://totp/Fixture?secret=${secret}`, expires_in: 600 } });
  });
  await page.route('**/api/auth/mfa/confirm', route => {
    expect(route.request().postDataJSON().mfa_code).toBe('123456'); enabled = true;
    return route.fulfill({ json: { enabled, recovery_codes: codes } });
  });
  await page.goto('/settings-mfa');
  await expect(page.getByText('Not enrolled', { exact: true })).toBeVisible();
  await page.getByTestId('mfa-password').fill('fixture-only-password');
  await page.getByTestId('mfa-enroll').click();
  await expect(page.getByTestId('mfa-setup-key')).toHaveText(secret);
  await page.getByTestId('mfa-code').fill('123456');
  await page.getByTestId('mfa-confirm').click();
  await expect(page.getByTestId('mfa-recovery-codes')).toHaveText(codes.join('\n'));
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(secret); expect(stored).not.toContain(codes[0]);
  await page.getByRole('button', { name: 'I saved my recovery codes', exact: true }).click();
  await expect(page.getByTestId('mfa-recovery-codes')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Enabled · 10 recovery codes remaining', { exact: true })).toBeVisible();
  await expect(page.getByTestId('mfa-recovery-codes')).toHaveCount(0);
});
