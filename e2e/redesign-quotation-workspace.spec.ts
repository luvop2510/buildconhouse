import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';
import { mkdir } from 'node:fs/promises';

// Synthetic identities only. Check actual usable geometry, scrolling and independent actions.
test('critical quotation workspace keeps title and actions in the padded scrolling frame', async ({ page }, testInfo) => {
  const health = captureRuntimeHealth(page);
  await mockSession(page, '/quotations', false);
  const quotes = Array.from({ length: 24 }, (_, index) => ({
    id: `workspace-${index}`, number: `Q-2026-${String(index + 1).padStart(5, '0')}`,
    customer_name: index === 0 ? 'Shah Residence — Guest Bathroom and Powder Room' : `Showroom customer ${index + 1}`,
    status: index % 2 ? 'sent' : 'draft', grand_total: 127500 + index * 1250,
    created_at: '2026-10-23T10:00:00Z', items: [{ id: `line-${index}`, qty: 2 }],
  }));
  await page.route('**/api/quotations?**', route => route.fulfill({ json: quotes }));
  await page.goto('/quotations');
  const heading = page.getByRole('heading', { name: 'Quotations', exact: true });
  await expect(page.getByTestId('quotation-workspace-0')).toBeVisible();
  const width = page.viewportSize()!.width;
  if (width < 768) {
    for (const element of [heading, page.getByTestId('new-quotation-btn'), page.getByTestId('quotations-search'), page.getByTestId('quotation-workspace-0')]) {
      const box = await element.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(16);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width - 16);
    }
  }
  await expect(page.getByTestId('quotation-workspace-0')).toContainText(quotes[0].customer_name);
  await mkdir(`output/workspace-repair/${process.env.WORKSPACE_PHASE || 'after'}`, { recursive: true });
  await page.screenshot({ path: `output/workspace-repair/${process.env.WORKSPACE_PHASE || 'after'}/${testInfo.project.name}.png` });
  if (process.env.WORKSPACE_PHASE === 'before') return;
  const remove = page.getByTestId('delete-quotation-workspace-0');
  const target = await remove.boundingBox();
  expect(target!.width).toBeGreaterThanOrEqual(44);
  expect(target!.height).toBeGreaterThanOrEqual(44);
  await remove.click();
  await expect(page.getByTestId('confirm-delete-quotation-list')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/quotations');
  await page.getByTestId('confirm-delete-quotation-list').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTestId('quotations-search').fill('Shah');
  await expect(page.locator('[data-testid^="quotation-workspace-"]')).toHaveCount(1);
  await page.getByTestId('quotations-search').fill('');
  await expect(page.getByTestId('quotation-workspace-1')).toBeVisible();
  if (width < 768) {
    const list = page.getByTestId('quotation-list-scroll');
    await list.evaluate(element => { element.scrollTop = 500; element.dispatchEvent(new Event('scroll')); });
    await expect.poll(async () => (await heading.boundingBox())!.y).toBeLessThan(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await health.assertHealthy();
});
