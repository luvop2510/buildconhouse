import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { captureRuntimeHealth } from './runtime-health';

for (const tiles of [false, true]) {
  test(`critical ${tiles ? 'Ground' : 'Sanitary'} document list pages summaries and searches beyond record 100`, async ({ page }) => {
    const health = captureRuntimeHealth(page);
    const path = tiles ? '/tiles' : '/quotations';
    await mockSession(page, path, false);
    const records = Array.from({ length: 125 }, (_, index) => ({
      id: `paged-${index}`, number: `Q-${index}`, customer_name: `Buyer ${index}`,
      doc_type: tiles ? 'tiles_quotation' : 'standard', status: 'draft',
      grand_total: 1200, item_count: 3, created_at: '2026-10-30T00:00:00Z', updated_at: '2026-10-30T00:00:00Z',
    }));
    const reads: URLSearchParams[] = [];
    await page.route('**/api/quotations?**', route => {
      const params = new URL(route.request().url()).searchParams;
      expect(route.request().headers()['x-floor-id']).toBe(tiles ? 'ground-floor' : 'first-floor');
      expect(params.get('summary')).toBe('true');
      expect(params.get('limit')).toBe('31');
      reads.push(params);
      if (params.get('doc_type') === 'tiles_selection') return route.fulfill({ json: [] });
      const term = (params.get('q') || '').toLowerCase();
      const matches = records.filter(row => `${row.customer_name} ${row.number}`.toLowerCase().includes(term));
      const skip = Number(params.get('skip'));
      return route.fulfill({ json: matches.slice(skip, skip + 31) });
    });
    await page.goto(path);
    const prefix = tiles ? 'tiles-doc' : 'quotation';
    await expect(page.getByTestId(`${prefix}-paged-0`)).toBeVisible();
    expect(reads.filter(params => params.get('doc_type') !== 'tiles_selection').map(params => params.get('skip'))).toEqual(['0']);
    await page.getByTestId(tiles ? 'tiles-load-more-tiles_quotation' : 'quotations-load-more').click();
    await expect.poll(() => reads.some(params => params.get('skip') === '30')).toBe(true);
    const search = tiles ? page.getByPlaceholder('Search customer or document number') : page.getByTestId('quotations-search');
    await search.fill('Buyer 120');
    await expect(page.getByTestId(`${prefix}-paged-120`)).toBeVisible();
    await expect(page.getByTestId(`${prefix}-paged-0`)).toHaveCount(0);
    expect(reads.some(params => params.get('q') === 'Buyer 120' && params.get('skip') === '0')).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await health.assertHealthy();
  });
}
