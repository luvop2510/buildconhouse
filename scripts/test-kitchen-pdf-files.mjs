import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const element=(type,props)=>({type,props:props||{}});
let state=[],cursor=0,drafts={},pickedAsset,error=null,uploaded=[],updated=[],added=[],selected=[],transferResult,uploadResult;
const current={id:'project',version:4,attachments:[]};
const uploadedFile={id:'pdf1',filename:'GI.pdf',size_bytes:1000,content_type:'application/pdf',uploaded_at:'2026-10-28T20:00:00Z'};
const submission={busy:false,clearFeedback(){error=null;},setError(value){error=value;},async submit(_input,work,accept){try{accept(await work('receipt'));return true;}catch(failure){error=failure.message;return false;}}};
const context={policy:{files:{max_bytes:25_000_000}},documentSubmission:submission,updateProject:value=>updated.push(value),reload:()=>{}};
const modules={
  react:{useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return[state[i],next=>{state[i]=typeof next==='function'?next(state[i]):next;}];},useRef(initial){const i=cursor++;return state[i]||=( {current:initial});},useEffect(){ }},
  'react/jsx-runtime':{jsx:element,jsxs:element,Fragment:'fragment'},
  'react-native':{Platform:{OS:'web'},View:'view'},
  'expo-document-picker':{getDocumentAsync:async options=>{assert.equal(options.type,'application/pdf');return{canceled:false,assets:[pickedAsset]};}},
  '@/src/components/AppText':{Text:'text'},
  '@/src/api/kitchenProjects':{kitchenProjectsApi:{ownTransfer:async()=>({transfer:transferResult}),cancelTransfer:async()=>{transferResult=null;}}},
  './shared':{ErrorNotice:'error',displayDate:value=>value},
  './KitchenFilters':{KitchenOption:'option',KitchenSelect:'select'},
  './KitchenPrimitives':{KitchenButton:'button',kitchenType:{}},
  './KitchenProjectState':{useKitchenProject:()=>context,useKitchenDraft:(key,initial)=>[drafts[key]??initial,next=>{drafts[key]=typeof next==='function'?next(drafts[key]??initial):next;}]},
  './KitchenFileTransport':{KITCHEN_MAX_PDF_BYTES:10_000_000,uploadKitchenFile:async(project,file,key,progress)=>{uploaded.push([project,file,key]);progress(100);return uploadResult || {...current,version:5,attachments:[uploadedFile]};},downloadKitchenFile:async()=>true},
  './KitchenVersions':{kitchenApprovalDate:at=>at?new Date(new Date(at).getTime()+330*60_000).toISOString().slice(0,10):undefined},
  '@/src/theme/tokens':{spacing:{}},
};
const exports={};
new Function('require','exports','window',ts.transpileModule(readFileSync(new URL('../src/components/kitchen/KitchenPdfFiles.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(name=>{assert.ok(modules[name],name);return modules[name];},exports,{open:()=>null});
function flatten(node){if(node==null||typeof node==='boolean')return[];if(Array.isArray(node))return node.flatMap(flatten);if(typeof node!=='object')return[String(node)];if(typeof node.type==='function')return flatten(node.type(node.props));return[node,...flatten(node.props.children)];}
let props={project:current,attachmentIds:[],finalId:'',onAdd:id=>added.push(id),onSelect:id=>selected.push(id),disabled:false,label:'GI',testID:'pdf',draftKey:'quotation.new.pdf.GI'};
function render(){cursor=0;const nodes=flatten(exports.KitchenPdfFiles(props));return{control:id=>nodes.find(node=>node.props?.testID===id),text:nodes.filter(node=>typeof node==='string').join(' ').replace(/\s+/g,' ')};}
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
