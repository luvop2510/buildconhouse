import { expect, test } from '@playwright/test';

test('critical startup paints and hydrates without requesting the legacy head bootstrap', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let releaseFonts!: () => void;
  const fontsHeld = new Promise<void>(resolve => { releaseFonts = resolve; });
  let legacyRequests = 0;
  await page.route('**/expo-hydrate.js', async route => {
    legacyRequests += 1;
    await held;
    await route.continue();
  });
  await page.route(/\.(?:woff2|ttf)(?:\?|$)/, async route => { await fontsHeld; await route.continue(); });
  try {
    await page.goto('/login', { waitUntil: 'commit' });
    await expect(page.getByTestId('app-font-loading')).toBeVisible({ timeout: 5000 });
    releaseFonts();
    await expect(page.getByTestId('login-email')).toBeEditable({ timeout: 5000 });
    expect(legacyRequests).toBe(0);
    expect(await page.evaluate(() => (globalThis as any).__EXPO_ROUTER_HYDRATE__)).toBe(true);
  } finally { release(); releaseFonts(); }
});

test('critical startup paints its static loading indicator while recovery is pending then hydrates', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/release-recovery.js', async route => { await held; await route.continue(); });
  try {
    await page.goto('/login', { waitUntil: 'commit' });
    await expect(page.getByTestId('app-font-loading')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('login-email')).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByTestId('login-email')).toBeEditable({ timeout: 5000 });
  expect(await page.evaluate(() => (globalThis as any).__EXPO_ROUTER_HYDRATE__)).toBe(true);
});

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
