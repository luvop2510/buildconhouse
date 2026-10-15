import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function customers(page: import('@playwright/test').Page) {
  await mockSession(page, '/customers', false);
  await page.route('**/api/customers?**', route => route.fulfill({ json: Array.from({ length: 45 }, (_, index) => ({
    id: `mobile-${index}`, name: `Mobile Customer ${index}`, email: `customer-${index}@example.test`, phone: '9000000000',
  })) }));
  await page.goto('/customers');
  await expect(page.getByTestId('customer-mobile-0')).toBeVisible();
}

test('critical mobile shell header stays fixed while only customer content scrolls', async ({ page }) => {
  await customers(page);
  const phone = page.viewportSize()!.width < 768;
  const header = page.getByRole('heading', { name: 'Customers', exact: true });
  const initial = await header.boundingBox();
  const workspace = page.getByTestId('mobile-workspace-header');
  const workspaceInitial = phone ? await workspace.boundingBox() : null;
  const card = page.getByTestId('customer-mobile-0');
  const scroll = await card.evaluate(element => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 200) {
        parent.scrollTop = 500;
        return parent.scrollTop;
      }
    }
    return 0;
  });
  expect(scroll).toBeGreaterThan(200);
  await expect.poll(async () => (await header.boundingBox())!.y).toBe(initial!.y);
  if (phone) expect((await workspace.boundingBox())!.y).toBe(workspaceInitial!.y);
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  await expect(card).not.toBeInViewport();
});

test('critical navigation stays hidden throughout mobile search and returns on blur', async ({ page }) => {
  await customers(page);
  const phone = page.viewportSize()!.width < 768;
  const navigation = page.getByRole('navigation', { name: 'Primary', exact: true });
  const workspace = page.getByTestId('mobile-workspace-header');
  await expect(navigation).toBeVisible();
  const input = page.getByTestId('customers-search');
  await input.fill('Mobile Customer 2');
  await expect(page.getByTestId('customer-mobile-2')).toBeVisible();
  if (phone) {
    await expect(navigation).toBeHidden();
    await expect(workspace).toBeHidden();
    await input.press('Backspace');
    await expect(navigation).toBeHidden();
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: viewport.height, height: viewport.width });
    await expect(input).toHaveValue('Mobile Customer ');
    await page.setViewportSize(viewport);
    await expect(navigation).toBeHidden();
  } else await expect(navigation).toBeVisible();
  await input.blur();
  await expect(navigation).toBeVisible();
  if (phone) await expect(workspace).toBeVisible();
});
