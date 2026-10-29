import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const element=(type,props)=>({type,props:props||{}});
let state=[],cursor=0,drafts={},pickedAsset,error=null,uploaded=[],updated=[],added=[],selected=[],transferResult,uploadResult,effects=[],cancelled=[],cancelWork=async()=>{},uploadWork;
const current={id:'project',version:4,attachments:[]};
const uploadedFile={id:'pdf1',filename:'GI.pdf',size_bytes:1000,content_type:'application/pdf',uploaded_at:'2026-10-28T20:00:00Z'};
const submission={busy:false,clearFeedback(){error=null;},setError(value){error=value;},async submit(_input,work,accept){try{accept(await work('receipt'));return true;}catch(failure){error=failure.message;return false;}}};
const context={policy:{files:{max_bytes:25_000_000}},documentSubmission:submission,updateProject:value=>updated.push(value),reload:()=>{}};
const modules={
  react:{useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return[state[i],next=>{state[i]=typeof next==='function'?next(state[i]):next;}];},useRef(initial){const i=cursor++;return state[i]||=( {current:initial});},useEffect(work,deps){const i=cursor++;const previous=state[i];if(!previous||deps.some((value,index)=>value!==previous.deps[index])){previous?.cleanup?.();const effect={deps};state[i]=effect;effects.push(()=>{effect.cleanup=work();});}}},
  'react/jsx-runtime':{jsx:element,jsxs:element,Fragment:'fragment'},
  'react-native':{Platform:{OS:'web'},View:'view',ActivityIndicator:'spinner'},
  'expo-document-picker':{getDocumentAsync:async options=>{assert.equal(options.type,'application/pdf');return{canceled:false,assets:[pickedAsset]};}},
  '@/src/components/AppText':{Text:'text'},
  '@/src/api/kitchenProjects':{kitchenProjectsApi:{ownTransfer:async()=>({transfer:transferResult}),cancelTransfer:async(...args)=>{cancelled.push(args);await cancelWork();transferResult=null;return{discarded:true};}}},
  './shared':{ErrorNotice:'error',displayDate:value=>value},
  './KitchenFilters':{KitchenOption:'option',KitchenSelect:'select'},
  './KitchenPrimitives':{KitchenButton:'button',kitchenType:{}},
  './KitchenProjectState':{useKitchenProject:()=>context,useKitchenDraft:(key,initial)=>[drafts[key]??initial,next=>{drafts[key]=typeof next==='function'?next(drafts[key]??initial):next;}]},
  './KitchenFileTransport':{KITCHEN_MAX_PDF_BYTES:10_000_000,uploadKitchenFile:async(project,file,key,progress,started)=>{uploaded.push([project,file,key]);if(uploadWork)return uploadWork(project,file,key,progress,started);progress(100);return uploadResult || {...current,version:5,attachments:[uploadedFile]};},downloadKitchenFile:async()=>true},
  './KitchenVersions':{kitchenApprovalDate:at=>at?new Date(new Date(at).getTime()+330*60_000).toISOString().slice(0,10):undefined},
  '@/src/theme/tokens':{spacing:{}},
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
props={...props,project:updated[0],attachmentIds:['pdf1']};view=render();assert.match(view.text,/Uploaded: 2026-10-29/,'Upload date uses the server timestamp in India');
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
