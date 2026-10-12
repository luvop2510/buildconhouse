import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('phone shell fills the available viewport and keeps navigation below scrollable content', async ({ page }) => {
  test.skip(page.viewportSize()!.width >= 768, 'The phone scaffold owns bottom navigation.');
  await mockSession(page, '/customers', false);
  await page.goto('/customers');
  await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
  const shell = await page.getByTestId('admin-mobile-shell').boundingBox();
  const navigation = page.getByRole('navigation', { name: 'Primary', exact: true });
  const bar = await navigation.boundingBox();
  const viewport = page.viewportSize()!;
  expect(shell!.x).toBe(0);
  expect(shell!.width).toBe(viewport.width);
  expect(shell!.height).toBe(viewport.height);
  expect(bar!.y + bar!.height).toBeCloseTo(viewport.height, 0);
  for (const control of await navigation.locator('a,button').all()) {
    const box = await control.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  }
  // A short browser viewport models the usable space after browser chrome or
  // an on-screen keyboard changes height; navigation must reflow with it.
  await page.setViewportSize({ width: viewport.width, height: 480 });
  await expect.poll(async () => (await navigation.boundingBox())!.y + (await navigation.boundingBox())!.height).toBe(480);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('phone More sheet wraps a long account name within its row and restores page space', async ({ page }) => {
  test.skip(page.viewportSize()!.width >= 768, 'The workspace sheet is phone navigation.');
  const name = 'Owner with an unusually long business and project coordination account name';
  await mockSession(page, '/customers', false, {
    staff: { id: 'long-name-owner', full_name: name, role: 'owner', active: true },
  });
  await page.goto('/customers');
  const more = page.getByRole('button', { name: 'More', exact: true });
  await more.click();
  const dialog = page.getByRole('dialog', { name: 'Workspace', exact: true });
  const account = dialog.getByText(name, { exact: true });
  await expect(account).toBeVisible();
  const bounds = await account.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await account.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(page.getByText('No customers yet', { exact: true })).toBeVisible();
});
