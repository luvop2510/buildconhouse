import {expect,test} from '@playwright/test';
import {mockSession} from './audit-fixtures';

for(const confirmed of [true,false]) for(const [stage,target] of [['visit','cad'],['quotation','order'],['order','production'],['production','installation']] as const) {
 test(`Kitchen ${stage} opens after a dropped read and Next ${confirmed?'confirms a saved stage':'reuses its receipt'} after a lost response`,async({page})=>{
  await mockSession(page,`/kitchen/network-project/stages/${stage}`,false,{floorId:'second-floor'});
  let project:any={id:'network-project',reference:'KIT-NETWORK',project_reference:'KIT-NETWORK',customer_id:'customer',customer:{id:'customer',name:'Synthetic connection customer',phone:'9000000001'},version:1,workflow_cycle:1,stage,status:'Pending',lifecycle_status:'Active',lead:{status:'Qualified',site_location:'Synthetic site'},visit:{status:'Visited'},cad:{received:true,progress:100,ready:true,status:'Completed'},production:{status:'Not Started',start_date:null,completion_date:null,notes:null},installation:{status:'Not Started',start_date:null,completion_date:null,notes:null},design_versions:[],quotation_versions:[],orders:[],approvals:[],assignments:{},exceptions:[],activity:[],attachments:[],blocked_transitions:[],permissions:{can_update:true,can_assign:true,can_approve_exceptions:true}};
  // Receipt recovery needs a valid commercial basis now that Next enforces PDF selection.
  const design={id:'network-design',number:1,workflow_cycle:1,response:'Approved',shared_date:'2026-10-28',approval_date:'2026-10-28',handoff_status:'Yes',handoff_date:'2026-10-28',attachment_ids:['network-design-pdf'],final_attachment_id:'network-design-pdf',upload_date:'2026-10-28'};
  const quote={id:'network-quote',number:1,workflow_cycle:1,response:'Approved',design_version_id:design.id,shared_date:'2026-10-28',sent_status:'Yes',received_status:'Yes',received_date:'2026-10-28',pdf_options:[{attachment_id:'network-quote-pdf',kitchen_type:'GI'}],final_attachment_id:'network-quote-pdf',kitchen_type:'GI',upload_date:'2026-10-28'};
  project={...project,final_design_version_id:design.id,design_versions:[design],quotation_versions:[quote],attachments:[{id:'network-design-pdf',filename:'network-design.pdf',content_type:'application/pdf',uploaded_at:'2026-10-28T10:00:00Z',upload_date:'2026-10-28',size_bytes:24},{id:'network-quote-pdf',filename:'network-quote.pdf',content_type:'application/pdf',uploaded_at:'2026-10-28T10:00:00Z',upload_date:'2026-10-28',size_bytes:24}]};
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
    reads++;if(reads===1)return route.abort('failed');return route.fulfill({json:!confirmed&&reads===3?{...project,stage,version:1}:project});
   }
   return route.fulfill({json:{rows:[],total:0,page:1,limit:25}});
  });
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`/kitchen/network-project/stages/${stage}`);
  await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();expect(reads).toBe(2);
  await expect(page.getByTestId('kitchen-project-actions')).toBeVisible();
  if(stage==='order')await expect(page.getByTestId('kitchen-disclose-order-details')).toHaveCount(0);
  await page.getByTestId(`kitchen-advance-${target}`).click();
  if(!confirmed){
   await expect(page.getByText('Could not save',{exact:true})).toBeVisible();expect(writes).toHaveLength(1);
   await page.getByTestId(`kitchen-advance-${target}`).click();
  }
  await expect(page).toHaveURL(new RegExp(`/stages/${target}(?:\\?|$)`));
  await expect(page.getByText('Could not save',{exact:true})).toHaveCount(0);
  expect(writes).toHaveLength(confirmed?1:2);if(!confirmed)expect(writes[1]).toEqual(writes[0]);expect(writes[0].idempotency_key).toBeTruthy();expect(project.version).toBe(2);expect(reads).toBeGreaterThanOrEqual(3);expect(errors).toEqual([]);
 });
}
