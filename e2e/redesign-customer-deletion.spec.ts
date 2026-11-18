import { test, expect } from '@playwright/test';
import { mockSession } from './audit-fixtures';

test('critical customer deletion requires named review and keeps other customers', async ({ page }) => {
  await mockSession(page, '/customers', false);
  let deleted = false;
  await page.route('**/api/customers?**', route => route.fulfill({json: (deleted ? [
    {id:'keep-other',name:'Other Buyer',company:'Other Buyer',phone:'9000000001'},
  ] : [
    {id:'delete-target',name:'Synthetic Buyer',company:'Synthetic Buyer',phone:'9000000000'},
    {id:'keep-other',name:'Other Buyer',company:'Other Buyer',phone:'9000000001'},
  ])}));
  await page.route("**/api/customers/delete-target/deletion-preview?**", route => route.fulfill({json:{customer_id:"delete-target",confirmation:"a".repeat(64),counts:{customers:1},shared_records_preserved:0,private_files:0}}));
  let deletes = 0;
  await page.route(/\/api\/customers\/delete-target(?:\?.*)?$/, route => {
    expect(route.request().method()).toBe('DELETE');
    expect(new URL(route.request().url()).searchParams.get('confirmation')).toBe('a'.repeat(64));
    deletes++; deleted = true;
    return route.fulfill({json:{ok:true}});
  });
  await page.goto('/customers');
  await page.getByTestId('delete-customer-delete-target').click();
  await expect(page.getByTestId('confirm-delete-customer-list')).toBeVisible();
  await expect(page.getByTestId('confirm-delete-customer-list').getByText('Synthetic Buyer', {exact:true})).toBeVisible();
  expect(deletes).toBe(0);
  await page.getByTestId('confirm-delete-customer-list-confirm').click();
  await expect(page.getByTestId('customer-delete-target')).toHaveCount(0);
  await expect(page.getByTestId('customer-keep-other')).toBeVisible();
  expect(deletes).toBe(1);
});

test('critical Edit Customer uses the same named and signed deletion review', async ({ page }) => {
  await mockSession(page, '/customers/edit-target/edit', false, { floorId: 'ground-floor' });
  const customer = { id: 'edit-target', name: 'Synthetic edit customer', floor_id: 'ground-floor', portal_enabled: false };
  const token = 'b'.repeat(64);
  let deletes = 0;
  await page.route('**/api/customers/edit-target/deletion-preview?**', route => route.fulfill({ json: {
    customer_id: customer.id, confirmation: token, counts: { customers: 1 }, shared_records_preserved: 0, private_files: 0,
  } }));
  await page.route(/\/api\/customers\/edit-target(?:\?.*)?$/, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: customer });
    expect(route.request().method()).toBe('DELETE');
    expect(new URL(route.request().url()).searchParams.get('confirmation')).toBe(token);
    expect(route.request().headers()['x-floor-id']).toBe('ground-floor');
    deletes++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/customers?**', route => route.fulfill({ json: deletes ? [] : [customer] }));
  await page.goto('/customers/edit-target/edit');
  await page.getByTestId('delete-customer-edit').click();
  const dialog = page.getByTestId('confirm-delete-customer-list');
  await expect(dialog).toContainText(customer.name);
  expect(deletes).toBe(0);
  await dialog.getByTestId('confirm-delete-customer-list-confirm').click();
  await expect(page).toHaveURL(/\/customers$/);
  await page.reload();
  await expect(page.getByTestId('customer-edit-target')).toHaveCount(0);
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

for (const allowed of [false, true]) test(`critical employee customer deletion controls follow explicit permission ${allowed}`, async ({ page }) => {
  await mockSession(page, '/customers', false, { floorId: 'first-floor', staff: {
    id: 'delete-employee', email: 'employee@example.invalid', full_name: 'Delete employee',
    role: 'sales', active: true, custom_access: false, floor_ids: ['first-floor'],
  } });
  await page.route('**/api/settings/permission-matrix/customer-deletion-access', route => route.fulfill({ json: { allowed } }));
  await page.route('**/api/customers?**', route => route.fulfill({ json: [
    { id: 'permission-buyer', name: 'Permission buyer', floor_id: 'first-floor', phone: '9000000000' },
  ] }));
  await page.goto('/customers');
  await expect(page.getByTestId('customer-permission-buyer')).toBeVisible();
  await expect(page.getByTestId('delete-customer-permission-buyer')).toHaveCount(allowed ? 1 : 0);
  await expect(page.getByTestId('reset-floor-customer-data')).toHaveCount(0);
});
