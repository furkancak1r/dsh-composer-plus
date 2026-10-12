// Runs the real client.js "Allow for this chat" logic with fake React/DOM/uiSession.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const src=readFileSync(process.env.CLIENT??new URL('../client.js',import.meta.url),'utf8');
let mod;globalThis.window={__ModuleLoader__:{load:m=>{mod=m;}}};eval(src);
globalThis.queueMicrotask=f=>f();globalThis.requestAnimationFrame=f=>0;globalThis.cancelAnimationFrame=()=>{};globalThis.CSS={escape:s=>s};
const tick=()=>new Promise(r=>setTimeout(r,0));
let row;globalThis.document={querySelector:q=>q.includes('approval:')?{querySelectorAll:()=>[{parentElement:row}]}:null};
let state=[],si=0,effects=[];
const React={useState:v=>{const i=si++;if(!(i in state))state[i]=v;return [state[i],x=>{state[i]=x;}];},useEffect:f=>effects.push(f),
 useSyncExternalStore:(sub,get)=>get(),createElement:(t,p,...c)=>({t,p,c}),Fragment:'F'};
const plugin=mod.factory(n=>n==='react'?React:n==='react-dom'?{createPortal:(el,host,key)=>({portal:el,host,key})}:{Button:'Button'});
const regs=[];let listeners=new Set();let snap=new Map();let unloads=[];
const status={getSnapshot:()=>snap,subscribe:l=>{listeners.add(l);return()=>listeners.delete(l);}};
const publish=m=>{snap=m;for(const l of [...listeners])l();};
const dicts={};
plugin.apply({effect:f=>{const d=f();if(d)unloads.push(d);},locale:{register:(ns,d)=>{dicts[ns]=d;return()=>{};}},
 inject:(names,cb)=>{if(names.includes('uiWorkspace'))return;assert.deepEqual(names,['uiSession']);cb({uiSession:{sessionStatus:status},effect:f=>{const d=f();unloads.push(d);}});},
 slots:{inject:(n,f)=>f(),register:(o,C)=>{regs.push([o,C]);return()=>{};}}});
const [opt,Grants]=regs.find(([o])=>o.id==='chat-tool-grants');assert.equal(opt.name,'conversation.session.header.utilities');
const en=dicts[opt.locale].en;assert.deepEqual(Object.keys(dicts[opt.locale].en).sort(),Object.keys(dicts[opt.locale].zh).sort());
const t=(k,p={})=>en[k].replace(/\{(\w+)\}/g,(_,n)=>p[n]);
let n=0;
function ask(sessionId,toolName,{auto=true,settled=false}={}){n++;const a={kind:'approval',key:`approval:${n}`,sessionId,toolName,
 reason:auto?`Auto review denied tool "${toolName}": x`:`escalate sandbox: ${toolName}`,answers:[],ok:!settled,
 get answerable(){return this.ok;},answer(o){if(!this.ok)return Promise.reject(new Error('settled'));this.ok=false;this.answers.push(o);return Promise.resolve();}};return a;}
const render=(sessionId)=>{si=0;effects=[];const out=Grants({sessionId,useSessionStatus:sel=>sel(snap),t});return out;};
const LIVE='mcp__db__execute_sql_prod',TEST='mcp__db__execute_sql_test';
// 1. First ask shows the button inside the card's button row; clicking answers once and grants.
row={};const a1=ask('s1',LIVE);publish(new Map([['s1',{pendingInteraction:a1}]]));assert.deepEqual(a1.answers,[],'not granted yet: user decides');
state=[];render('s1');effects[0]();let out=render('s1');const btn=out.c[1];assert.equal(btn.host,row);assert.equal(btn.portal.c[0],'Allow for this chat');
btn.portal.p.onClick();btn.portal.p.onClick();await tick();assert.deepEqual(a1.answers,['allowed-once'],'answered exactly once');
// 2. Same chat + tool, different arguments: answered without the user.
const a2=ask('s1',LIVE);publish(new Map([['s1',{pendingInteraction:a2}]]));await tick();assert.deepEqual(a2.answers,['allowed-once']);
publish(new Map([['s1',{pendingInteraction:a2}]]));assert.equal(a2.answers.length,1,'no duplicate answer');
// 3. Other tool, other chat, and non-Auto-Review asks still ask.
const a3=ask('s1',TEST),a4=ask('s2',LIVE),a5=ask('s1',LIVE,{auto:false});
publish(new Map([['s1',{pendingInteraction:a3}],['s2',{pendingInteraction:a4}]]));publish(new Map([['s1',{pendingInteraction:a5}]]));
assert.deepEqual([a3.answers,a4.answers,a5.answers],[[],[],[]]);
// 4. Header chip lists the grant; clicking revokes; the next ask is shown to the user again.
publish(new Map());state=[];out=render('s1');assert.equal(out.c[0].c[0],'1 tool(s) allowed · Revoke');assert.match(out.c[0].p.title,/execute_sql_prod/);
assert.equal(render('s2'),null,'other chat has no grants');
out.c[0].p.onClick();assert.equal(render('s1'),null);const a6=ask('s1',LIVE);publish(new Map([['s1',{pendingInteraction:a6}]]));assert.deepEqual(a6.answers,[]);
// 5. A cancelled/already answered request never becomes a grant.
const a7=ask('s3',LIVE);publish(new Map([['s3',{pendingInteraction:a7}]]));state=[];render('s3');effects[0]();out=render('s3');a7.ok=false;out.c[1].portal.p.onClick();await tick();
const a8=ask('s3',LIVE);publish(new Map([['s3',{pendingInteraction:a8}]]));assert.deepEqual(a8.answers,[],'no grant from a settled request');
// 6. Unload forgets grants and stops auto-answering.
state=[];const a9=ask('s4',LIVE);publish(new Map([['s4',{pendingInteraction:a9}]]));render('s4');effects[0]();render('s4').c[1].portal.p.onClick();await tick();
for(const d of unloads)d();const a10=ask('s4',LIVE);publish(new Map([['s4',{pendingInteraction:a10}]]));assert.deepEqual(a10.answers,[]);assert.equal(render("s4").c[0],null,"no chip after unload");
console.log('chat-grant checks passed');
