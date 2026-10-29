import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical sanitary pending quotations have a clear phone gutter and keep card contents in view', async ({ page }) => {
  await mockSession(page, '/quotations', false);
  await page.route('**/api/quotations?doc_type=standard&view=pending&**', route => route.fulfill({ json: [{
    id: 'mobile-pending', number: 'Q-2026-00421', customer_name: 'Mobile Buyer', status: 'pending_approval',
    grand_total: 127500, created_at: '2026-10-10T10:00:00Z',
    item_count: 1,
  }] }));

  await page.goto('/quotations');
  const card = page.getByTestId('quotation-mobile-pending');
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  const gutter = 16; // Shared compact page gutter on phones.
  expect(box).not.toBeNull();
  expect(box!.x, 'quotation card should have a visible left gutter').toBeGreaterThanOrEqual(gutter);
  expect(box!.x + box!.width, 'quotation card should have a visible right gutter').toBeLessThanOrEqual(width - gutter);

  for (const content of [card.getByText(/^Q-2026-00421 · 1 item/), card.getByText('Mobile Buyer', { exact: true })]) {
    const innerBox = await content.boundingBox();
    expect(innerBox).not.toBeNull();
    expect(innerBox!.x).toBeGreaterThan(box!.x);
    expect(innerBox!.x + innerBox!.width).toBeLessThan(box!.x + box!.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
