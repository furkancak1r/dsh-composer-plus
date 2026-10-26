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
 inject:(names,cb)=>{if(names.length===1&&names[0]==='uiSession')cb({uiSession:{sessionStatus:status},effect:f=>{const d=f();unloads.push(d);}});return{dispose(){}};},
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
// Persistence: grants made by a click are posted to the Host; grants loaded from the Host auto-answer after a restart.
{
  const posts=[];let store={};
  globalThis.fetch=async(url,init={})=>{if(init.method==='POST'){const b=JSON.parse(init.body);posts.push(b);return {ok:true,json:async()=>({})};}return {ok:true,json:async()=>store};};
  let mod2;window.__ModuleLoader__.load=m=>{mod2=m;};eval(src);
  const p2=mod2.factory(n=>n==='react'?React:n==='react-dom'?{createPortal:(el,host,key)=>({portal:el,host,key})}:{Button:'Button'});
  store={sR:[LIVE]};let ls2=new Set();let snap2=new Map();
  const st2={getSnapshot:()=>snap2,subscribe:l=>{ls2.add(l);return()=>ls2.delete(l);}};
  const regs2=[];p2.apply({effect:f=>{f();},locale:{register:()=>()=>{}},inject:(names,cb)=>{if(names.length===1&&names[0]==='uiSession')cb({uiSession:{sessionStatus:st2},effect:f=>{f();}});return{dispose(){}};},slots:{inject:(n,f)=>f(),register:(o,C)=>{regs2.push([o,C]);return()=>{};}}});
  await tick();await tick();
  const a=ask('sR',LIVE);snap2=new Map([['sR',{pendingInteraction:a}]]);for(const l of [...ls2])l();await tick();
  assert.deepEqual(a.answers,['allowed-once'],'grant loaded from the Host survives a restart');
  const [,G2]=regs2.find(([o])=>o.id==='chat-tool-grants');
  si=0;effects=[];const chip=G2({sessionId:'sR',useSessionStatus:sel=>sel(new Map()),t});
  chip.c[0].p.onClick();await tick();
  assert.deepEqual(posts.at(-1),{action:'revoke',sessionId:'sR'},'revoke is persisted');
}
// Time limit: the Host gives each grant's time left (?detail=1); an ended grant is not answered, the chip drops it, and the
// next ask shows the card again. Host calls run in order, so a slow read never brings back a revoked grant.
{
  const realNow=Date.now;let now=realNow();Date.now=()=>now;
  const timers=[];const realST=globalThis.setTimeout,realCT=globalThis.clearTimeout;
  globalThis.setTimeout=(f,ms)=>{if(ms===0)return realST(f,0);const h={f,ms,at:now+ms,unref(){}};timers.push(h);return h;};
  globalThis.clearTimeout=(h)=>{const i=timers.indexOf(h);if(i>=0)timers.splice(i,1);else realCT(h);};
  const fire=()=>{for(const h of timers.splice(0).sort((a,b)=>a.at-b.at)){if(h.at<=now)h.f();else timers.push(h);}};
  try{
    const calls=[];let reply=()=>({ttlMs:3600e3,grants:{}});const gates=[];
    const grantsFetch=async(url,init={})=>{if(!String(url).includes('composer-plus.grants'))return {ok:false,status:404,json:async()=>({})};
      const body=init.body?JSON.parse(init.body):undefined;calls.push({url,body});
      const gate=gates.shift();if(gate)await gate;return {ok:true,json:async()=>reply(body)};};
    globalThis.fetch=grantsFetch;
    let mod3;window.__ModuleLoader__.load=m=>{mod3=m;};eval(src);
    const p3=mod3.factory(n=>n==='react'?React:n==='react-dom'?{createPortal:(el,host,key)=>({portal:el,host,key})}:{Button:'Button',Menu:'Menu'});
    let ls=new Set(),sn=new Map();const st={getSnapshot:()=>sn,subscribe:l=>{ls.add(l);return()=>ls.delete(l);}};
    const pub=m=>{sn=m;for(const l of [...ls])l();};
    const regs3=[];const un3=[];
    reply=()=>({ttlMs:3600e3,grants:{sT:{[LIVE]:60e3*10}}}); // 10 minutes left on a grant made earlier
    p3.apply({effect:f=>{const d=f();if(d)un3.push(d);},configForms:{get:()=>({})},locale:{register:()=>()=>{},bind:()=>k=>k},inject:(names,cb)=>{if(names.length===1&&names[0]==='uiSession')cb({uiSession:{sessionStatus:st},effect:f=>{const d=f();if(d)un3.push(d);}});return{dispose(){}};},slots:{inject:(n,f)=>f(),register:(o,C)=>{regs3.push([o,C]);return()=>{};}}});
    await tick();await tick();
    assert.equal(calls[0].url,'/api/composer-plus.grants?detail=1','the client asks for the time left');
    const [,G3]=regs3.find(([o])=>o.id==='chat-tool-grants');
    const chipOf=(sid)=>{si=0;effects=[];state=[];const r=G3({sessionId:sid,useSessionStatus:sel=>sel(new Map()),t});return r?.c[0];};
    assert.match(chipOf('sT').p.title,/execute_sql_prod \(until /,'the chip names the end time');
    const b1=ask('sT',LIVE);pub(new Map([['sT',{pendingInteraction:b1}]]));await tick();assert.deepEqual(b1.answers,['allowed-once'],'answered within the time');
    now+=11*60e3;fire();
    assert.equal(chipOf('sT'),undefined,'the chip drops an ended grant');
    const b2=ask('sT',LIVE);pub(new Map([['sT',{pendingInteraction:b2}]]));await tick();assert.deepEqual(b2.answers,[],'ended: the user is asked again');
    // A grant from a click: its end time follows the setting (15 min here); the card's button names the time.
    reply=(b)=>({ttlMs:900e3,grants:b?.action==='grant'?{sN:{[LIVE]:900e3}}:{}});
    const settingsRow=()=>{const [,S]=regs3.find(([o])=>o.id==='composer-plus');return S;};
    // Settings' Time limit row (GrantTtl) loads the setting from the Host.
    const ttlRow=()=>{si=0;effects=[];state=[];const tree=settingsRow()({useComposerPlusToggles:f=>f({}),setFeature:()=>{},t});
      const row=tree.c.slice(5).find(r=>r.p.key==='allowForChat');return row.c[1].c.find(c=>c?.t?.name==='GrantTtl');};
    const g=ttlRow();assert.ok(g,'Settings has a Time limit row under Allow for this chat');
    const renderTtl=()=>{si=0;effects=[];state=[];const r=g.t(g.p);return r;};
    let row=renderTtl();effects.forEach(f=>f());await tick();await tick();
    row=renderTtl();assert.equal(row.c[1].p.selectedId,'900000','the saved 15 min shows');
    assert.deepEqual(row.c[1].p.items.map(i=>i.id),['900000','3600000','14400000','28800000','null']);
    assert.equal(row.c[1].p.items.at(-1).label,'Until revoked');
    const b3=ask('sN',LIVE);pub(new Map([['sN',{pendingInteraction:b3}]]));
    si=0;effects=[];state=[];G3({sessionId:'sN',useSessionStatus:sel=>sel(sn),t});effects[0]();
    si=0;effects=[];const out3=G3({sessionId:'sN',useSessionStatus:sel=>sel(sn),t});
    assert.match(out3.c[1].portal.p.title,/in this chat for 15 minutes/,'the button says how long');
    out3.c[1].portal.p.onClick();await tick();await tick();
    assert.deepEqual(b3.answers,['allowed-once']);assert.deepEqual(calls.at(-1).body,{action:'grant',sessionId:'sN',tool:LIVE});
    now+=16*60e3;fire();
    const b4=ask('sN',LIVE);pub(new Map([['sN',{pendingInteraction:b4}]]));await tick();assert.deepEqual(b4.answers,[],'15 min limit: asked again after 16 min');
    // Before its timer runs (a Mac that woke from sleep), an ended grant is not used either.
    reply=()=>({ttlMs:900e3,grants:{sW:{[LIVE]:1000}}});row=renderTtl();effects.forEach(f=>f());await tick();await tick();
    timers.length=0;now+=5000;
    const b5=ask('sW',LIVE);pub(new Map([['sW',{pendingInteraction:b5}]]));await tick();assert.deepEqual(b5.answers,[],'ended before its timer ran');
    // Order: a read that is still running when the user revokes never brings the grant back (one queue, newest change wins).
    reply=(b)=>(b===undefined?{ttlMs:3600e3,grants:{sO:{[LIVE]:3600e3}}}:{ttlMs:3600e3,grants:{}});
    let open;gates.push(new Promise(r=>{open=r;}));
    row=renderTtl();effects.forEach(f=>f()); // read 1 starts and waits
    si=0;effects=[];state=[];
    // The read's answer would add sO; the user revokes sO meanwhile.
    assert.equal(chipOf('sO'),undefined);
    // A revoke from the chip needs a chip: give one locally through a grant that the queue saves after the read.
    const b6=ask('sO',LIVE);pub(new Map([['sO',{pendingInteraction:b6}]]));
    si=0;effects=[];state=[];G3({sessionId:'sO',useSessionStatus:sel=>sel(sn),t});effects[0]();
    si=0;effects=[];const out6=G3({sessionId:'sO',useSessionStatus:sel=>sel(sn),t});out6.c[1].portal.p.onClick();await tick();
    si=0;effects=[];const chip6=G3({sessionId:'sO',useSessionStatus:sel=>sel(new Map()),t}).c[0];chip6.p.onClick();
    assert.equal(chipOf('sO'),undefined,'revoked at once');
    open();for(let i=0;i<6;i++)await tick();
    assert.deepEqual(calls.slice(-2).map(c=>c.body?.action??'read'),['grant','revoke'],'the queue keeps the order: the read first, then grant, revoke');
    assert.equal(calls.at(-3).body,undefined,'the read was sent before them');
    assert.equal(chipOf('sO'),undefined,'the older read answer does not bring the grant back');
    const b7=ask('sO',LIVE);pub(new Map([['sO',{pendingInteraction:b7}]]));await tick();assert.deepEqual(b7.answers,[],'asked again');
    // A read whose answer comes after a click (the grant is queued behind it) never takes that grant off the screen.
    let grantAnswer;const pendingGrant=new Promise(r=>{grantAnswer=r;});
    reply=(b)=>(b===undefined?{ttlMs:3600e3,grants:{}}:pendingGrant); // the read says "none"; the grant's answer comes later
    let openR;gates.push(new Promise(r=>{openR=r;}));
    row=renderTtl();effects.forEach(f=>f());
    const b9=ask('sR2',LIVE);pub(new Map([['sR2',{pendingInteraction:b9}]]));
    si=0;effects=[];state=[];G3({sessionId:'sR2',useSessionStatus:sel=>sel(sn),t});effects[0]();
    si=0;effects=[];G3({sessionId:'sR2',useSessionStatus:sel=>sel(sn),t}).c[1].portal.p.onClick();await tick();
    openR();for(let i=0;i<4;i++)await tick();
    assert.ok(chipOf('sR2'),'the grant stays on screen: the older read answer is not used');
    const b10=ask('sR2',LIVE);pub(new Map([['sR2',{pendingInteraction:b10}]]));await tick();assert.deepEqual(b10.answers,['allowed-once']);
    grantAnswer({ttlMs:3600e3,grants:{sR2:{[LIVE]:3600e3}}});for(let i=0;i<4;i++)await tick();
    assert.ok(chipOf('sR2'),'the grant answer keeps it');
    // Time setting: one change at a time; a refused change puts the old value back with the reason.
    reply=()=>({ttlMs:3600e3,grants:{}});row=renderTtl();effects.forEach(f=>f());await tick();await tick();
    let rel;gates.push(new Promise(r=>{rel=r;}));
    row=renderTtl();row.c[1].p.onSelect('14400000');row.c[1].p.onSelect('28800000');
    row=renderTtl();assert.equal(row.c[1].p.anchor.p.disabled,true,'busy while saving');
    rel();for(let i=0;i<4;i++)await tick();
    assert.deepEqual(calls.filter(c=>c.body&&'ttlMs' in c.body).map(c=>c.body.ttlMs),[14400000],'the second change while one runs is ignored');
    globalThis.fetch=async(url)=>(String(url).includes('grants')?{ok:false,status:400,json:async()=>({error:'bad request'})}:{ok:false,status:404,json:async()=>({})});
    row=renderTtl();row.c[1].p.onSelect('null');for(let i=0;i<4;i++)await tick();
    row=renderTtl();assert.notEqual(row.c[1].p.selectedId,'null','refused: the old value stays');assert.match(row.c[2].c[0],/not saved: bad request/);
    // An older Host half answers the old shape: grants work without a time, and Settings says to restart dsh.
    globalThis.fetch=async(url)=>(String(url).includes('grants')?{ok:true,json:async()=>({sOld:[LIVE]})}:{ok:false,status:404,json:async()=>({})});
    row=renderTtl();effects.forEach(f=>f());await tick();await tick();
    row=renderTtl();assert.equal(row.c[2].c[0],'Restart dsh to use time limits.');
    const b8=ask('sOld',LIVE);pub(new Map([['sOld',{pendingInteraction:b8}]]));await tick();assert.deepEqual(b8.answers,['allowed-once']);
    globalThis.fetch=grantsFetch;reply=()=>({ttlMs:3600e3,grants:{sU:{[LIVE]:600e3}}});row=renderTtl();effects.forEach(f=>f());for(let i=0;i<4;i++)await tick();
    assert.ok(timers.length>0,'a timed grant has a timer');
    // Switch off: the timer stops, and a Host answer that comes later starts none (rule 1: off removes what it added).
    const sec=regs3.find(([o])=>o.id==='composer-plus')[0].inject();
    let lateOpen;gates.push(new Promise(r=>{lateOpen=r;}));
    reply=()=>({ttlMs:3600e3,grants:{sU:{[LIVE]:600e3}}});row=renderTtl();effects.forEach(f=>f()); // a read waits at the gate
    sec.setFeature('allowForChat',false);
    assert.equal(timers.length,0,'switch off clears the timer');
    lateOpen();for(let i=0;i<4;i++)await tick();
    assert.equal(timers.length,0,'a late Host answer after the switch off starts no timer');
    sec.setFeature('allowForChat',true);for(let i=0;i<4;i++)await tick();
    assert.ok(timers.length>0,'switch on loads the grants and starts the timer again');
    for(const d of un3)d();assert.equal(timers.length,0,'unload clears the timer');
  } finally { Date.now=realNow;globalThis.setTimeout=realST;globalThis.clearTimeout=realCT; }
}
console.log('chat-grant checks passed');
