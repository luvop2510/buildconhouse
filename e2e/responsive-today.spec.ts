import { expect, test } from '@playwright/test';
import { mockSession } from './audit-fixtures';
import { todayFixture, mockTodayOverview } from './today-fixtures';
import { captureRuntimeHealth } from './runtime-health';

for (const role of ['owner','manager','worker']) test(`Today shows the correct ${role} viewpoint`, async ({ page }, info) => {
  const health = captureRuntimeHealth(page);
  const grants = [{resource:'followups',floor_id:'first-floor',actions:['view']}];
  await mockSession(page, '/dashboard', false, { staff: { id:'fixture-viewer', full_name:'Fixture Viewer', role, active:true,
    floor_ids:['first-floor'], ...(role === 'worker' ? {custom_access:true,access_grants:grants} : {}) }, grants });
  const paths: string[] = [];
  page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/')) paths.push(path); });
  await mockTodayOverview(page);
  await page.route('**/api/dashboard/today', route => {
    expect(route.request().headers()['x-floor-id']).toBe('first-floor');
    return route.fulfill({json:todayFixture('first-floor',role !== 'worker')});
  });
  await page.goto('/dashboard');
  await expect(page.getByText('Scheduled work & tasks', {exact:true})).toBeVisible();
  await expect(page.getByText('First fixture customer', {exact:true})).toBeVisible();
  await expect(page.getByTestId('today-urgency-meter')).toHaveAttribute('aria-valuenow', '50');
  await expect(page.getByTestId('today-task-summary')).toContainText('Completed today');
  await expect(page.getByTestId('today-floor-overview')).toHaveCount(role === 'worker' ? 0 : 1);
  if (role !== 'worker') await expect(page.getByTestId('today-workflow-quotations')).toContainText('ordered');
  const salesNav = page.getByTestId('nav-sales-data');
  if (role !== 'owner') await expect(salesNav).toHaveCount(0);
  expect(paths.some(path => /sales-analytics|sales-data|dashboard\/stats/.test(path))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await health.assertHealthy();
  await page.screenshot({path:info.outputPath(`today-${role}.png`),fullPage:true});
});

test('a non-owner bookmarked sales page returns to safe Today before any analysis read', async ({page}) => {
  await mockSession(page, '/sales-data', false, {staff:{id:'fixture-manager',full_name:'Fixture Manager',role:'manager',active:true,floor_ids:['first-floor']}});
  const protectedReads:string[]=[];
  page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/sales-'))protectedReads.push(request.url());});
  await mockTodayOverview(page);
  await page.route('**/api/dashboard/today', route=>route.fulfill({json:todayFixture()}));
  await page.goto('/sales-data/profile/products/example');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText('First fixture customer',{exact:true})).toBeVisible();
  expect(protectedReads).toEqual([]);
});

test('refresh failure preserves floor work and explicitly recovers',async({page})=>{
  await mockSession(page,'/dashboard',false);
  let fail=false;
  await mockTodayOverview(page);
  await page.route('**/api/dashboard/today',route=>fail?route.fulfill({status:503,json:{detail:'Floor work is temporarily unavailable'}}):route.fulfill({json:todayFixture()}));
  await page.goto('/dashboard');
  await expect(page.getByText('First fixture customer',{exact:true})).toBeVisible();
  fail=true;
  await page.getByRole('button',{name:'Refresh floor work',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Floor work is temporarily unavailable');
  await expect(page.getByText('First fixture customer',{exact:true})).toBeVisible();
  fail=false;
  await page.getByRole('button',{name:'Retry floor work',exact:true}).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('tasks render while optional floor totals are still pending',async({page})=>{
  await mockSession(page,'/dashboard',false);
  const data=todayFixture();
  data.payments=null;data.workflows=[];
  await page.route('**/api/dashboard/today',route=>route.fulfill({json:data}));
  let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/dashboard/today/overview',async route=>{
    await pending;
    const overview=todayFixture();
    await route.fulfill({json:{floor_id:overview.floor_id,payments:overview.payments,workflows:overview.workflows}});
  });
  try {
    await page.goto('/dashboard');
    await expect(page.getByText('First fixture customer',{exact:true})).toBeVisible();
    await expect(page.getByText('Updating floor totals…',{exact:true})).toBeVisible();
    await expect(page.getByText('Floor payments',{exact:true})).toHaveCount(0);
    release();
    await expect(page.getByText('Floor payments',{exact:true})).toBeVisible();
  } finally {release();}
});

test('a first-load error stops task skeletons and offers retry',async({page})=>{
  await mockSession(page,'/dashboard',false);
  await page.route('**/api/dashboard/today',route=>route.fulfill({status:503,json:{detail:'Fixture floor read failed'}}));
  await page.goto('/dashboard');
  await expect(page.getByRole('alert')).toContainText('Fixture floor read failed');
  await expect(page.getByLabel('Loading floor tasks')).toHaveCount(0);
  await expect(page.getByText('Tasks are unavailable.',{exact:true})).toBeVisible();
});

test('Kitchen Today opens assigned work from visible navigation', async ({page}, info) => {
  const health = captureRuntimeHealth(page);
  await mockSession(page, '/settings', false, {floorId:'second-floor',staff:{id:'kitchen-worker',full_name:'Kitchen Worker',role:'sales',active:true,floor_ids:['second-floor']}});
  const kitchen = {...todayFixture('second-floor',false),floor_name:'Kitchen',resources:['kitchen_projects'],
    tasks:[{id:'assigned-cad',resource:'kitchen_projects',title:'Assigned Kitchen customer',status:'cad',due_at:'2026-10-29T08:00:00Z',updated_at:null,assignee_name:'Kitchen Worker',href:'/kitchen/assigned-cad/stages/cad',progress:43}]};
  let empty = false;
  await page.route('**/api/dashboard/today',route=>{
    expect(route.request().headers()['x-floor-id']).toBe('second-floor');
    return route.fulfill({json:empty ? {...kitchen,tasks:[],task_summary:{open:0,due_today:0,overdue:0,completed_today:0}} : kitchen});
  });
  await page.goto('/settings');
  const phone = (page.viewportSize()?.width || 1440) < 768;
  await page.getByTestId(phone ? 'bottom-nav-dashboard' : 'nav-dashboard').click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText('Your assigned Kitchen tasks and recorded progress',{exact:true})).toBeVisible();
  await expect(page.getByText('Assigned Kitchen customer',{exact:true})).toBeVisible();
  await expect(page.getByText('43% recorded progress',{exact:true})).toBeVisible();
  await expect(page.getByTestId('today-floor-overview')).toHaveCount(0);
  await page.screenshot({path:info.outputPath('kitchen-today-assigned.png'),fullPage:true});
  empty = true;
  await page.getByRole('button',{name:'Refresh floor work',exact:true}).click();
  await expect(page.getByText('No open Kitchen tasks assigned to you.',{exact:true})).toBeVisible();
  empty = false;
  await page.getByRole('button',{name:'Refresh floor work',exact:true}).click();
  await expect(page.getByText('Assigned Kitchen customer',{exact:true})).toBeVisible();
  await page.getByTestId('today-task-kitchen_projects-assigned-cad').click();
  await expect(page).toHaveURL(/\/kitchen\/assigned-cad\/stages\/cad$/);
  await health.assertHealthy();
});
