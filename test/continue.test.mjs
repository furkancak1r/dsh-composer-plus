// Runs the real client.js factory with a fake loader/React/DOM: visibility rules, Send swap and click behaviour.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../client.js',import.meta.url),'utf8');
let mod;globalThis.window={__ModuleLoader__:{load:m=>{mod=m;}}};eval(src);
const calls=[];let layout=[];
const row={id:'row'};const send={tagName:'BUTTON',className:'uV2eYG_primary',style:{display:''},parentElement:row};
const stop={tagName:'BUTTON',className:'x_add',style:{},parentElement:row};
const seat={querySelectorAll:()=>[stop,send]};const anchorEl={closest:()=>seat};
let state=[];let si=0;
const React={useRef:v=>({current:anchorEl}),useState:v=>{const i=si++;if(!(i in state))state[i]=v;return [state[i],x=>{state[i]=x;}];},
 useLayoutEffect:f=>layout.push(f),createElement:(t,p,...c)=>({t,p,c}),Fragment:'F',flushSync:f=>f()};
const plugin=mod.factory(n=>n==='react'?React:{createPortal:(el,host)=>({portal:el,host})});
const regs=[];plugin.apply({slots:{inject:(name,f)=>f(),register:(o,C)=>{regs.push([o,C]);return()=>{};}}});
const [opt,C]=regs.find(([o])=>o.id==='composer-continue');assert.equal(opt.name,'conversation.input.right');
const actions={setDraft:t=>calls.push(['set',t]),submit:()=>calls.push(['submit'])};
const sess=(o={})=>sel=>sel({blank:false,running:false,subagent:null,removed:false,...o});
const inp=(o={})=>sel=>sel({phase:'plain',draft:'',attachmentIds:[],...o});
const r=(s,i)=>{si=0;layout=[];const out=C({useSession:s,useInput:i,inputActions:actions});return out;};
const isPortal=o=>o.t==='F';
// visible: first render anchor, effect hides Send and stores host, second render portals play button
r(sess(),inp());const cleanup=layout[0]();assert.equal(send.style.display,'none');
const out=r(sess(),inp());assert.ok(isPortal(out));const p=out.c[1];assert.equal(p.host,row);assert.equal(p.portal.p.className,'uV2eYG_primary');
p.portal.p.onClick();assert.deepEqual(calls,[['set','continue'],['submit']]);
cleanup();assert.equal(send.style.display,'');
for(const [s,i,why] of [[sess({blank:true}),inp(),'blank chat'],[sess({running:true}),inp(),'running'],[sess({subagent:{}}),inp(),'subagent'],[sess(),inp({draft:'x'}),'typed'],[sess(),inp({attachmentIds:['a']}),'attachment'],[sess(),inp({phase:'submitting'}),'submitting'],[s=>s(undefined),inp(),'no session']]){
 state=[];r(s,i);layout[0]();assert.equal(send.style.display,'',why);assert.ok(!isPortal(r(s,i)),why);}
state=[];r(sess(),inp({draft:'  '}));layout[0]();assert.equal(send.style.display,'none','whitespace counts as empty');
console.log('continue-button checks passed');
