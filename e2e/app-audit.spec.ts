import {expect,test} from '@playwright/test';
import {readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {mockSession} from './audit-fixtures';
const app=join(process.cwd(),'app');
function files(dir:string):string[]{return readdirSync(dir,{withFileTypes:true}).flatMap(f=>f.isDirectory()?files(join(dir,f.name)):[join(dir,f.name)]);}
const routes=[...new Set(files(app).filter(f=>f.endsWith('.tsx')&&!/\/_|\/\+/.test(f)&&!f.endsWith('.web.tsx')).map(f=>'/'+relative(app,f).replace(/\([^/]+\)\//g,'').replace(/\.tsx$/,'').replace(/(^|\/)index$/,'').replace(/\/$/,'').replace('[floor]','kitchen').replace('[view]','followups').replace('[kind]','salespeople').replace(/\[[^\]]+\]/g,'audit-record')).filter(p=>p!=='/'&&!p.includes('set-new-password')&&p!=='/login'))];
const critical=new Set(['/purchases','/tiles/orders','/tiles/quotation','/quotations/new','/sales-data','/followups']);
for(const path of routes){
 test(`${critical.has(path)?'critical ':''}${path} handles unavailable data and fits viewport`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await mockSession(page,path);
  await page.goto(path);
  await expect(page.locator('body')).not.toContainText('Unmatched Route');
  await expect.poll(()=>page.locator('body').innerText()).toMatch(/[A-Za-z]{4}/);
  const redirect = ({ '/reports': '/dashboard', '/purchase-orders': '/purchases', '/notebook/kitchen/followups': '/notebook/kitchen' } as Record<string, string>)[path];
  if (redirect) await expect(page).toHaveURL(new RegExp(`${redirect}$`));
  // Let bounded API retries settle before capturing the terminal data state.
  await page.waitForTimeout(1600);
  expect(errors).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath('page.png'),fullPage:true});
 });
}
test('login validation and accessible input labels',async({page},info)=>{
 await page.goto('/login');
 await expect(page.getByRole('textbox',{name:'Email',exact:true})).toBeVisible();
 await page.getByTestId('login-submit').click();
 await expect(page.getByRole('alert')).toContainText('Enter your email and password');
 await page.screenshot({path:info.outputPath('login.png'),fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
test('critical customer request failure retries into honest empty state',async({page})=>{
 await mockSession(page,'/customers');await page.goto('/customers');
 await expect(page.getByText("Couldn't load customers",{exact:true})).toBeVisible();
 await page.route('**/api/customers',r=>r.fulfill({json:[]}));
 await page.getByRole('button',{name:/try again/i}).click();
 await expect(page.getByText('No customers yet',{exact:true})).toBeVisible();
});

test('critical Sales Data keeps working sections, charts and validates dates',async({page},info)=>{
 await mockSession(page,'/sales-data');
 await page.route('**/api/analytics/**',async route=>{
  const p=new URL(route.request().url()).pathname;
  if(p.endsWith('/default-period')) return route.fulfill({json:{preset:'this_month',date_from:null,date_to:null,label:'This month',fallback_applied:false,latest_order_at:null}});
  if(p.endsWith('/overview')) return route.fulfill({json:{
   kpis:{revenue:240000,orders:12,aov:20000,customers:8,outstanding:{ordered:240000,collected:180000,outstanding:60000},comparison:{delta_pct:20,direction:'up',history_state:'ok'},previous_label:'Previous month',previous_revenue:200000},
   revenue_by_floor:[{floor_id:'first-floor',revenue:240000,orders:12}],attention:[],attention_total:0,opportunities:[],opportunities_total:0,
   period:{start:'2026-09-01T00:00:00+00:00',end:'2026-09-06T00:00:00+00:00',label:'This month'},
  }});
  if(p.endsWith('/revenue-by-brand')) return route.fulfill({status:503,json:{detail:'Brand service unavailable'}});
  if(p.endsWith('/revenue-by-customer')) return route.fulfill({json:{rows:[{customer_id:'fixture-customer',name:'QA Customer',revenue:240000,orders:12,aov:20000,last_order_at:'2026-09-05T12:00:00Z'}]}});
  if(p.endsWith('/revenue-trend')) return route.fulfill({json:{points:[{bucket:'01 Sep',revenue:30000},{bucket:'02 Sep',revenue:70000},{bucket:'03 Sep',revenue:40000},{bucket:'04 Sep',revenue:20000},{bucket:'05 Sep',revenue:80000}]}});
  return route.fulfill({json:{rows:[],total:0}});
 });
 await page.goto('/sales-data');
 await expect(page.getByTestId('sales-data-kpis')).toContainText('12');
 await expect(page.getByText('QA Customer',{exact:true})).toBeVisible();
 await expect(page.getByText('Brand service unavailable',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'01 Sep: ₹30,000',exact:true}).click();
 await expect(page.getByText('01 Sep: ₹30,000',{exact:true})).toBeVisible();
 await page.getByTestId('sales-data-preset').getByText('Custom',{exact:true}).click();
 await page.getByLabel('From',{exact:true}).fill('2026-02-30');
 await page.getByLabel('To',{exact:true}).fill('2026-03-01');
 await page.getByRole('button',{name:'Apply range',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Enter valid dates');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.screenshot({path:info.outputPath('sales-fixture.png'),fullPage:true});
});
