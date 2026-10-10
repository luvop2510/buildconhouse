import type { Page } from '@playwright/test';
export const floors = [{id:'first-floor',name:'The Sanitary Bathroom',slug:'first-floor'},{id:'ground-floor',name:'Tiles',slug:'ground-floor'},{id:'second-floor',name:'Kitchen',slug:'second-floor'},{id:'third-floor',name:'Furniture',slug:'third-floor'}];
type SessionOptions = {
  signedIn?: boolean;
  staff?: Record<string, unknown>;
  grants?: unknown[];
  floorAccess?: { all_floors: boolean; floors: typeof floors; floor_ids: string[] };
};
export async function mockSession(page: Page, path: string, failures = true, options: SessionOptions = {}) {
  const customer = path.startsWith('/home') || path.startsWith('/quotes');
  await page.addInitScript(({customer, floor, signedIn}) => {
    if (signedIn === false) localStorage.removeItem("forge.jwt.kind");
    else localStorage.setItem('forge.jwt.kind', JSON.stringify(customer ? 'customer' : 'staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify(floor));
  }, {customer, floor:path.startsWith('/tiles')?'ground-floor':'first-floor', signedIn: options.signedIn});
  await page.route('**/api/**', async route => {
    const p = new URL(route.request().url()).pathname;
    let body: unknown;
    if (p === '/api/auth/me') body=options.staff || {id:'audit-owner',email:'owner@example.test',full_name:'Audit Owner',role:'owner',active:true,floor_ids:floors.map(f=>f.id)};
    else if (p === '/api/auth/customer/me') body={id:'audit-customer',email:'customer@example.test',name:'Audit Customer',tier:'retail',portal_enabled:true};
    else if(p==='/api/settings/floor-access') body=options.floorAccess || {all_floors:true,floors,floor_ids:floors.map(f=>f.id)};
    else if(p==='/api/settings/access-grants/me' && options.grants !== undefined) body={grants:options.grants};
    else if(p==='/api/settings/permission-matrix') body={modules:[],roles:[],matrix:{owner:{}}};
    else if(p==='/api/settings/roles') body=[];
    else if(!failures && p==='/api/customers') body=[];
    else if(!failures && p==='/api/auth/sessions') body=[];
    else if(!failures && p==='/api/notifications') body=[];
    else if(!failures && p==='/api/portal/quotations') body=[];
    else return route.fulfill({status:503,json:{detail:'Service temporarily unavailable. Please retry.'}});
    return route.fulfill({json:body});
  });
}
