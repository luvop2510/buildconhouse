import {expect,test} from '@playwright/test';
import {mockSession} from './audit-fixtures';
import {mockSalesSummary} from './sales-fixtures';
import {stabilityRoutes,stabilityRouteTitle} from '../scripts/stability-routes';
import {captureRuntimeHealth} from './runtime-health';
const routes=stabilityRoutes();
for(const path of routes){
 test(stabilityRouteTitle(path),async({page},info)=>{
  const health=captureRuntimeHealth(page);
  await mockSession(page,path);
  await page.goto(path);
  await expect(page.locator('body')).not.toContainText('Unmatched Route');
  await expect.poll(()=>page.locator('body').innerText()).toMatch(/[A-Za-z]{4}/);
  const redirect = ({ '/reports': '/dashboard', '/purchase-orders': '/purchases', '/notebook/kitchen/followups': '/walkins' } as Record<string, string>)[path];
  if (redirect) await expect(page).toHaveURL(new RegExp(`${redirect}$`));
  // Let bounded API retries settle before capturing the terminal data state.
  await page.waitForTimeout(1600);
  await health.assertHealthy();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath('page.png'),fullPage:true});
 });
}
test('login validation and accessible input labels',async({page},info)=>{
 await page.goto('/login');
 await expect(page.getByRole('textbox',{name:'Email or username',exact:true})).toBeVisible();
 await page.getByTestId('login-submit').click();
 await expect(page.getByRole('alert')).toHaveText('Enter your email or username and password.');
 await page.getByTestId('login-mode-customer').click();
 await expect(page.getByRole('textbox',{name:'Email',exact:true})).toBeVisible();
 await page.getByTestId('login-submit').click();
 await expect(page.getByRole('alert')).toHaveText('Enter your email and password.');
 await page.getByTestId('login-mode-staff').click();
 await expect(page.getByRole('textbox',{name:'Email or username',exact:true})).toBeVisible();
 await page.screenshot({path:info.outputPath('login.png'),fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
test('critical customer request failure retries into honest empty state',async({page})=>{
 await mockSession(page,'/customers');await page.goto('/customers');
 await expect(page.getByText("Couldn't load customers",{exact:true})).toBeVisible();
 await page.route(/\/api\/customers(?:\?|$)/,r=>r.fulfill({json:[]}));
 await page.getByRole('button',{name:/try again/i}).click();
 await expect(page.getByText('No customers yet',{exact:true})).toBeVisible();
});

test('critical Sales Data keeps product evidence and validates dates',async({page},info)=>{
 await mockSalesSummary(page);
 await page.goto('/sales-data');
 await expect(page.getByTestId('sales-data-kpis')).toContainText('12');
 await expect(page.getByTestId('sales-brands')).toContainText('Hansgrohe');
 await expect(page.getByTestId('sales-products')).toContainText('Talis basin mixer');
 const filters=page.getByTestId('sales-data-filters');
 const toggle=page.getByTestId('sales-data-filters-toggle');
 if(await toggle.getAttribute('aria-expanded')==='false') await toggle.click();
 await page.getByTestId('sales-data-period-picker').click();
 await page.getByRole('dialog',{name:'Reporting period',exact:true}).getByRole('button',{name:'Custom range',exact:true}).click();
 await filters.getByLabel('From',{exact:true}).fill('2026-02-30');
 await filters.getByLabel('To',{exact:true}).fill('2026-03-01');
 await filters.getByRole('button',{name:'Apply range',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Enter valid dates');
 await filters.getByRole('button',{name:'Cancel',exact:true}).click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.screenshot({path:info.outputPath('sales-fixture.png'),fullPage:true});
});
