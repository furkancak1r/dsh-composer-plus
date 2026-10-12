// Runs the real client.js PlanToggle with fake React/DOM: Shift+Tab adds or removes a leading `/plan`,
// edits only the prefix, ignores other modifiers/repeats/IME, and moves the caret to the end.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../client.js',import.meta.url),'utf8');
let mod;globalThis.window={__ModuleLoader__:{load:m=>{mod=m;}},getSelection:()=>sel};eval(src);
const sel={removeAllRanges(){this.r=null;},addRange(r){this.r=r;}};
globalThis.Element=class{};let frames=[];globalThis.requestAnimationFrame=f=>frames.push(f);
globalThis.document={createRange:()=>({selectNodeContents(n){this.n=n;},collapse(toStart){this.end=!toStart;}})};
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
const hit=(o={})=>press({shiftKey:true,...o});
for(const [draft,text,start,end] of cases){const off=mount(draft);const e=hit();assert.equal(e.prevented,1,draft);
 assert.deepEqual(edits,[[text,{start,end,draftRev:7}]],draft);assert.ok(sel.r&&sel.r.n===input&&sel.r.end,'caret at end: '+draft);off();assert.equal(listener,null,'cleanup');}
mount('x');
for(const o of [{shiftKey:false},{altKey:true},{ctrlKey:true},{metaKey:true},{key:'a'}]){const e=hit(o);assert.equal(e.prevented,0,JSON.stringify(o));assert.deepEqual(edits,[]);}
for(const o of [{repeat:true},{isComposing:true},{keyCode:229}]){const e=hit(o);assert.equal(e.prevented,1,'swallowed '+JSON.stringify(o));assert.deepEqual(edits,[],JSON.stringify(o));}
menu={};assert.equal(hit().prevented,0,'Shift+Tab left to the open menu');assert.deepEqual(edits,[]);menu=null;
const other=Object.assign(new Element(),{closest:()=>null});assert.equal(hit({target:other}).prevented,0,'outside composer');
actions.insertText=()=>false;hit();assert.equal(sel.r,null,'refused edit leaves the caret');
// In plan mode Shift+Tab leaves it via `/plan off` instead of editing the draft (issue #1).
const executed=[];const notices=[];actions.insertText=(t,s)=>{edits.push([t,s]);return true;};
const ctxRemote={commands:{execute:async(id,cmd,args)=>{executed.push([id,cmd,args]);return {ok:true,value:{}};}}};
regs.length=0;plugin.apply({remote:ctxRemote,sessions:{scope:()=>undefined},slots:{inject:(name,f)=>f(),register:(o,C)=>{regs.push([o,C]);return()=>{};}}});
const [opt2,C2]=regs.find(([o])=>o.id==='composer-plan-toggle');const extra=opt2.inject('s1');
const mountPlan=(draft,plan)=>{effects=[];C2({useInput:f=>f({draft}),inputActions:actions,useProjection:n=>{assert.equal(n,'plan');return plan;},...extra,notify:(l,t)=>notices.push([l,t])});return effects[0]();};
for(const plan of [{active:true,pending:false},{active:false,pending:true}]){mountPlan('',plan);const e=hit();assert.equal(e.prevented,1);assert.deepEqual(edits,[],'no draft edit in plan mode');}
await new Promise(r=>setTimeout(r,0));assert.deepEqual(executed,[['s1','/plan off',[]],['s1','/plan off',[]]]);
for(const plan of [{active:false,pending:false},{active:true,pending:true},undefined]){mountPlan('x',plan);hit();assert.deepEqual(edits,[['/plan ',{start:0,end:0,draftRev:7}]],'off: draft edit '+JSON.stringify(plan));}
assert.equal(executed.length,2);
ctxRemote.commands.execute=async()=>({ok:false,error:{message:'busy',code:'locked'}});mountPlan('',{active:true,pending:false});hit();
await new Promise(r=>setTimeout(r,0));assert.deepEqual(notices,[['error','busy (locked)']]);
console.log('plan-toggle checks passed');
