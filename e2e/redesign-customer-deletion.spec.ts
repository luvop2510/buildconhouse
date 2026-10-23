import { test, expect } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical customer deletion reviews linked records and legacy Furniture without affecting another customer', async ({ page }) => {
  await mockSession(page, '/customers', false);
  let removed = false;
  await page.route('**/api/customers?**', route => route.fulfill({json: [
    ...(!removed ? [{id:'delete-target',name:'Synthetic Buyer',company:'Synthetic Buyer',phone:'9000000000'}] : []),
    {id:'keep-other',name:'Other Buyer',company:'Other Buyer',phone:'9000000001'},
  ]}));
  await page.route('**/api/customers/delete-target/deletion-preview?**', route => {
    const selected = new URL(route.request().url()).searchParams.get('furniture_ids')?.includes('legacy-furniture');
    return route.fulfill({json: {customer_id:'delete-target', confirmation:selected?'with-furniture':'without-furniture',
      counts:{customers:1,quotations:3,payments:2,purchase_orders:1,furniture_quotations:selected?1:0},
      selected_furniture_ids:selected?['legacy-furniture']:[],
      furniture_candidates:[{id:'legacy-furniture',customer_name:'Synthetic ledger',customer_phone:'9000000000',selected:!!selected}]}});
  });
  let deletes = 0;
  await page.route('**/api/customers/delete-target?**', route => {
    expect(route.request().method()).toBe('DELETE');
    const params = new URL(route.request().url()).searchParams;
    expect(params.get('confirmation')).toBe('with-furniture');
    expect(params.get('furniture_ids')).toBe('legacy-furniture');
    deletes++; removed = true;
    return route.fulfill({json:{ok:true,customer_id:'delete-target'}});
  });
  await page.goto('/customers');
  await expect(page.getByTestId('customer-delete-target')).toBeVisible();
  await page.getByTestId('delete-customer-delete-target').click();
  const dialog = page.getByTestId('confirm-delete-customer-list');
  await expect(dialog.getByTestId('customer-deletion-summary')).toBeVisible();
  expect(deletes).toBe(0);
  await dialog.getByRole('checkbox', { name:'Include furniture quotation Synthetic ledger' }).click();
  await expect(dialog.getByRole('checkbox')).toHaveAttribute('aria-checked','true');
  await dialog.getByTestId('confirm-delete-customer-list-confirm').click();
  await expect(page.getByTestId('customer-delete-target')).toHaveCount(0);
  await expect(page.getByTestId('customer-keep-other')).toBeVisible();
  expect(deletes).toBe(1);
});
