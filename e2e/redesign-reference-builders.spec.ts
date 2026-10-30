import { referrerCode } from '../src/utils/referrer';
import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const references = [
  { id: 'architect-directory-id', type: 'architect', name: 'Existing Architect', company: 'Existing Architecture Studio' },
  { id: 'interior-directory-id', type: 'interior_designer', name: 'Existing Interior Designer', company: 'Existing Interior Studio' },
];
const customer = { id: 'reference-customer', name: 'Reference Buyer', phone: '9999999999', address: 'Synthetic project address' };

async function fixture(page: Page, tiles: boolean) {
  const path = tiles ? '/tiles/quotation?id=reference-document' : '/quotations/new?quotationId=reference-document';
  const floor = tiles ? 'ground-floor' : 'first-floor';
  await mockSession(page, path, false);
  await page.route('**/api/categories**', route => route.fulfill({ json: [] }));
  await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
  await page.route('**/api/products/families?**', route => route.fulfill({ json: { total: 0, items: [] } }));
  await page.route('**/api/products?**', route => route.fulfill({ json: { total: 0, items: [] } }));
  await page.route('**/api/customers**', route => route.fulfill({ json: [customer] }));
  await page.route('**/api/referrers**', route => {
    expect(route.request().method(), 'Existing references are selected without creating new contacts').toBe('GET');
    expect(new URL(route.request().url()).searchParams.has('type')).toBe(false);
    expect(route.request().headers()['x-floor-id']).toBe(floor);
    return route.fulfill({ json: references });
  });
  await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
  let document: Record<string, any> = {
    id: 'reference-document', number: 'Q-REFERENCE', doc_type: tiles ? 'tiles_quotation' : 'standard', floor_id: floor,
    status: 'draft', customer_id: customer.id, customer_name: customer.name, phone_snapshot: customer.phone,
    address_snapshot: customer.address, items: [], rooms: ['Bathroom'], subtotal: 0, grand_total: 0,
    created_at: '2026-10-26T00:00:00Z', updated_at: '2026-10-26T00:00:00Z', purchase_completion_status: 'active',
  };
  const saved: Record<string, unknown>[] = [];
  let reads = 0;
  await page.route(/\/api\/quotations\/reference-document(?:\?.*)?$/, route => {
    expect(route.request().headers()['x-floor-id']).toBe(floor);
    if (route.request().method() === 'GET') { reads++; return route.fulfill({ json: document }); }
    expect(route.request().method()).toBe('PATCH');
    const payload = route.request().postDataJSON();
    saved.push(payload);
    const reference = references.find(row => row.id === payload.referrer_id);
    document = { ...document, ...payload, ...(reference ? { referrer_name: reference.name, referrer_company: reference.company } : {}), updated_at: new Date().toISOString() };
    return route.fulfill({ json: document });
  });
  await page.goto(path);
  return { path, saved, reads: () => reads };
}

async function sanitaryDetails(page: Page) {
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
  const expand = page.getByTestId('expand-quotation-workspace');
  if (await expand.isVisible()) await expand.click();
  const review = page.getByTestId('mobile-review-quotation');
  if (await review.isVisible()) await review.click();
  const quotationTab = page.getByRole('tab', { name: /Quotation/ });
  if (await quotationTab.isVisible()) await quotationTab.click();
  await expect(page.getByTestId('quotation-details-toggle')).toBeVisible();
  if (!await page.getByTestId('compact-hdr-referrer').isVisible()) await page.getByTestId('quotation-details-toggle').click();
  await expect(page.getByTestId('compact-hdr-referrer')).toBeVisible();
}

async function tilesDetails(page: Page) {
  await expect(page.locator('[data-testid="tiles-customer-name"], [data-testid="mobile-customer-name"]')).toHaveValue(customer.name);
  const control = page.getByRole('button', { name: 'Architect / interior designer', exact: true });
  if (!await control.isVisible()) await page.getByRole('button', { name: 'Document details', exact: true }).click();
  await expect(control).toBeVisible();
}

test('critical sanitary quotation selects both existing reference types from All and restores saved identity', async ({ page }) => {
  const state = await fixture(page, false);
  for (const reference of references) {
    await sanitaryDetails(page);
    await page.getByTestId('compact-hdr-referrer').click();
    const sheet = page.getByTestId('referrer-switcher-sheet');
    await expect(sheet.getByRole('button', { name: 'All references', exact: true })).toBeVisible();
    await expect(sheet.getByTestId('referrer-row-architect-directory-id')).toBeVisible();
    await expect(sheet.getByTestId('referrer-row-interior-directory-id')).toBeVisible();
    await sheet.getByTestId('referrer-search').fill(reference.company);
    await expect(sheet.getByTestId(`referrer-row-${reference.id}`)).toBeVisible();
    const code = referrerCode(reference.id, reference.type, reference.name);
    await sheet.getByTestId('referrer-search').fill(code);
    await sheet.getByTestId(`referrer-row-${reference.id}`).click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => state.saved.some(payload => payload.referrer_id === reference.id && payload.referrer_type === reference.type)).toBe(true);
    await expect(page.getByTestId('compact-hdr-referrer')).toContainText(reference.name);
    const previousReads = state.reads();
    await page.reload();
    await sanitaryDetails(page);
    await expect.poll(state.reads).toBeGreaterThan(previousReads);
    await expect(page.getByTestId('compact-hdr-referrer')).toContainText(reference.name);
  }
});

test('critical tile quotation selects both existing reference types from All and restores autosaved identity', async ({ page }) => {
  const state = await fixture(page, true);
  for (const reference of references) {
    await tilesDetails(page);
    await page.getByRole('button', { name: 'Architect / interior designer', exact: true }).click();
    const sheet = page.getByTestId('customer-referrer-sheet');
    await expect(sheet.getByRole('button', { name: 'All references', exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: references[0].name, exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: references[1].name, exact: true })).toBeVisible();
    await sheet.getByLabel('Search references', { exact: true }).fill(reference.company);
    await expect(sheet.getByRole('button', { name: reference.name, exact: true })).toBeVisible();
    const code = referrerCode(reference.id, reference.type, reference.name);
    await sheet.getByLabel('Search references', { exact: true }).fill(code);
    await sheet.getByRole('button', { name: reference.name, exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => state.saved.some(payload => payload.referrer_id === reference.id && payload.referrer_type === reference.type)).toBe(true);
    const previousReads = state.reads();
    await page.reload();
    await tilesDetails(page);
    await expect.poll(state.reads).toBeGreaterThan(previousReads);
    await expect(page.getByRole('button', { name: 'Architect / interior designer', exact: true })).toContainText(reference.name);
  }
});
