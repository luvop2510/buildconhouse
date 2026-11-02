import { test, expect } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical customer deletes immediately without review and keeps other customers', async ({ page }) => {
  await mockSession(page, '/customers', false);
  await page.route('**/api/customers?**', route => route.fulfill({json: [
    {id:'delete-target',name:'Synthetic Buyer',company:'Synthetic Buyer',phone:'9000000000'},
    {id:'keep-other',name:'Other Buyer',company:'Other Buyer',phone:'9000000001'},
  ]}));
  let deletes = 0;
  await page.route(/\/api\/customers\/delete-target(?:\?.*)?$/, route => {
    expect(route.request().method()).toBe('DELETE');
    expect(new URL(route.request().url()).searchParams.has('confirmation')).toBe(false);
    deletes++;
    return route.fulfill({json:{ok:true}});
  });
  await page.goto('/customers');
  await page.getByTestId('delete-customer-delete-target').click();
  await expect(page.getByTestId('customer-delete-target')).toHaveCount(0);
  await expect(page.getByTestId('customer-keep-other')).toBeVisible();
  expect(deletes).toBe(1);
});

for (const floor of ['first-floor', 'ground-floor']) test(`critical ${floor} customer reset sends one stable command and reloads the list`, async ({ page }) => {
  await mockSession(page, '/customers', false, { floorId: floor });
  let reset = false;
  let commands = 0;
  await page.route('**/api/customers?**', route => route.fulfill({json:reset ? [] : [{id:'buyer',name:'Buyer',phone:'9000000000'}]}));
  await page.route('**/api/customers/floor-reset', route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-floor-id']).toBe(floor);
    expect(route.request().postDataJSON().request_id).toMatch(/^[0-9a-f-]{36}$/);
    commands++; reset = true;
    return route.fulfill({json:{ok:true}});
  });
  await page.goto('/customers');
  await page.getByTestId('reset-floor-customer-data').click();
  await expect(page.getByTestId('customer-buyer')).toHaveCount(0);
  expect(commands).toBe(1);
});

for (const floor of ['second-floor', 'third-floor']) test(`critical ${floor} does not receive the new reset action`, async ({ page }) => {
  await mockSession(page, '/customers', false, { floorId: floor });
  await page.goto('/customers');
  await expect(page.getByTestId('reset-floor-customer-data')).toHaveCount(0);
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
  await page.route(/\/api\/furniture-quotations\/saved-linked(?:\?.*)?$/,route=>route.fulfill({json:saved}));
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
  await expect(page.getByRole('textbox',{name:'Customer name / quotation heading (RDCL)',exact:true})).toHaveValue('Linked showroom customer');
  await expect(page.getByRole('textbox',{name:'Customer WhatsApp mobile',exact:true})).toHaveValue('9876543210');
});
