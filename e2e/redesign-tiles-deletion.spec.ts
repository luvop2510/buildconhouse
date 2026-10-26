import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

for (const type of ['tiles_selection', 'tiles_quotation'] as const) {
  test(`critical Ground Floor confirms and removes a ${type} from its list`, async ({ page }) => {
    await mockSession(page, '/tiles', false);
    let deleted = false;
    let commands = 0;
    await page.route('**/api/quotations?**', route => {
      const requested = new URL(route.request().url()).searchParams.get('doc_type');
      return route.fulfill({ json: requested === type && !deleted ? [{
        id: 'delete-ground-document', number: 'SYNTHETIC-001', doc_type: type,
        status: 'draft', customer_name: 'Synthetic buyer', grand_total: 120,
        updated_at: '2026-10-26T00:00:00Z',
      }] : [] });
    });
    await page.route('**/api/quotations/delete-ground-document', route => {
      expect(route.request().method()).toBe('DELETE');
      expect(route.request().headers()['x-floor-id']).toBe('ground-floor');
      commands++; deleted = true;
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/tiles');
    const filters = page.getByTestId('tiles-filters-toggle');
    if (await filters.getAttribute('aria-expanded') === 'false') await filters.click();
    await page.getByTestId('tiles-document-filter-all').click();
    await expect(page.getByTestId('tiles-doc-delete-ground-document')).toBeVisible();
    await page.getByTestId('tiles-delete-delete-ground-document').click();
    const dialog = page.getByTestId('confirm-delete-tiles-list');
    await expect(dialog).toBeVisible();
    expect(commands).toBe(0);
    await dialog.getByTestId('confirm-delete-tiles-list-confirm').click();
    await expect(page.getByTestId('tiles-doc-delete-ground-document')).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    expect(commands).toBe(1);
  });
}
