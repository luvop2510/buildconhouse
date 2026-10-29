import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const doc = {
  id: 'tile-recovery', number: 'TQ-RECOVERY', doc_type: 'tiles_quotation', floor_id: 'ground-floor',
  status: 'draft', customer_id: 'tile-customer', customer_name: 'Recovery Customer',
  address_snapshot: 'Fixture project', items: [], subtotal: 0, grand_total: 0,
  updated_at: '2026-10-16T10:00:00Z',
};

test('critical tiles quotations stay usable while selection loading fails and retry recovers both document types', async ({ page }, info) => {
  await mockSession(page, '/tiles', false);
  let failSelection = true;
  await page.route('**/api/quotations?**', route => {
    const selection = new URL(route.request().url()).searchParams.get('doc_type') === 'tiles_selection';
    return selection && failSelection
      ? route.fulfill({ status: 503, json: { detail: 'Selection list temporarily unavailable' } })
      : route.fulfill({ json: selection ? [] : [doc] });
  });
  await page.goto('/tiles');
  await expect(page.getByTestId('tiles-doc-tile-recovery')).toBeVisible();
  // Both document types appear by default; a failed optional list keeps the
  // available quotation usable and exposes its own retry.
  await expect(page.getByText('Selection list temporarily unavailable', { exact: true })).toBeVisible();
  await expect(page.getByTestId('tiles-doc-tile-recovery')).toBeVisible();
  failSelection = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('Selection list temporarily unavailable', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('tiles-doc-tile-recovery')).toBeVisible();
  await page.screenshot({ path: info.outputPath('recovered-tile-list.png'), animations: 'disabled' });
});

test('critical failed saved tile quotation offers retry and never exposes a blank editable quotation', async ({ page }, info) => {
  await mockSession(page, '/quotations', false);
  let failed = true;
  const floors: string[] = [];
  await page.route(/\/api\/quotations\/tile-recovery(?:\?.*)?$/, route => {
    floors.push(route.request().headers()['x-floor-id']);
    return failed ? route.fulfill({ status: 503, json: { detail: 'Saved tile quotation temporarily unavailable' } }) : route.fulfill({ json: doc });
  });
  await page.goto('/tiles/quotation?id=tile-recovery');
  await expect(page.getByTestId('tiles-restore-retry')).toBeVisible();
  await expect(page.getByTestId('tiles-generate-pdf')).toHaveCount(0);
  await expect(page.getByTestId('tiles-mobile-download-pdf')).toHaveCount(0);
  failed = false;
  await page.getByTestId('tiles-restore-retry').click();
  await expect(page.getByTestId('tiles-restore-retry')).toHaveCount(0);
  await expect(page.locator('[data-testid="tiles-customer-name"], [data-testid="mobile-customer-name"]')).toHaveValue('Recovery Customer');
  expect(floors.length).toBeGreaterThan(1);
  expect(floors.every(floor => floor === 'ground-floor')).toBe(true);
  await page.screenshot({ path: info.outputPath('recovered-tile-editor.png'), animations: 'disabled' });
});

for (const kind of ['selection', 'quotation']) test(`critical Ground ${kind} reuses exact walk-in contact and address from name search`, async ({page}, info) => {
  await mockSession(page, `/tiles/${kind}`, false);
  const searched: string[] = [];
  const writes: any[] = [];
  await page.route('**/api/customers?**', route => {
    const url = new URL(route.request().url());
    expect(route.request().headers()['x-floor-id']).toBe('ground-floor');
    expect(url.searchParams.get('limit')).toBe('20');
    searched.push(url.searchParams.get('search') || '');
    return route.fulfill({json:[
      {id:'wrong-same-name', name:'Walkin Fixture', phone:'9000000001', address:'Other saved address'},
      {id:'exact-walkin', name:'Walkin Fixture', phone:'9000000002', address:'12 Exact Walk-in Road'},
    ]});
  });
  await page.route('**/api/quotations', route => {
    if(route.request().method()==='POST') {
      writes.push(route.request().postDataJSON());
      return route.fulfill({json:{...writes.at(-1), id:'created-walkin-document',number:'QA-LOOKUP',updated_at:'2026-10-29T00:00:00Z'}});
    }
    return route.fulfill({json:[]});
  });
  await page.route('**/api/quotations/created-walkin-document', route=>route.fulfill({json:{updated_at:'2026-10-29T00:00:01Z'}}));
  await page.goto(`/tiles/${kind}`);
  const input=page.locator('[data-testid="tiles-customer-name"], [data-testid="mobile-customer-name"]');
  await input.fill('Walkin');
  await expect(page.getByTestId('tiles-customer-option-exact-walkin')).toContainText('12 Exact Walk-in Road');
  await page.getByTestId('tiles-customer-option-exact-walkin').click();
  await expect(input).toHaveValue('Walkin Fixture');
  await expect.poll(()=>writes.length).toBeGreaterThan(0);
  expect(writes[0]).toMatchObject({customer_id:'exact-walkin',phone_snapshot:'9000000002',address_snapshot:'12 Exact Walk-in Road'});
  expect(searched).toContain('Walkin');
  await page.screenshot({path:info.outputPath(`walkin-${kind}.png`),animations:'disabled'});
});
