import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const dialogName = 'Search workspace';
const inputName = 'Search commands, customers, quotations, and products';

async function preparePalette(page: Page) {
  // This global fixture intercepts every API request, including unrelated layout requests.
  await mockSession(page, '/customers', false);
  await page.route('**/api/quotations*', route => route.fulfill({ json: [] }));
  await page.goto('/customers');
  await expect(page.getByRole('heading', { name: 'Customers', exact: true })).toBeVisible();
  await expect(page.getByTestId('floor-switcher').filter({ visible: true }).first()).toHaveAccessibleName('Switch workspace. Current workspace: The Sanitary Bathroom');
}

async function openPalette(page: Page) {
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole('textbox', { name: inputName, exact: true });
  await expect(input).toBeFocused();
  return { dialog, input };
}

test('critical command palette keyboard close and rapid reopen start a fresh focused query', async ({ page }) => {
  await preparePalette(page);
  const trigger = page.getByTestId('floor-switcher').filter({ visible: true }).first();
  await trigger.focus();
  let palette = await openPalette(page);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await palette.input.fill(`palette-session-fixture-${cycle}`);
    await page.keyboard.press('Escape');
    // Reopen immediately, including while the previous exit animation can still run.
    palette = await openPalette(page);
    await expect(palette.input).toHaveValue('');
    await expect(page.getByRole('dialog', { name: dialogName, exact: true })).toHaveCount(1);
  }
  await page.keyboard.press('Escape');
  await expect(palette.dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('critical command palette hides product rows immediately below the search threshold', async ({ page }) => {
  await preparePalette(page);
  await page.route('**/api/products?*', route => route.fulfill({
    json: { items: [{ id: 'palette-threshold-product', name: 'Palette Threshold Fixture Product' }] },
  }));
  const { dialog, input } = await openPalette(page);
  await input.fill('palette-threshold');
  const product = dialog.getByRole('button', { name: 'Palette Threshold Fixture Product', exact: true });
  await expect(product).toBeVisible();
  await input.fill('z');
  await expect(product).toHaveCount(0);
  await input.fill('');
  await expect(product).toHaveCount(0);
});

test('critical command palette ignores a delayed product response from a closed session', async ({ page }) => {
  await preparePalette(page);
  let releaseOld!: () => void;
  let oldStarted!: () => void;
  let oldFinished!: () => void;
  const held = new Promise<void>(resolve => { releaseOld = resolve; });
  const started = new Promise<void>(resolve => { oldStarted = resolve; });
  const finished = new Promise<void>(resolve => { oldFinished = resolve; });
  await page.route('**/api/products?*', async route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query !== 'palette-old-session') {
      await route.fulfill({ json: { items: [{ id: 'palette-current-product', name: 'Palette Current Session Fixture' }] } });
      return;
    }
    oldStarted();
    await held;
    try {
      await route.fulfill({ json: { items: [{ id: 'palette-obsolete-product', name: 'Palette Obsolete Session Fixture' }] } });
    } catch (error) {
      // Closing aborts the fetch; an already cancelled route may reject fulfillment.
      const failure = route.request().failure();
      if (!failure || !/aborted|cancelled/i.test(failure.errorText)) throw error;
    } finally {
      oldFinished();
    }
  });
  try {
    let palette = await openPalette(page);
    await palette.input.fill('palette-old-session');
    await started;
    await page.keyboard.press('Escape');
    palette = await openPalette(page);
    await expect(palette.input).toHaveValue('');
    await palette.input.fill('palette-current-session');
    await expect(palette.dialog.getByRole('button', { name: 'Palette Current Session Fixture', exact: true })).toBeVisible();
    releaseOld();
    await finished;
    // Allow a fulfilled response and its React update to reach the next paint.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(palette.dialog.getByRole('button', { name: 'Palette Obsolete Session Fixture', exact: true })).toHaveCount(0);
    await expect(palette.dialog.getByRole('button', { name: 'Palette Current Session Fixture', exact: true })).toBeVisible();
    await expect(palette.input).toHaveValue('palette-current-session');
  } finally {
    releaseOld();
  }
});

test('critical command palette reduced motion keeps empty keyboard selection bounded', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await preparePalette(page);
  await page.route('**/api/products?*', route => route.fulfill({ json: { items: [] } }));
  let palette = await openPalette(page);
  await palette.input.fill('palette-no-results-fixture');
  await expect(palette.dialog.getByText('Nothing matches “palette-no-results-fixture”', { exact: true })).toBeVisible();
  const originalUrl = page.url();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(palette.dialog).toBeVisible();
  expect(page.url()).toBe(originalUrl);
  await page.keyboard.press('Escape');
  await expect(palette.dialog).toBeHidden();
  palette = await openPalette(page);
  await expect(palette.input).toHaveValue('');
});

test('critical command palette handles ArrowDown and Enter while its search input is focused', async ({ page }) => {
  await preparePalette(page);
  const { dialog, input } = await openPalette(page);
  const first = dialog.getByRole('button', { name: 'New quotation', exact: true });
  const second = dialog.getByRole('button', { name: 'Add customer', exact: true });
  const highlight = await first.evaluate(element => getComputedStyle(element).backgroundColor);
  expect(await second.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(highlight);
  await page.keyboard.press('ArrowDown');
  await expect(input).toBeFocused();
  await expect.poll(() => second.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(highlight);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/customers\/new$/);
  await expect(dialog).toBeHidden();
});

test('critical command palette Tab-to-Add customer Enter activates the focused result instead of the highlighted action', async ({ page }) => {
  await preparePalette(page);
  const { dialog } = await openPalette(page);
  const highlighted = dialog.getByRole('button', { name: 'New quotation', exact: true });
  const focusedResult = dialog.getByRole('button', { name: 'Add customer', exact: true });
  const highlight = await highlighted.evaluate(element => getComputedStyle(element).backgroundColor);
  // Mobile has a Cancel button before the result rows; exercise real Tab
  // navigation on every profile without moving selection with ArrowDown.
  for (let step = 0; step < 4; step += 1) {
    if (await focusedResult.evaluate(element => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(focusedResult).toBeFocused();
  expect(await highlighted.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(highlight);
  expect(await focusedResult.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(highlight);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/customers\/new$/);
  await expect(dialog).toBeHidden();
});

test('critical command palette focused mobile Cancel Enter dismisses without navigating', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) >= 768, 'Cancel is rendered only in the mobile palette');
  await preparePalette(page);
  const originalUrl = page.url();
  const { dialog } = await openPalette(page);
  const cancel = dialog.getByRole('button', { name: 'Close command palette', exact: true });
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page).toHaveURL(originalUrl);
  await expect(page.getByRole('heading', { name: 'Customers', exact: true })).toBeVisible();
});

test('critical reduced-motion command palette Escape closes only the top quotation overlay', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) >= 768, 'Quotation actions sheet is rendered only on phone layouts');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockSession(page, '/quotations/new', false);
  await page.route('**/api/categories**', route => route.fulfill({ json: [] }));
  await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
  await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/products/families?**', route => route.fulfill({ json: { total: 0, items: [] } }));
  await page.goto('/quotations/new');
  const trigger = page.getByTestId('builder-actions');
  await trigger.click();
  const underlying = page.getByTestId('quotation-actions-sheet');
  await expect(underlying).toBeVisible();
  const { dialog, input } = await openPalette(page);
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(underlying).toBeVisible();
  // Finish the response/render frames before checking the restored focus and
  // sending a distinct second key gesture to the remaining dialog.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(underlying).toBeVisible();
  await expect.poll(() => underlying.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(underlying).toBeHidden();
  await expect(trigger).toBeFocused();
});
