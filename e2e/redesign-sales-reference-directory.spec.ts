import { referrerCode } from '../src/utils/referrer';
import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical sales reference directory creates, edits and reuses one identity across floors', async ({ page }) => {
  await mockSession(page, '/sales-data/referrals/architects', false, { seedStorageOnce: true });
  let reference: any = null;
  const floors = new Set<string>();
  await page.route('**/api/referrers**', async route => {
    const request = route.request();
    floors.add(request.headers()['x-floor-id'] || '');
    if (request.method() === 'POST') {
      reference = { ...request.postDataJSON(), id: 'shared-reference', floor_id: 'first-floor', shared_across_floors: true, updated_at: 'v1' };
      return route.fulfill({ json: reference });
    }
    if (request.method() === 'PUT') {
      expect(request.url()).toContain('/referrers/shared-reference');
      expect(request.postDataJSON().updated_at).toBe('v1');
      reference = { ...reference, ...request.postDataJSON(), updated_at: 'v2' };
      return route.fulfill({ json: reference });
    }
    const url = new URL(request.url());
    expect(url.pathname).toBe('/api/referrers/page');
    expect(url.searchParams.get('limit')).toBe('25');
    return route.fulfill({ json: { rows: reference ? [reference] : [], total: reference ? 1 : 0, offset: 0, limit: 25 } });
  });
  await page.route('**/api/analytics/workspaces/relationships?**', route => route.fulfill({ json: { workspace: 'architects', period: 'This month', kpis: { revenue: 0, orders: 0, outstanding: 0 }, brands: [], products: [], customers: [], floors: [], relationships: [] } }));
  await page.goto('/sales-data/referrals/architects');
  const directory = page.getByTestId('sales-reference-directory');
  await directory.getByRole('button', { name: 'Add reference', exact: true }).click();
  await page.getByTestId('reference-name').fill('Shared Architect');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Save reference', exact: true })).toBeDisabled();
  await page.getByTestId('reference-company').fill('One Studio');
  await page.getByTestId('reference-phone').fill('9876543210');
  await page.getByRole('dialog').getByRole('button', { name: 'Save reference', exact: true }).click();
  await expect(directory).toContainText('Shared Architect');
  await expect(directory).toContainText('One Studio');
  await directory.getByRole('button', { name: 'Edit Shared Architect', exact: true }).click();
  await page.getByTestId('reference-company').fill('Updated Studio');
  await page.getByRole('dialog').getByRole('button', { name: 'Save reference', exact: true }).click();
  await expect(directory).toContainText('Updated Studio');
  await page.evaluate(() => localStorage.setItem('forge.active-floor', JSON.stringify('ground-floor')));
  await page.reload();
  await expect(page.getByTestId('sales-reference-directory')).toContainText('Updated Studio');
  await expect(page.getByTestId('sales-reference-directory')).toContainText('All floors');
  expect(floors.has('first-floor')).toBe(true);
  expect(floors.has('ground-floor')).toBe(true);
  expect(reference.id).toBe('shared-reference');
});

test('critical reference directory pages and searches the server while preserving historical reports and shared unions', async ({ page }) => {
  const accessibleFloors = [
    { id: 'first-floor', name: 'Sanitary', slug: 'first-floor' },
    { id: 'ground-floor', name: 'Tiles', slug: 'ground-floor' },
  ];
  await mockSession(page, '/sales-data/relationships', false, {
    floorAccess: { all_floors: false, floors: accessibleFloors, floor_ids: accessibleFloors.map(floor => floor.id) },
  });
  const contacts = [
    ...Array.from({ length: 51 }, (_, index) => ({ id: `r-${String(index).padStart(2, '0')}`, name: `Architect ${String(index).padStart(2, '0')}`, type: 'architect', floor_id: 'first-floor', shared_across_floors: false, updated_at: 'v1' })),
    { id: 'shared', name: 'A shared studio', type: 'architect', floor_id: 'second-floor', shared_across_floors: true, updated_at: 'v1' },
    { id: 'private', name: 'A private studio', type: 'architect', floor_id: 'second-floor', shared_across_floors: false, updated_at: 'v1' },
  ];
  const reads: URL[] = [];
  await page.route('**/api/referrers/page?**', route => {
    const url = new URL(route.request().url()); reads.push(url);
    const floors = (url.searchParams.get('floor_id') || '').split(',');
    const search = (url.searchParams.get('search') || '').toLowerCase();
    const kind = url.searchParams.get('type');
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit'));
    expect(limit).toBe(25);
    const matches = contacts.filter(row => (row.shared_across_floors || floors.includes(row.floor_id))
      && (!kind || kind === row.type) && [row.name, referrerCode(row.id, row.type, row.name)].some(value => value.toLowerCase().includes(search)))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return route.fulfill({ json: { rows: matches.slice(offset, offset + limit), total: matches.length, offset, limit } });
  });
  await page.route('**/api/analytics/workspaces/relationships?**', route => route.fulfill({ json: {
    workspace: 'relationships', period: 'This month', kpis: { revenue: 0, orders: 0, outstanding: 0 }, brands: [], products: [], customers: [], floors: [],
    relationships: [
      { id: 'r-50', name: 'Architect 50', type: 'architect', customers_acquired: 7, revenue: 0, orders: 0, customers: 0, historical: false },
      { id: 'archived', name: 'Archived reference', type: 'architect', customers_acquired: 2, revenue: 100, orders: 1, customers: 1, historical: true },
    ],
  } }));
  await page.goto('/sales-data/relationships');
  const directory = page.getByTestId('sales-reference-directory');
  await expect(directory.getByTestId('reference-row-r-00')).toBeVisible();
  await expect(directory.getByTestId('reference-row-r-50')).toHaveCount(0);
  await expect(directory.getByTestId('sales-historical-references')).toContainText('1 historical reference');
  await expect(directory.getByTestId('reference-row-archived')).toContainText('Historical reference');
  await expect(directory.getByTestId('reference-row-archived').getByRole('link')).toHaveAttribute('href', /floorId=all&preset=custom/);
  await directory.getByRole('button', { name: 'Show more (25 of 52)', exact: true }).click();
  await expect(directory.getByTestId('reference-row-r-48')).toBeVisible();
  expect(reads.map(url => Number(url.searchParams.get('offset')))).toEqual([0, 25]);
  await page.getByTestId('references-search').fill('ARC-ARCHITECT-R-50');
  await expect(directory.getByTestId('reference-row-r-50')).toBeVisible();
  await expect(directory.getByTestId('reference-row-r-50')).toContainText('7');
  await expect(directory.getByTestId('reference-row-r-00')).toHaveCount(0);
  await expect(directory.getByTestId('sales-historical-references')).toHaveCount(0);
  expect(reads.at(-1)!.searchParams.get('search')).toBe('arc-architect-r-50');
  await page.getByTestId('references-search').fill('Archived');
  await expect(directory.getByTestId('reference-row-archived')).toBeVisible();
  await expect(directory).toContainText('0 active references');
  await page.getByTestId('references-search').fill('');
  const toggle = page.getByTestId('sales-data-filters-toggle');
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await page.getByTestId('sales-data-floor-picker').click();
  await page.getByRole('dialog', { name: 'Business unit', exact: true }).getByRole('button', { name: 'All units', exact: true }).click();
  await expect.poll(() => reads.at(-1)!.searchParams.get('floor_id')).toBe('first-floor,ground-floor');
  await expect(directory.getByTestId('reference-row-shared')).toHaveCount(1);
  await expect(directory.getByTestId('reference-row-private')).toHaveCount(0);
  await expect(directory.getByTestId('reference-row-shared')).toContainText('All floors');
});
