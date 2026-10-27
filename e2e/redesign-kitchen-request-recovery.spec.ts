import {expect,test} from '@playwright/test';
import {mockSession} from './audit-fixtures';

for(const [stage,target] of [['quotation','order'],['order','production'],['production','installation']] as const) {
 test(`Kitchen ${stage} opens after a dropped read and Next reuses its receipt after a lost response`,async({page})=>{
  await mockSession(page,`/kitchen/network-project/stages/${stage}`,false,{floorId:'second-floor'});
  let project:any={id:'network-project',reference:'KIT-NETWORK',project_reference:'KIT-NETWORK',customer_id:'customer',customer:{id:'customer',name:'Synthetic connection customer',phone:'9000000001'},version:1,workflow_cycle:1,stage,status:'Pending',lifecycle_status:'Active',lead:{status:'Qualified',site_location:'Synthetic site'},visit:{status:'Visited'},cad:{received:true,progress:100,ready:true,status:'Completed'},production:{status:'Not Started',start_date:null,completion_date:null,notes:null},installation:{status:'Not Started',start_date:null,completion_date:null,notes:null},design_versions:[],quotation_versions:[],orders:[],approvals:[],assignments:{},exceptions:[],activity:[],attachments:[],blocked_transitions:[],permissions:{can_update:true,can_assign:true,can_approve_exceptions:true}};
  const writes:any[]=[];let reads=0;
  await page.route('**/api/kitchen-projects**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   if(path.endsWith('/configuration'))return route.fulfill({json:{version:1,department_manager_user_ids:[],files:{}}});
   if(request.method()==='POST'){
    const body=request.postDataJSON();writes.push(body);expect(body.command).toBe('move_stage');expect(body.payload).toEqual({target_stage:target});
    if(writes.length===1){project={...project,stage:target,version:2};return route.abort('failed');}
    expect(body).toEqual(writes[0]);return route.fulfill({json:{...project,replayed:true}});
   }
   if(path==='/api/kitchen-projects/network-project'){
    reads++;if(reads===1)return route.abort('failed');return route.fulfill({json:project});
   }
   return route.fulfill({json:{rows:[],total:0,page:1,limit:25}});
  });
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`/kitchen/network-project/stages/${stage}`);
  await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();expect(reads).toBe(2);
  await expect(page.getByTestId('kitchen-project-actions')).toBeVisible();
  if(stage==='order')await expect(page.getByTestId('kitchen-disclose-order-details')).toHaveCount(0);
  await page.getByTestId(`kitchen-advance-${target}`).click();
  await expect(page.getByText('Could not save',{exact:true})).toBeVisible();
  expect(writes).toHaveLength(1);await expect(page.getByTestId(`kitchen-advance-${target}`)).toBeEnabled();
  await page.getByTestId(`kitchen-advance-${target}`).click();
  await expect(page).toHaveURL(new RegExp(`/stages/${target}(?:\\?|$)`));
  await expect(page.getByText('Could not save',{exact:true})).toHaveCount(0);
  expect(writes).toHaveLength(2);expect(writes[0].idempotency_key).toBeTruthy();expect(writes[1].idempotency_key).toBe(writes[0].idempotency_key);expect(project.version).toBe(2);expect(errors).toEqual([]);
 });
}
