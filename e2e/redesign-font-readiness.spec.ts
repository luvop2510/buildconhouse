import { expect, test } from '@playwright/test';

const required = ['feather'];

test('cold sign-in uses system text and waits for decoded icons before the first form paint', async ({ page }, info) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let fontRequests = 0;
  await page.route(/\.(?:woff2|ttf)(?:\?|$)/, async route => {
    fontRequests += 1;
    await held;
    await route.continue();
  });
  await page.addInitScript(() => {
    (window as any).__fontPaints = [];
    new MutationObserver(() => {
      if (!document.querySelector('[data-testid="login-email"]')) return;
      const loaded = [...new Set(Array.from(document.fonts as FontFaceSet & Iterable<FontFace>)
        .filter(face => face.status === 'loaded').map(face => face.family.replace(/["']/g, '')))].sort();
      (window as any).__fontPaints.push(loaded);
    }).observe(document, { childList: true, subtree: true });
  });
  try {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => fontRequests).toBeGreaterThan(0);
    const formVisibleBeforeFonts = await page.getByTestId('login-email').isVisible();
    await info.attach('held-font-evidence', { body: JSON.stringify({ formVisibleBeforeFonts, fontRequests }), contentType: 'application/json' });
    expect(formVisibleBeforeFonts, 'SSR and Safari must not paint controls with undecoded icon glyphs').toBe(false);
    await expect(page.getByTestId('app-font-loading')).toBeVisible();
  } finally { release(); }
  await expect(page.getByTestId('login-email')).toBeEditable();
  expect(await page.getByTestId('login-email').evaluate(element => getComputedStyle(element).fontFamily)).toContain('system-ui');
  const paints = await page.evaluate(() => (window as any).__fontPaints as string[][]);
  expect(paints.length).toBeGreaterThan(0);
  for (const loaded of paints) expect(loaded).toEqual(required);
  await expect(page.getByRole('button', { name: 'Show password', exact: true })).toBeVisible();
  await expect(page.locator('[style*="feather" i]')).not.toHaveCount(0);
  // Repeat initialization in the same browser context; Expo may already see
  // statically registered faces and report readiness before their decode.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('login-email')).toBeEditable();
  const reloadPaints = await page.evaluate(() => (window as any).__fontPaints as string[][]);
  expect(reloadPaints.length).toBeGreaterThan(0);
  for (const loaded of reloadPaints) expect(loaded).toEqual(required);
});

test('failed font assets show recovery and a retry reload reaches the complete sign-in form', async ({ page }) => {
  let failFonts = true;
  const requested: string[] = [];
  await page.route(/\.(?:woff2|ttf)(?:\?|$)/, route => {
    requested.push(route.request().url());
    return failFonts ? route.fulfill({ status: 503, contentType: 'text/plain', body: 'Temporary font asset failure', headers: { 'Cache-Control': 'no-store' } }) : route.continue();
  });
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('app-font-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('login-email')).toHaveCount(0);
  expect(requested.length).toBeGreaterThan(0);
  expect(requested.every(url => !new URL(url).searchParams.has('font_retry'))).toBe(true);
  failFonts = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByTestId('login-email')).toBeEditable();
  const loaded = await page.evaluate(() => [...new Set(Array.from(document.fonts as FontFaceSet & Iterable<FontFace>)
    .filter(face => face.status === 'loaded').map(face => face.family.replace(/["']/g, '')))].sort());
  expect(loaded).toEqual(required);
  expect(requested.filter(url => new URL(url).searchParams.has('font_retry')).length).toBeGreaterThanOrEqual(1);
});


test('a stalled font request reaches bounded recovery and late completion cannot reveal the form', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\.(?:woff2|ttf)(?:\?|$)/, async route => { await held; await route.continue(); });
  try {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-font-loading')).toBeVisible();
    await expect(page.getByTestId('app-font-error')).toBeVisible({ timeout: 14_000 });
  } finally { release(); }
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByTestId('app-font-error')).toBeVisible();
  await expect(page.getByTestId('login-email')).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByTestId('login-email')).toBeEditable();
});
