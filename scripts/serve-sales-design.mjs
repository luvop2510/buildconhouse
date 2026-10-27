// Local synthetic design review only. No proxy or business data access.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import ts from 'typescript';
const source = await readFile(new URL('../e2e/sales-fixtures.ts', import.meta.url), 'utf8');
const fixtureModule = ts.transpileModule(source.slice(0, source.indexOf('export async function mockSalesSummary')), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const fixtures = {};
Function('exports', fixtureModule)(fixtures);
const floors = [{id:'first-floor',name:'The Sanitary Bathroom',slug:'first-floor'},{id:'ground-floor',name:'Tiles',slug:'ground-floor'},{id:'second-floor',name:'Kitchen',slug:'second-floor'},{id:'third-floor',name:'Furniture',slug:'third-floor'}];
const refs = [{id:'r-architect',name:'Nisha Shah',type:'architect',company:'Studio Line',phone:'9900000011',shared_across_floors:true,updated_at:'v1'},{id:'r-interior',name:'Mehul Desai',type:'interior_designer',company:'Forma Interiors',phone:'9900000022',shared_across_floors:true,updated_at:'v1'}];
const root = resolve(process.env.AUDIT_ROOT || 'dist/client');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2'};
createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  const path=url.pathname;
  if(path==='/__qa/init.js') {res.writeHead(200,{'content-type':'text/javascript'});res.end(`localStorage.setItem('forge.jwt.kind',JSON.stringify('staff'));localStorage.setItem('forge.active-floor',JSON.stringify('first-floor'));if(!localStorage.getItem('forge.sales-data.floor.design-owner'))localStorage.setItem('forge.sales-data.floor.design-owner',JSON.stringify('all'));`);return;}
  if(path.startsWith('/api/')){
   let body;
   if(path==='/api/auth/me')body={id:'design-owner',email:'design@example.test',full_name:'Design Review',role:'owner',active:true,floor_ids:floors.map(x=>x.id)};
   else if(path==='/api/settings/floor-access')body={all_floors:true,floors,floor_ids:floors.map(x=>x.id)};
   else if(path==='/api/settings/permission-matrix')body={modules:[],roles:[],matrix:{owner:{}}};
   else if(path==='/api/settings/roles'||path==='/api/notifications')body=[];
   else if(path==='/api/analytics/default-period')body={preset:'this_month',date_from:null,date_to:null,label:'This month',fallback_applied:false,latest_order_at:null};
   else if(path==='/api/analytics/sales-summary')body=fixtures.fourDepartmentSummary(url.searchParams.get('floor_id') || 'all');
   else if(path==='/api/referrers')body=refs;
   else if(path==='/api/analytics/workspaces/relationships')body={workspace:'relationships',period:'This month',kpis:{revenue:240000,orders:12,outstanding:60000},brands:[],products:[],customers:[],floors:[],relationships:refs.map((r,i)=>({...r,revenue:i?60000:180000,revenue_rnb:i?0:75000.5,orders:i?4:9,customers:i?1:3,customers_acquired:i?3:5,last_order_at:null}))};
   else {res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({detail:'Unmapped local design fixture'}));return;}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body));return;
  }
  const target=resolve(root,`.${decodeURIComponent(path)}`);
  if(target!==root&&!target.startsWith(root+sep)){res.writeHead(403).end();return;}
  for(const file of [target,`${target}.html`,resolve(target,'index.html'),resolve(root,'index.html')]){
   if(!(await stat(file).catch(()=>null))?.isFile())continue;
   let bytes=await readFile(file);
   if(extname(file)==='.html')bytes=Buffer.from(bytes.toString().replace('<head>','<head><script src="/__qa/init.js"></script>'));
   res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream','cache-control':'no-store'});res.end(bytes);return;
  }
  res.writeHead(404).end();
 }catch{res.writeHead(500).end('Local design fixture failed');}
}).listen(Number(process.env.DESIGN_PORT || 8107),'127.0.0.1',()=>console.log('Synthetic design review ready on the configured loopback port'));
