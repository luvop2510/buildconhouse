import { expect, test } from '@playwright/test';

test('critical failed startup asset reloads once and reaches usable login', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 401, json: { detail: 'No active session' } }));
  let navigations = 0;
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations += 1;
  });
  await page.route('**/_expo/static/js/web/entry-*.js', route => {
    return navigations === 1
      ? route.fulfill({ status: 404, contentType: 'application/javascript', body: '' })
      : route.continue();
  });
  await page.goto('/', { waitUntil: 'commit' });
  await expect(page.getByRole('textbox', { name: 'Email or username', exact: true })).toBeVisible({ timeout: 15000 });
  await expect.poll(() => navigations).toBe(2);
  await expect(page.getByRole('button', { name: 'Reload app', exact: true })).toHaveCount(0);
  await page.getByTestId('login-submit').click();
  await expect(page.getByRole('alert')).toHaveText('Enter your email or username and password.');
});

test('critical repeated startup asset failure stops retrying and exposes a visible reload action', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 401, json: { detail: 'No active session' } }));
  let navigations = 0;
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations += 1;
  });
  await page.route('**/_expo/static/js/web/entry-*.js', route => {
    return route.fulfill({ status: 404, contentType: 'application/javascript', body: '' });
  });
  await page.goto('/', { waitUntil: 'commit' });
  const reload = page.getByRole('button', { name: 'Reload app', exact: true });
  await expect(reload).toBeVisible({ timeout: 15000 });
  await expect.poll(() => navigations).toBe(2);
  await expect(page.getByRole('alert')).toContainText('The app could not start');
  const box = await reload.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
