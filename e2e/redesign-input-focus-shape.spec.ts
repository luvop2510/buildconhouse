import {expect,test} from '@playwright/test';
import {mockSession} from './audit-fixtures';
for(const kind of ['text','textarea','search','kitchen','purchases','catalog'] as const) test(`focused ${kind} indicator follows its outer field shape`,async({page},info)=>{
 const path=kind==='purchases'?'/purchases':kind==='catalog'?'/catalog':kind==='search'?'/customers':kind==='kitchen'?'/kitchen/stages/lead?create=1':'/customers/new';
 await mockSession(page,path,false,{floorId:kind==='kitchen'?'second-floor':'first-floor'});
 await page.route('**/api/referrers**',r=>r.fulfill({json:[]}));
 if(kind==='search')await page.route('**/api/customers?**',r=>r.fulfill({json:[]}));
 if(kind==='kitchen')await page.route('**/api/kitchen-projects**',r=>r.fulfill({json:{rows:[],version:1,files:{},department_manager_user_ids:[]}}));
 if(kind==='purchases')await page.route('**/api/purchases/**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({json:path.endsWith('/brands')?{all:0,brands:[]}:path.endsWith('/page')?{items:[],total:0,next_skip:null,summaries:{blocked_count:0,sla_days:7,stage_counts:{}}}:path.endsWith('/shortages')?{items:[]}:[]});});
 if(kind==='catalog')await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;const replies:Record<string,unknown>={'/api/brands':[],'/api/categories':[],'/api/catalog/facets':{},'/api/catalog/hierarchy':{tree:[]},'/api/products/families':{total:0,items:[]},'/api/products':{total:0,items:[]}};return Object.hasOwn(replies,path)?route.fulfill({json:replies[path]}):route.fallback();});
 await page.goto(path);
 let input=page.getByTestId(kind==='purchases'?'purchases-search':kind==='catalog'?'catalog-search':kind==='search'?'customers-search':kind==='kitchen'?'kitchen-customer-name':'new-customer-name');
 if(kind==='textarea'){await page.getByRole('button',{name:'Additional customer details',exact:true}).click();input=page.getByTestId('new-customer-address');}
 await input.focus();await page.keyboard.type('Shape test');
 await expect(input).toBeFocused();
 const shape=await input.evaluate(element=>{const shell=element.closest('[data-field-shell="true"]');if(!shell)return null;const outer=getComputedStyle(shell),inner=getComputedStyle(element);return {radius:parseFloat(outer.borderTopLeftRadius),shadow:outer.boxShadow,innerOutline:inner.outlineStyle,innerShadow:inner.boxShadow,bounds:shell.getBoundingClientRect().toJSON()};});
 expect(shape).not.toBeNull();expect(shape!.radius).toBeGreaterThan(0);expect(shape!.shadow).not.toBe('none');expect(shape!.innerOutline).toBe('none');expect(shape!.innerShadow).toBe('none');
 await page.screenshot({path:info.outputPath('rounded-focus.png')});
 if(kind==='text'){
  await page.emulateMedia({forcedColors:'active'});
  await expect.poll(()=>input.evaluate(element=>getComputedStyle(element.closest('[data-field-shell="true"]')!).outlineStyle)).toBe('solid');
 }
});
