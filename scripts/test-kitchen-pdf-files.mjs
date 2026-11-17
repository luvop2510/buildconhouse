import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const element=(type,props)=>({type,props:props||{}});
let state=[],cursor=0,drafts={},pickedAsset,error=null,uploaded=[],updated=[],added=[],selected=[],transferResult,uploadResult,effects=[],cancelled=[],cancelWork=async()=>{},uploadWork;
const current={id:'project',version:4,attachments:[]};
const uploadedFile={id:'pdf1',filename:'GI.pdf',size_bytes:1000,content_type:'application/pdf',uploaded_at:'2026-10-28T20:00:00Z'};
const submission={busy:false,clearFeedback(){error=null;},setError(value){error=value;},async submit(_input,work,accept){try{accept(await work('receipt'));return true;}catch(failure){error=failure.message;return false;}}};
const context={submission,resetDraftValue:key=>{delete drafts[key];},command:async()=>true,policy:{files:{max_bytes:25_000_000}},documentSubmission:submission,updateProject:value=>updated.push(value),reload:()=>{}};
const modules={
  react:{useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return[state[i],next=>{state[i]=typeof next==='function'?next(state[i]):next;}];},useRef(initial){const i=cursor++;return state[i]||=( {current:initial});},useEffect(work,deps){const i=cursor++;const previous=state[i];if(!previous||deps.some((value,index)=>value!==previous.deps[index])){previous?.cleanup?.();const effect={deps};state[i]=effect;effects.push(()=>{effect.cleanup=work();});}}},
  'react/jsx-runtime':{jsx:element,jsxs:element,Fragment:'fragment'},
  'react-native':{Platform:{OS:'web'},View:'view',ActivityIndicator:'spinner'},
  'expo-document-picker':{getDocumentAsync:async options=>{assert.equal(options.type,'application/pdf');return{canceled:false,assets:[pickedAsset]};}},
  '@/src/components/AppText':{Text:'text'},
  '@/src/api/kitchenProjects':{kitchenProjectsApi:{ownTransfer:async()=>({transfer:transferResult}),cancelTransfer:async(...args)=>{cancelled.push(args);await cancelWork();transferResult=null;return{discarded:true};}}},
  './shared':{ErrorNotice:'error',displayDate:value=>value},
  './KitchenFilters':{KitchenDateField:'date',KitchenOption:'option',KitchenSelect:'select'},
  './KitchenFileDrop':{KitchenFileDrop:'drop'},
  '@/src/api/client':{subscribeApiCacheInvalidation:()=>()=>{}},
  './KitchenPrimitives':{KitchenButton:'button',kitchenType:{}},
  './KitchenProjectState':{useKitchenProject:()=>context,useKitchenDraft:(key,initial)=>[drafts[key]??initial,next=>{drafts[key]=typeof next==='function'?next(drafts[key]??initial):next;}]},
  './KitchenFileTransport':{KITCHEN_MAX_PDF_BYTES:10_000_000,uploadKitchenFile:async(project,file,key,progress,started)=>{uploaded.push([project,file,key]);if(uploadWork)return uploadWork(project,file,key,progress,started);progress(100);return uploadResult || {...current,version:5,attachments:[uploadedFile]};},downloadKitchenFile:async()=>true},
  './KitchenVersions':{kitchenApprovalDate:at=>at?new Date(new Date(at).getTime()+330*60_000).toISOString().slice(0,10):undefined},
  '@/src/theme/tokens':{spacing:{},colors:{}},
};
const exports={};
new Function('require','exports','window',ts.transpileModule(readFileSync(new URL('../src/components/kitchen/KitchenPdfFiles.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(name=>{assert.ok(modules[name],name);return modules[name];},exports,{open:()=>null});
function flatten(node){if(node==null||typeof node==='boolean')return[];if(Array.isArray(node))return node.flatMap(flatten);if(typeof node!=='object')return[String(node)];if(typeof node.type==='function')return flatten(node.type(node.props));return[node,...flatten(node.props.children)];}
let props={project:current,attachmentIds:[],finalId:'',onAdd:id=>added.push(id),onSelect:id=>selected.push(id),disabled:false,label:'GI',testID:'pdf',draftKey:'quotation.new.pdf.GI'};
function render(){cursor=0;const nodes=flatten(exports.KitchenPdfFiles(props));const pending=effects;effects=[];pending.forEach(work=>work());return{nodes,control:id=>nodes.find(node=>node.props?.testID===id),text:nodes.filter(node=>typeof node==='string').join(' ').replace(/\s+/g,' ')};}
for(const asset of [{name:'invalid.docx',size:1000},{name:'empty.pdf',size:0},{name:'large.pdf',size:10_000_001}]){
  pickedAsset=asset;let view=render();await view.control('pdf-pick').props.onPress();view=render();await view.control('pdf-upload').props.onPress();assert.match(error,/nonempty PDF up to 10 MB/);assert.equal(uploaded.length,0);
}
pickedAsset={name:'GI.pdf',size:1000,uri:'synthetic',mimeType:'application/pdf'};
let view=render();await view.control('pdf-pick').props.onPress();view=render();await view.control('pdf-upload').props.onPress();
for(let i=0;i<5;i++)await Promise.resolve();
assert.equal(uploaded.length,1);assert.equal(uploaded[0][0].version,4);assert.deepEqual(added,['pdf1']);assert.deepEqual(selected,[],'An upload cannot silently finalize a PDF');assert.equal(updated[0].version,5,'The next command receives the acknowledged project version');
props={...props,project:updated[0],attachmentIds:['pdf1']};view=render();assert.equal(view.control('pdf-pdf1-date').props.value,'2026-10-29','Historical fallback uses the server timestamp in India');
view.control('pdf-pdf1-final').props.onPress();assert.deepEqual(selected,['pdf1']);
await view.control('pdf-pdf1-open').props.onPress();view=render();assert.match(view.text,/Allow this browser to open a PDF preview/,'Blocked previews give a useful retry error');
props={...props,finalId:'pdf1',disabled:true};view=render();assert.equal(view.control('pdf-pick'),undefined);assert.equal(view.control('pdf-pdf1-final').props.disabled,true);assert.ok(view.control('pdf-pdf1-download'),'Historical PDFs remain downloadable');
submission.busy=true;props={...props,disabled:false};view=render();assert.equal(view.control('pdf-pick').props.disabled,true);assert.equal(view.control('pdf-pdf1-final').props.disabled,true);
console.log('Kitchen PDF controls: private upload validation, acknowledged project version, explicit final selection, India upload date, preview errors and historical downloads passed.');

submission.busy=false;
pickedAsset={name:'Renamed GI.pdf',size:1000,uri:'synthetic-renamed',mimeType:'application/pdf'};
uploadResult={...updated[0],version:6,activity:[{type:'attachment.added',payload:{attachment_id:'pdf1',filename:'Renamed GI.pdf'}},{type:'attachment.added',payload:{attachment_id:'missing-file',filename:'Renamed GI.pdf'}},{type:'attachment.added',payload:{attachment_id:'pdf1',filename:'Later unrelated upload.pdf'}}]};
props={...props,project:updated[0],onAdd:async id=>{added.push(id);error='This PDF already has a Design. Choose that Design instead.';}};
view=render();await view.control('pdf-pick').props.onPress();view=render();await view.control('pdf-upload').props.onPress();
assert.equal(added.at(-1),'pdf1','A renamed content-deduplicated upload resolves its original attachment ID from the matching upload activity');
assert.equal(added.length,2,'The upload still invokes Design registration so duplicate-design validation is visible');
assert.match(error,/already has a Design/,'Renamed deduplication cannot silently skip Design registration');
assert.equal(updated.at(-1).version,6);
console.log('Kitchen renamed PDF deduplication: matching persisted upload event resolves the original ID and duplicate Design feedback remains visible.');
pickedAsset={name:'Unknown filename.pdf',size:1000,uri:'synthetic-unknown',mimeType:'application/pdf'};
uploadResult={...uploadResult,version:7,activity:[]};
view=render();await view.control('pdf-pick').props.onPress();view=render();await view.control('pdf-upload').props.onPress();
assert.match(error,/saved file could not be identified/,'A malformed upload response produces recovery feedback instead of silent success');
assert.equal(added.length,2);

props={...props,project:{...current,attachments:[uploadedFile]},attachmentIds:[],finalId:'',label:undefined};
view=render();
assert.equal(view.control('pdf-pick').props.label,'Choose PDF','Design upload has a single direct picker without a repeated Design heading');
assert.equal(view.control('pdf-existing'),undefined,'Previously uploaded PDFs do not add a second picker');
assert.equal(view.nodes.some(node=>node.type==='select'),false,'No uploaded-PDF selection remains when an unrelated PDF is present');
assert.doesNotMatch(view.text,/Choose a PDF to add\.|Add uploaded PDF|Choose an uploaded PDF|\bDesign\b/);
for(const kitchenType of ['GI','SS','Mix']){
  props={...props,label:kitchenType};view=render();
  assert.equal(view.control('pdf-pick').props.label,`Choose ${kitchenType} PDF`);
  assert.equal(view.control('pdf-existing'),undefined);
  assert.doesNotMatch(view.text,/Choose a PDF to add\.|Add uploaded PDF|Choose an uploaded PDF/);
}
console.log('Kitchen PDF simplification: direct Design/GI/SS/Mix uploads remain without duplicate headings, empty hints or uploaded-file selectors.');

state=[];drafts={};
transferResult={project_id:'other-project',transfer_id:'other-transfer',filename:'Earlier drawing.pdf',state:'open'};
props={...props,project:current,label:'GI'};render();await Promise.resolve();view=render();
assert.match(view.text,/another project/i,'An actor-global transfer is clearly identified before the explicit discard action');
let settleCancel;cancelWork=()=>new Promise(resolve=>{settleCancel=resolve;});
const discard=view.control('pdf-discard').props.onPress();view=render();
assert.equal(view.control('pdf-discard').props.loading,true,'Discard has a visible pending animation');
assert.equal(view.control('pdf-pick').props.disabled,true,'Picking a new file waits for the explicit discard acknowledgement');
view.control('pdf-discard').props.onPress();assert.equal(cancelled.length,1,'Repeated discard taps coalesce synchronously');
assert.deepEqual(cancelled[0],['other-project','other-transfer'],'Discard uses the staged transfer origin rather than the currently viewed project');
settleCancel();await discard;await Promise.resolve();view=render();assert.equal(view.control('pdf-discard'),undefined);
console.log('Kitchen discard recovery: actor-global origin, explicit other-project context, animated pending state and duplicate-tap lock passed.');

state=[];drafts={};cancelWork=async()=>{};
pickedAsset={name:'GI.pdf',size:1000,uri:'registration-pdf',mimeType:'application/pdf'};
uploadResult={...current,version:5,attachments:[uploadedFile]};
let publishProgress,completeUpload,completeRegistration;
uploadWork=(_project,_file,_key,progress)=>new Promise(resolve=>{publishProgress=progress;completeUpload=()=>{progress(100);resolve(uploadResult);};});
props={...props,project:current,onAdd:()=>new Promise(resolve=>{completeRegistration=resolve;})};
view=render();await view.control('pdf-pick').props.onPress();view=render();
const uploadCount=uploaded.length;const saving=view.control('pdf-upload').props.onPress();
view=render();assert.match(view.text,/Preparing PDF/,'Preparation is visible before the first network acknowledgement');
assert.equal(view.control('pdf-upload').props.loading,true);
publishProgress(95);view=render();assert.match(view.text,/Verifying and saving PDF/);
view.control('pdf-upload').props.onPress();assert.equal(uploaded.length,uploadCount+1,'Repeated upload taps coalesce synchronously');
completeUpload();for(let i=0;i<5;i++)await Promise.resolve();view=render();
assert.match(view.text,/Saving PDF entry/,'The local lock stays visible while the Design entry is being saved');
assert.equal(view.control('pdf-pick').props.disabled,true);
completeRegistration(false);await saving;view=render();
assert.match(error,/PDF uploaded.*stage entry is waiting/);
assert.equal(view.control('pdf-upload').props.label,'Retry saving PDF entry');
assert.equal(drafts[`${props.draftKey}.picked`].uri,'registration-pdf','A failed Design command keeps the selected PDF');
props={...props,project:uploadResult,onAdd:async()=>true};view=render();await view.control('pdf-upload').props.onPress();
assert.equal(uploaded.length,uploadCount+1,'Retrying Design registration reuses its saved attachment without uploading bytes again');
assert.equal(drafts[`${props.draftKey}.picked`],null);
assert.equal(drafts[`${props.draftKey}.uploaded`],null);
console.log('Kitchen upload feedback: preparation, verification, registration lock and attachment-only retry preserve selections without duplicate transfers.');

state=[];drafts={};
transferResult={project_id:current.id,transfer_id:'verifying-transfer',filename:'Verifying.pdf',state:'finishing'};
props={...props,project:current};render();await Promise.resolve();view=render();
assert.equal(view.control('pdf-discard'),undefined,'A transfer already being finalized cannot offer a predictably failing discard');
assert.match(view.text,/Verification has started.*Retry this upload/);

state=[];drafts={};transferResult=null;
props={...props,project:current,draftKey:'first-project-pdf',onAdd:()=>{throw new Error('Obsolete stage callback must not run');}};
view=render();await view.control('pdf-pick').props.onPress();view=render();
const beforeObsolete=updated.length;const obsolete=view.control('pdf-upload').props.onPress();
props={...props,project:{...current,id:'next-project'},draftKey:'next-project-pdf'};view=render();
publishProgress(95);completeUpload();await obsolete;view=render();
assert.equal(updated.length,beforeObsolete,'An upload response from the old project cannot replace the current project');
assert.equal(view.control('pdf-progress'),undefined,'Obsolete upload progress cannot appear under the next project');
assert.equal(drafts['next-project-pdf.picked'],undefined,'Obsolete completion cannot clear or initialize another project’s draft');
console.log('Kitchen upload scope: finishing transfers show recovery guidance; obsolete upload callbacks cannot publish into another project.');

// Restricted staff get independently granted controls; installation photos remain unchanged.
state=[];drafts={};submission.busy=false;
const restrictedProject={...current,stage:'design',attachments:[uploadedFile],permissions:{restricted:true,can_choose_pdf:false,can_open_pdf:false,can_download_pdf:false}};
props={...props,project:restrictedProject,attachmentIds:['pdf1'],finalId:'pdf1',label:undefined,disabled:false};
view=render();assert.equal(view.control('pdf-pick'),undefined);assert.equal(view.control('pdf-pdf1-open'),undefined);assert.equal(view.control('pdf-pdf1-download'),undefined);assert.doesNotMatch(view.text,/GI\.pdf/);
props={...props,project:{...restrictedProject,permissions:{...restrictedProject.permissions,can_open_pdf:true}}};view=render();assert.ok(view.control('pdf-pdf1-open'));assert.equal(view.control('pdf-pdf1-download'),undefined);assert.equal(view.control('pdf-pick'),undefined);
props={...props,project:{...restrictedProject,permissions:{...restrictedProject.permissions,can_download_pdf:true}}};view=render();assert.equal(view.control('pdf-pdf1-open'),undefined);assert.ok(view.control('pdf-pdf1-download'));
props={...props,project:{...restrictedProject,permissions:{...restrictedProject.permissions,can_choose_pdf:true}}};view=render();assert.ok(view.control('pdf-pick'));assert.equal(view.control('pdf-pdf1-open'),undefined);assert.equal(view.control('pdf-pdf1-download'),undefined);
props={...props,finalId:'another'};view=render();assert.equal(view.control('pdf-pdf1-open'),undefined);assert.equal(view.control('pdf-pdf1-download'),undefined);
props={...props,finalProduction:true,finalId:'pdf1'};view=render();assert.equal(view.control('pdf-pick'),undefined,'Restricted users cannot add a production PDF');
console.log('Kitchen restricted PDF capabilities: independent choose, open and download, finalized-only visibility, and production upload restriction passed.');

const scopeExports={};
new Function('exports',ts.transpileModule(readFileSync(new URL('../src/components/kitchen/KitchenDocumentScope.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(scopeExports);
const stageFiles=[{id:'design',stage:'design'},{id:'installation-pdf',stage:'installation'},{id:'installation-photo',stage:'installation'},{id:'legacy'}];
assert.deepEqual(scopeExports.visibleKitchenDocuments({stage:'installation',permissions:{restricted:true},attachments:stageFiles}).map(file=>file.id),['installation-pdf','installation-photo']);
assert.deepEqual(scopeExports.visibleKitchenDocuments({stage:'order',permissions:{restricted:true},attachments:stageFiles}),[]);
assert.deepEqual(scopeExports.visibleKitchenDocuments({stage:'installation',permissions:{restricted:false},attachments:stageFiles}),stageFiles);
console.log('Kitchen installation documents: restricted accounts see installation-stage files only; unrestricted accounts retain all files.');

// The same card and upload-date path serves every Kitchen stage and PDF type.
state=[];drafts={};uploadWork=undefined;submission.busy=false;
const dateCommands=[];
context.command=async(name,payload)=>{dateCommands.push([name,payload]);return true;};
for(const stage of ['lead','visit','cad','design','quotation','order','production','installation','completed']) {
  state=[];drafts={};
  props={...props,project:{...current,stage,attachments:[{...uploadedFile,stage,upload_date:null}]},attachmentIds:['pdf1'],finalId:'pdf1',label:undefined,finalProduction:false,disabled:false,draftKey:`${stage}.pdf`};
  view=render();
  assert.equal(view.control('pdf-pdf1-date').props.value,'',`${stage}: explicit blank stays blank despite actual upload timestamp`);
  view.control('pdf-pdf1-date').props.onChange('2026-10-27');view=render();
  assert.equal(view.control('pdf-pdf1-date').props.value,'2026-10-27',`${stage}: historical date immediately updates`);
  submission.busy=true;view=render();
  assert.ok(!view.control('pdf-pdf1-date').props.disabled,`${stage}: an unrelated save leaves date entry editable`);
  assert.equal(view.control('pdf-pdf1-date-save').props.disabled,true);
  submission.busy=false;view=render();await view.control('pdf-pdf1-date-save').props.onPress();
  assert.deepEqual(dateCommands.at(-1),['attachment_date',{attachment_id:'pdf1',upload_date:'2026-10-27'}]);
}
for(const label of [undefined,'GI','SS','Mix']) {
  state=[];drafts={};
  props={...props,project:{...current,stage:label?'quotation':'design'},attachmentIds:[],finalId:'',label,draftKey:`new.${label || 'design'}`,onAdd:id=>added.push(id)};
  view=render();view.control('pdf-upload-date').props.onChange('2026-10-27');view=render();
  pickedAsset={name:'GI.pdf',size:1000,uri:`record-date-${label}`,mimeType:'application/pdf'};
  await view.control('pdf-pick').props.onPress();view=render();await view.control('pdf-upload').props.onPress();
  assert.deepEqual(dateCommands.at(-1),['attachment_date',{attachment_id:'pdf1',upload_date:'2026-10-27'}],`${label || 'design'}: selected preupload date is persisted after byte acknowledgement`);
  assert.equal(uploadResult.attachments[0].uploaded_at,'2026-10-28T20:00:00Z','Recording a historical PDF date preserves the actual upload timestamp');
}
state=[];drafts={};
props={...props,project:{...current,stage:'order',production:{final_attachment_id:'pdf1'},attachments:[{...uploadedFile,upload_date:'2026-10-27'}]},attachmentIds:['pdf1'],label:undefined,finalProduction:true,draftKey:'production.replace',onAdd:async()=>true};
view=render();assert.equal(view.control('pdf-upload-date').props.value,'2026-10-27','Replacing a final production PDF retains its existing record date by default');
console.log('Kitchen PDF record dates: all nine stage cards, blank preservation, historical selection, unrelated saves, Design/GI/SS/Mix preupload dates and production replacement passed.');
