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

test('critical new Furniture ledger carries the selected canonical customer through save and reopen', async ({ page }) => {
  await mockSession(page, '/notebook/furniture-quotations', false);
  await page.addInitScript(() => localStorage.setItem('forge.active-floor',JSON.stringify('third-floor')));
  await page.route('**/api/customers',route=>route.fulfill({json:[{id:'linked-customer',name:'Linked showroom customer',phone:'9876543210'}]}));
  let saved: any;
  await page.route('**/api/furniture-quotations',route=>{
    if (route.request().method() === 'POST') {
      const body=route.request().postDataJSON();
      expect(body.customer_id).toBe('linked-customer');
      saved={...body,id:'saved-linked',floor_id:'third-floor',revision:1,created_at:'2026-10-24T00:00:00Z',updated_at:'2026-10-24T00:00:00Z',total_payable_rmb:'100.00',total_received_rmb:'0.00',balance_rmb:'100.00'};
      return route.fulfill({json:saved});
    }
    return route.fulfill({json:{rows:saved?[saved]:[],next_cursor:null}});
  });
  await page.route('**/api/furniture-quotations/saved-linked',route=>route.fulfill({json:saved}));
  await page.route('**/api/whatsapp/configuration',route=>route.fulfill({json:{configured:false}}));
  await page.goto('/notebook/furniture-quotations');
  await page.getByRole('button',{name:'New RNB quotation',exact:true}).click();
  await page.getByRole('button',{name:'Link customer profile',exact:true}).click();
  await page.getByRole('button',{name:'Linked showroom customer · 9876543210',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Customer name / quotation heading (RDCL)',exact:true})).toHaveValue('Linked showroom customer');
  await expect(page.getByRole('textbox',{name:'Customer WhatsApp mobile',exact:true})).toHaveValue('9876543210');
  await page.getByRole('textbox',{name:'Charge 1 RNB',exact:true}).fill('100');
  await page.getByRole('button',{name:'Remove charge 2',exact:true}).click();
  await page.getByRole('button',{name:'Save quotation',exact:true}).click();
  await expect(page.getByRole('button',{name:'Reload saved quotation',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Quotation list',exact:true}).click();
  await page.getByRole('button',{name:'Open Linked showroom customer',exact:true}).click();
  await expect(page.getByRole('button',{name:'Change linked customer',exact:true})).toBeVisible();
});
