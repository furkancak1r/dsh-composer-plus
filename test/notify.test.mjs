// Runs the real client.js attention notifications with fake Notification/window/uiSession.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const src=readFileSync(process.env.CLIENT??new URL('../client.js',import.meta.url),'utf8');
let mod;globalThis.window={__ModuleLoader__:{load:m=>{mod=m;}},focus(){this.focused++;},focused:0,addEventListener(t,f){this.l=f;},removeEventListener(){this.l=null;}};eval(src);
let focus=false;globalThis.document={hasFocus:()=>focus};let badgeN=0;Object.defineProperty(globalThis,'navigator',{value:{setAppBadge:n=>{badgeN=n;return Promise.resolve();},clearAppBadge:()=>{badgeN=0;return Promise.resolve();}},configurable:true});
const shown=[];let perm='granted',asked=0;
globalThis.Notification=class{static get permission(){return perm;}static requestPermission(){asked++;return Promise.resolve('granted');}
 constructor(title,o){this.title=title;this.body=o.body;this.tag=o.tag;this.closed=false;shown.push(this);}close(){this.closed=true;}};
globalThis.queueMicrotask=f=>f();
let timers=[];globalThis.setTimeout=(f,ms)=>{const t={f,ms,live:true};timers.push(t);return t;};globalThis.clearTimeout=t=>{if(t)t.live=false;};
const flush=()=>{const due=timers;timers=[];for(const t of due)if(t.live)t.f();};
const React={useState:v=>[v,()=>{}],useEffect:()=>{},useSyncExternalStore:(s,g)=>g(),createElement:()=>({}),Fragment:'F'};
const plugin=mod.factory(n=>n==='react'?React:n==='react-dom'?{createPortal:()=>({})}:{Button:'Button'});
let snap=new Map(),ls=new Set();const status={getSnapshot:()=>snap,subscribe:l=>{ls.add(l);return()=>ls.delete(l);}};
const pub=m=>{snap=m;for(const l of [...ls])l();};
let outline=[];const list={getSnapshot:()=>({byId:{s1:{displayTitle:'Fix login'},s2:{displayTitle:'Sub',origin:'subagent'}},projectionsBySession:{s1:{values:{turnOutline:outline}}}})};
const opened=[];const dicts={};const offs=[];
plugin.apply({effect:f=>{const d=f();if(d)offs.push(d);},locale:{register:(ns,d)=>{dicts[ns]=d;return()=>{};},bind:ns=>(k,p={})=>dicts[ns].en[k].replace(/\{(\w+)\}/g,(_,x)=>p[x])},
 inject:(names,cb)=>{if(names.includes('sidebarRight')||names.includes('workspaces')||names[0]==='uiWorkspace')return{dispose(){}};if(names.includes('uiWorkspace'))cb({uiSession:{sessionStatus:status},sessions:{list},uiWorkspace:{openSession:id=>opened.push(id)},effect:f=>offs.push(f())});else cb({uiSession:{sessionStatus:status},effect:f=>offs.push(f())});return{dispose(){}};},
 slots:{inject:(n,f)=>f(),register:()=>()=>{}}});
const en=Object.values(dicts)[0].en,zh=Object.values(dicts)[0].zh;for(const k of ['notify.done','notify.approval','notify.question','notify.planReview'])assert.ok(en[k]&&zh[k],k);
const st=(o={})=>({running:false,pendingInteraction:undefined,completionUnread:false,...o});
// Turn finishes in the background -> one "Finished." notification titled with the chat name.
pub(new Map([['s1',st({running:true})]]));assert.equal(shown.length,0);
pub(new Map([['s1',st({running:false})]]));assert.equal(shown.length,1);assert.equal(shown[0].title,'Fix login');assert.equal(shown[0].body,en['notify.done']);
pub(new Map([['s1',st({running:false})]]));assert.equal(shown.length,1,'same state: no repeat');
// A turn that ends waiting on a question reports the question, not "Finished".
// Notifications are not closed on their own (they stay in Notification Center).
assert.equal(shown[0].closed,false);
// Click opens that chat.
shown[0].onclick();assert.deepEqual(opened,['s1']);assert.equal(window.focused,1);
// Approval / question / plan review, each once per new request, after the grace period.
const ask=(kind,extra={})=>({kind,key:`${kind}:${Math.random()}`,answerable:true,...extra});
const ap=ask('approval'),q=ask('question'),pr=ask('plan-review');
pub(new Map([['s1',st({pendingInteraction:ap})]]));assert.equal(shown.length,1,'nothing before the grace period');flush();
pub(new Map([['s1',st({pendingInteraction:{...ap}})]]));flush();assert.equal(shown.length,2,'same request (same key) rebuilt by dsh: no repeat');
pub(new Map([['s1',st({pendingInteraction:q})]]));flush();pub(new Map([['s1',st({pendingInteraction:pr})]]));flush();
assert.deepEqual(shown.slice(1).map(n=>n.body),[en['notify.approval'],en['notify.question'],en['notify.planReview']]);
// A request answered automatically (grant, plugin, Auto Review) inside the grace period never notifies.
let n1=shown.length;const auto=ask('approval',{toolName:'mcp__db__read'});
pub(new Map([['s1',st({pendingInteraction:auto})]]));pub(new Map([['s1',st({running:true})]]));flush();assert.equal(shown.length,n1,'auto-answered: silent');
// Answered but still listed (answerable flips false): also silent.
const flip=ask('approval');pub(new Map([['s1',st({pendingInteraction:flip})]]));flip.answerable=false;pub(new Map([['s1',st({pendingInteraction:flip})]]));flush();assert.equal(shown.length,n1,'settled: silent');
// A notification whose request is answered later (in dsh or elsewhere) is withdrawn from Notification Center.
const late=ask('approval');pub(new Map([['s1',st({pendingInteraction:late})]]));flush();assert.equal(shown.length,n1+1);
assert.equal(badgeN,1,'badge counts the chat waiting for you');
const lateN=shown.at(-1);pub(new Map([['s1',st({running:true})]]));assert.equal(lateN.closed,true,'answered: withdrawn');assert.equal(badgeN,0,'and its badge cleared');
// Richer bodies: tool name, question text, reply preview; badge counts unread chats and clears on focus.
const fmt=(k,p={})=>en[k].replace(/\{(\w+)\}/g,(_,x)=>p[x]);
pub(new Map([['s1',st()]]));pub(new Map([['s1',st({pendingInteraction:ask('approval',{toolName:'mcp__db__execute_sql_prod'})})]]));flush();
assert.equal(shown.at(-1).body,fmt('notify.approvalTool',{tool:'mcp__db__execute_sql_prod'}));
pub(new Map([['s1',st({pendingInteraction:ask('question',{questions:[{question:'\n  Which branch should I use?\nmore'}]})})]]));flush();
assert.equal(shown.at(-1).body,fmt('notify.questionText',{text:'Which branch should I use?'}));
outline=[{turn:1,response:'old'},{turn:2,response:'Deployed v2 to staging.\nDetails…'}];
pub(new Map([['s1',st({running:true})]]));pub(new Map([['s1',st()]]));
assert.equal(shown.at(-1).body,'Deployed v2 to staging.','finish shows the reply preview');
assert.equal(badgeN,1,'a finished chat stays in the badge');window.l();assert.equal(badgeN,0,'focus clears the badge');
// Subagent chats, focused window and denied permission stay quiet.
const n0=shown.length;pub(new Map([['s2',st({running:true})]]));pub(new Map([['s2',st()]]));
focus=true;pub(new Map([['s1',st({running:true})]]));pub(new Map([['s1',st()]]));focus=false;
perm='denied';pub(new Map([['s1',st({running:true})]]));pub(new Map([['s1',st()]]));assert.equal(shown.length,n0);
assert.equal(asked,0,'granted/denied: never re-asks');
// Unload stops notifications.
perm='granted';for(const d of offs)if(typeof d==='function')d();pub(new Map([['s1',st({running:true})]]));pub(new Map([['s1',st()]]));assert.equal(shown.length,n0);
console.log('notify checks passed');
