import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';
for (const kind of ['selection', 'quotation']) test(`critical Tile ${kind} explicitly reuses walk-ins and follow-ups across permitted floors`, async ({page}, info) => {
  await mockSession(page, `/tiles/${kind}`, false, {floorId:'ground-floor'});
  await page.route('**/api/quotations/customer-sources?**', route => route.fulfill({json:{items:[
    {source_kind:'walkin',source_id:'lead',floor_id:'first-floor',name:'Walk-in Person',phone:'9876543210',address:'Saved road'},
    {source_kind:'followup',source_id:'follow',floor_id:'third-floor',name:'Follow-up Person',phone:'9876543211',address:'Follow road'},
  ],has_more:false,next_skip:2}}));
  let reuse:any;
  await page.route('**/api/quotations/customer-sources/reuse', route => {
    reuse=route.request().postDataJSON();
    return route.fulfill({json:{created:true,customer:{id:'ground-person',floor_id:'ground-floor',name:'Follow-up Person',phone:'9876543211',address:'Follow road'}}});
  });
  await page.goto(`/tiles/${kind}`);
  await page.getByTestId('tiles-existing-customer').filter({visible:true}).click();
  const dialog=page.getByRole('dialog',{name:'Existing customer',exact:true});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Walk-in Person',{exact:true})).toBeVisible();
  await dialog.getByTestId('tiles-existing-followup-follow').click();
  await expect(dialog).not.toBeVisible();
  expect(reuse).toEqual({source_kind:'followup',source_id:'follow'});
  await expect(page.locator('[data-testid="tiles-customer-name"], [data-testid="mobile-customer-name"]').filter({visible:true})).toHaveValue('Follow-up Person');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath(`${kind}-existing-customer.png`)});
});
