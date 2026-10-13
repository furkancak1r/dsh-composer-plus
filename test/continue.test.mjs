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
assert.deepEqual(opt.inject('s1'),{},'no ctx.sessions: no event source');
const actions={setDraft:t=>calls.push(['set',t]),submit:()=>calls.push(['submit'])};
const sess=(o={})=>sel=>sel({blank:false,running:false,subagent:null,removed:false,...o});
const inp=(o={})=>sel=>sel({phase:'plain',draft:'',attachmentIds:[],...o});
// Loaded event window: newest turn ended with `reason`, or is still open (no turn/end yet).
const win=(reason)=>sel=>sel({entries:[{event:{type:'turn/start',seq:1}},...(reason===undefined?[]:[{event:{type:'turn/end',seq:2,data:{reason:{kind:reason}}}}])]});
let turn=win('interrupted');
const r=(s,i)=>{si=0;layout=[];const out=C({useSession:s,useInput:i,useTurnEnd:turn,inputActions:actions,t:k=>({'continue.message':'devam et','continue.label':'Devam'})[k]});return out;};
const isPortal=o=>o.t==='F';
// visible: first render anchor, effect hides Send and stores host, second render portals play button
r(sess(),inp());const cleanup=layout[0]();assert.equal(send.style.display,'none');
const out=r(sess(),inp());assert.ok(isPortal(out));const p=out.c[1];assert.equal(p.host,row);assert.equal(p.portal.p.className,'uV2eYG_primary');
assert.equal(p.portal.p['aria-label'],'Devam','label follows dsh language');
p.portal.p.onClick();assert.deepEqual(calls,[['set','devam et'],['submit']],'message follows dsh language');
cleanup();assert.equal(send.style.display,'');
for(const [s,i,why] of [[sess({blank:true}),inp(),'blank chat'],[sess({running:true}),inp(),'running'],[sess({subagent:{}}),inp(),'subagent'],[sess(),inp({draft:'x'}),'typed'],[sess(),inp({attachmentIds:['a']}),'attachment'],[sess(),inp({phase:'submitting'}),'submitting'],[s=>s(undefined),inp(),'no session']]){
 state=[];r(s,i);layout[0]();assert.equal(send.style.display,'',why);assert.ok(!isPortal(r(s,i)),why);}
state=[];r(sess(),inp({draft:'  '}));layout[0]();assert.equal(send.style.display,'none','whitespace counts as empty');
// Which endings resume: stopped / failed / cut / open-without-agent show ▶; a completed turn keeps Send.
for(const [t,want,why] of [[win('completed'),false,'completed turn keeps Send'],[win('aborted'),true,'stopped'],[win('error'),true,'failed'],
  [win('max-tokens'),true,'cut by token limit'],[win(undefined),true,'open turn, agent gone'],[s=>s({entries:[]}),false,'nothing loaded'],[s=>s(undefined),false,'no source']]){
 turn=t;state=[];send.style.display='';r(sess(),inp());layout[0]();assert.equal(send.style.display,want?'none':'',why);}
// A completed turn followed by an agent/prompt error still offers ▶.
turn=win('completed');state=[];send.style.display='';r(sess({lastAgentError:'boom'}),inp());layout[0]();assert.equal(send.style.display,'none','agent error');
state=[];send.style.display='';r(sess({promptError:{message:'x'}}),inp());layout[0]();assert.equal(send.style.display,'none','prompt error');
// Old dsh without the hook: no ▶ unless an error is reported.
turn=undefined;state=[];send.style.display='';r(sess(),inp());layout[0]();assert.equal(send.style.display,'','no hook, no error');
// inject wires the session's eventSource as the turnEnd hook.
const es={getSnapshot:()=>({entries:[]}),subscribe:()=>()=>{}};
const regs2=[];plugin.apply({sessions:{binding:id=>id==='s1'?{eventSource:es}:undefined,scope:()=>undefined},slots:{inject:(n,f)=>f(),register:(o,C)=>{regs2.push([o,C]);return()=>{};}}});
const opt2=regs2.find(([o])=>o.id==='composer-continue')[0];assert.equal(opt2.inject('s1').hooks.turnEnd,es);assert.deepEqual(opt2.inject('s2'),{});
console.log('continue-button checks passed');
