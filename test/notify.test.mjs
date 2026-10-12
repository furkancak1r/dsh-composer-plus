// Runs the real client.js attention notifications with fake Notification/window/uiSession.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const src=readFileSync(process.env.CLIENT??new URL('../client.js',import.meta.url),'utf8');
let mod;globalThis.window={__ModuleLoader__:{load:m=>{mod=m;}},focus(){this.focused++;},focused:0,addEventListener(){throw new Error('no window listeners');},removeEventListener(){}};eval(src);
let focus=false;globalThis.document={hasFocus:()=>focus};
const shown=[];let perm='granted',asked=0;
globalThis.Notification=class{static get permission(){return perm;}static requestPermission(){asked++;return Promise.resolve('granted');}
 constructor(title,o){this.title=title;this.body=o.body;this.tag=o.tag;this.closed=false;shown.push(this);}close(){this.closed=true;}};
globalThis.queueMicrotask=f=>f();
const React={useState:v=>[v,()=>{}],useEffect:()=>{},useSyncExternalStore:(s,g)=>g(),createElement:()=>({}),Fragment:'F'};
const plugin=mod.factory(n=>n==='react'?React:n==='react-dom'?{createPortal:()=>({})}:{Button:'Button'});
let snap=new Map(),ls=new Set();const status={getSnapshot:()=>snap,subscribe:l=>{ls.add(l);return()=>ls.delete(l);}};
const pub=m=>{snap=m;for(const l of [...ls])l();};
const list={getSnapshot:()=>({byId:{s1:{displayTitle:'Fix login'},s2:{displayTitle:'Sub',origin:'subagent'}}})};
const opened=[];const dicts={};const offs=[];
plugin.apply({effect:f=>{const d=f();if(d)offs.push(d);},locale:{register:(ns,d)=>{dicts[ns]=d;return()=>{};},bind:ns=>k=>dicts[ns].en[k]},
 inject:(names,cb)=>{if(names.includes('uiWorkspace'))cb({uiSession:{sessionStatus:status},sessions:{list},uiWorkspace:{openSession:id=>opened.push(id)},effect:f=>offs.push(f())});else cb({uiSession:{sessionStatus:status},effect:f=>offs.push(f())});},
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
// Approval / question / plan review, each once per new request.
const ap={kind:'approval'},q={kind:'question'},pr={kind:'plan-review'};
pub(new Map([['s1',st({pendingInteraction:ap})]]));pub(new Map([['s1',st({pendingInteraction:ap})]]));
pub(new Map([['s1',st({pendingInteraction:q})]]));pub(new Map([['s1',st({pendingInteraction:pr})]]));
assert.deepEqual(shown.slice(1).map(n=>n.body),[en['notify.approval'],en['notify.question'],en['notify.planReview']]);
// Subagent chats, focused window and denied permission stay quiet.
const n0=shown.length;pub(new Map([['s2',st({running:true})]]));pub(new Map([['s2',st()]]));
focus=true;pub(new Map([['s1',st({running:true})]]));pub(new Map([['s1',st()]]));focus=false;
perm='denied';pub(new Map([['s1',st({running:true})]]));pub(new Map([['s1',st()]]));assert.equal(shown.length,n0);
assert.equal(asked,0,'granted/denied: never re-asks');
// Unload stops notifications.
perm='granted';for(const d of offs)if(typeof d==='function')d();pub(new Map([['s1',st({running:true})]]));pub(new Map([['s1',st()]]));assert.equal(shown.length,n0);
console.log('notify checks passed');
