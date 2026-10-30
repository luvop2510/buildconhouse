import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { analyticsDashboard, mockSalesAnalytics } from './sales-analytics-fixtures';
import { analyticsExplore, analyticsFitsViewport } from './sales-analytics-helpers';
import { captureRuntimeHealth } from './runtime-health';

// Display fixtures are isolated from production. These captures document layout,
// not business claims; no fixture value is ever shipped to the application.
test('sales layout directory at compact tablet and desktop widths', async ({ page }, info) => {
 const health=captureRuntimeHealth(page);
 await mockSalesAnalytics(page);
 const directory=resolve(process.env.SALES_CAPTURE_DIR||'output/sales-redesign/after',info.project.name);
 await mkdir(directory,{recursive:true});
 for(const [name,path] of [
  ['overview','/sales-data'],['companies','/sales-data/companies'],['products','/sales-data/products'],
  ['architects','/sales-data/architects'],['customers','/sales-data/customers'],['reports','/sales-data/reports'],
  ['data-quality','/sales-data/data-quality'],['references','/sales-data/relationships'],
  ['company-profile','/sales-data/profile/companies/company-a?floor_id=first-floor'],
  ['product-profile','/sales-data/profile/products/product-a?floor_id=first-floor'],
  ['customer-profile','/sales-data/profile/customers/customer-a?floor_id=first-floor'],
  ['architect-profile','/sales-data/profile/architects/architect-a?floor_id=first-floor'],
  ['order','/sales-data/order/order-a?floor_id=first-floor'],
  ['reference-profile','/sales-data/referrer/architect-a?floorId=first-floor&preset=this_month'],
  ['people-profile','/sales-data/people/salespeople/person-a?floor_id=first-floor&preset=this_month'],
 ]) {
  await page.goto(path);
  await expect(page.getByTestId('analytics-navigation')).toBeVisible();
  if(name==='overview')await expect(page.getByTestId('analytics-kpi-sales')).toContainText('₹3,00,000.5');
  else if(['company-profile','product-profile','customer-profile','architect-profile'].includes(name))await expect(page.getByTestId('analytics-export')).toBeVisible();
  else if(name==='references')await expect(page.getByTestId('reference-row-architect-a')).toContainText('Nisha Shah');
  else if(name==='reference-profile')await expect(page.getByTestId('referrer-quote-row-order-a')).toBeVisible();
  else if(name==='people-profile')await expect(page.getByTestId('people-brand-company-a')).toBeVisible();
  else if(name==='order')await expect(page.getByText('Talis basin mixer',{exact:true})).toBeVisible();
  else if(name==='data-quality')await expect(page.getByTestId('analytics-duplicate-duplicate-customers')).toBeVisible();
  else if(['companies','products','customers','architects'].includes(name))await expect(page.getByTestId(`analytics-entity-${({companies:'company-a',products:'product-a',customers:'customer-a',architects:'architect-a'} as Record<string,string>)[name]}`)).toBeVisible();
  if(!process.env.SALES_CAPTURE_ONLY)await analyticsFitsViewport(page);
  await page.screenshot({path:resolve(directory,`${name}.png`),fullPage:true});
  if(name==='overview'&&!process.env.SALES_CAPTURE_ONLY){
   for(const [part,selector] of [['trend','analytics-bento-revenue'],['metrics','analytics-kpis'],['contribution','analytics-bento-contribution'],['activity','analytics-order-activity']]){
    const panel=page.getByTestId(selector);await panel.scrollIntoViewIfNeeded();await panel.screenshot({path:resolve(directory,`graph-${part}.png`)});
   }
  }
 }
 await health.assertHealthy();
});

test('first load shows skeletons while same-scope refresh keeps recorded values visible',async({page},info)=>{
 let release:()=>void=()=>{};
 let blocked=new Promise<void>(resolve=>{release=resolve;});
 await mockSalesAnalytics(page,{dashboard:async route=>{await blocked;await route.fulfill({json:analyticsDashboard('first-floor')});}});
 await page.goto('/sales-data?floor_id=first-floor');
 await expect(page.getByRole('heading',{name:'Sanitary / Bathroom overview',exact:true})).toBeVisible();
 await expect(page.getByTestId('analytics-skeleton-dashboard')).toBeVisible();
 await expect(page.getByTestId('analytics-kpi-sales')).toHaveCount(0);
 await page.screenshot({path:info.outputPath('initial-skeleton.png')});
 release();
 await expect(page.getByTestId('analytics-kpi-sales')).toContainText('₹2,40,000');
 blocked=new Promise<void>(resolve=>{release=resolve;});
 await page.getByRole('button',{name:'Refresh sales analytics',exact:true}).click();
 await expect(page.getByTestId('analytics-refreshing').first()).toBeVisible();
 await expect(page.getByTestId('analytics-kpi-sales')).toContainText('₹2,40,000');
 await expect(page.getByTestId('analytics-skeleton-dashboard')).toHaveCount(0);
 release();
 await expect(page.getByRole('button',{name:'Refresh sales analytics',exact:true})).toBeEnabled();
});

test('recently visited directory appears instantly while revalidating without another skeleton',async({page})=>{
 await mockSalesAnalytics(page);
 await page.goto('/sales-data/companies?floor_id=first-floor');
 await expect(page.getByTestId('analytics-entity-company-a')).toContainText('Hansgrohe');
 await analyticsExplore(page,'products');
 await expect(page.getByTestId('analytics-entity-product-a')).toBeVisible();
 let release:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/sales-analytics/entities/companies?**',async route=>{await gate;await route.fulfill({json:{items:analyticsDashboard('first-floor').companies,total:1,page:1,page_size:25}});});
 await analyticsExplore(page,'companies');
 await expect(page.getByTestId('analytics-entity-company-a')).toContainText('Hansgrohe');
 await expect(page.getByTestId('analytics-refreshing')).toBeVisible();
 await expect(page.getByTestId('analytics-skeleton-list')).toHaveCount(0);
 release();
});
