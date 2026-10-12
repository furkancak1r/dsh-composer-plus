// Runs the real client.js PlanToggle with fake React/DOM: Option+Tab (macOS) / Shift+Tab (Windows/Linux) adds or removes a leading `/plan`,
// edits only the prefix, ignores other modifiers/repeats/IME, and moves the caret to the end.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../client.js',import.meta.url),'utf8');
let mod;globalThis.window={__ModuleLoader__:{load:m=>{mod=m;}},getSelection:()=>sel};eval(src);
const sel={removeAllRanges(){this.r=null;},addRange(r){this.r=r;}};
globalThis.Element=class{};let frames=[];globalThis.requestAnimationFrame=f=>frames.push(f);
let platform='MacIntel';Object.defineProperty(globalThis,'navigator',{value:{get platform(){return platform;}},configurable:true});
globalThis.document={documentElement:{dataset:{}},createRange:()=>({selectNodeContents(n){this.n=n;},collapse(toStart){this.end=!toStart;}})};
let listener;let menu=null;const seat={querySelector:()=>menu,addEventListener:(t,f,c)=>{assert.equal(t,'keydown');assert.equal(c,true);listener=f;},removeEventListener:(t,f)=>{if(f===listener)listener=null;}};
const input=Object.assign(new Element(),{isContentEditable:true,isConnected:true,closest:q=>q==='[data-composer-input]'?input:seat});
const anchorEl={closest:()=>seat};let effects=[];
const React={useRef:()=>({current:anchorEl}),useEffect:f=>effects.push(f),createElement:(t,p)=>({t,p})};
const plugin=mod.factory(n=>n==='react'?React:{});
const regs=[];plugin.apply({slots:{inject:(name,f)=>f(),register:(o,C)=>{regs.push([o,C]);return()=>{};}}});
const [opt,C]=regs.find(([o])=>o.id==='composer-plan-toggle');assert.equal(opt.name,'conversation.input.right');
let edits;const actions={captureInsertion:()=>({start:3,end:5,draftRev:7}),insertText:(t,s)=>{edits.push([t,s]);return true;}};
const mount=draft=>{effects=[];C({useInput:f=>f({draft}),inputActions:actions});return effects[0]();};
const press=(o={})=>{edits=[];frames=[];sel.r=null;const e={key:'Tab',altKey:false,shiftKey:false,ctrlKey:false,metaKey:false,repeat:false,isComposing:false,keyCode:9,target:input,prevented:0,preventDefault(){this.prevented++;},stopPropagation(){},...o};listener(e);frames.forEach(f=>f());return e;};
const cases=[['','/plan ',0,0],['bunu düzelt','/plan ',0,0],['a\nb','/plan ',0,0],['/planning x','/plan ',0,0],['/plan x','',0,6],['/plan','',0,5],['/plan\tx','',0,6],['/plan  x','',0,6]];
for(const [name,key,ignored] of [['MacIntel',{altKey:true},[{shiftKey:true},{altKey:false}]],['Win32',{shiftKey:true},[{altKey:true},{shiftKey:false}]],['Linux x86_64',{shiftKey:true},[{altKey:true},{shiftKey:false}]]]){
 platform=name;const base={altKey:false,shiftKey:false,...key};
 const hit=(o={})=>press({...base,...o});
 for(const [draft,text,start,end] of cases){const off=mount(draft);const e=hit();assert.equal(e.prevented,1,name+draft);
  assert.deepEqual(edits,[[text,{start,end,draftRev:7}]],name+draft);assert.ok(sel.r&&sel.r.n===input&&sel.r.end,'caret at end: '+name+draft);off();assert.equal(listener,null,'cleanup');}
 mount('x');
 for(const o of [...ignored,{ctrlKey:true},{metaKey:true},{key:'a'}]){const e=hit(o);assert.equal(e.prevented,0,name+JSON.stringify(o));assert.deepEqual(edits,[]);}
 for(const o of [{repeat:true},{isComposing:true},{keyCode:229}]){const e=hit(o);assert.equal(e.prevented,1,'swallowed '+name+JSON.stringify(o));assert.deepEqual(edits,[],JSON.stringify(o));}
 menu={};const m=hit();menu=null;
 if(name==='MacIntel'){assert.equal(m.prevented,1,'mac toggles with a menu open');}else{assert.equal(m.prevented,0,'Shift+Tab left to the open menu');assert.deepEqual(edits,[]);}
 const other=Object.assign(new Element(),{closest:()=>null});assert.equal(hit({target:other}).prevented,0,'outside composer');
 const save=actions.insertText;actions.insertText=()=>false;hit();assert.equal(sel.r,null,'refused edit leaves the caret');actions.insertText=save;
}
platform='Win32';document.documentElement.dataset.platform='darwin';mount('x');press({altKey:true});assert.deepEqual(edits,[['/plan ',{start:0,end:0,draftRev:7}]],'Electron platform mark wins');
console.log('plan-toggle checks passed');
