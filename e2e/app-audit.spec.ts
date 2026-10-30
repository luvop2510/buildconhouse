import {expect,test} from '@playwright/test';
import {mockSession} from './audit-fixtures';
import {mockSalesAnalytics} from './sales-analytics-fixtures';
import {analyticsCustomRange} from './sales-analytics-helpers';
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
 await mockSalesAnalytics(page);
 await page.goto('/sales-data');
 await expect(page.getByTestId('analytics-kpis')).toContainText('3');
 await page.getByTestId('analytics-navigation-open').click();
 await page.getByTestId('analytics-nav-companies').click();
 await expect(page.getByTestId('analytics-entity-company-a')).toContainText('Hansgrohe');
 await page.getByTestId('analytics-navigation-open').click();
 await page.getByTestId('analytics-nav-products').click();
 await expect(page.getByTestId('analytics-entity-product-a')).toContainText('Talis basin mixer');
 await page.getByTestId('analytics-nav-dashboard').click();
 await expect(page.getByTestId('analytics-kpi-orders')).toContainText('3');
 await analyticsCustomRange(page, '2026-09-17', '2026-09-03');
 await page.getByTestId('analytics-filter-apply').click();
 await expect(page.getByRole('alert')).toContainText(/valid|after/i);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.screenshot({path:info.outputPath('sales-fixture.png'),fullPage:true});
});
