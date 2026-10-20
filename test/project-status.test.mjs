// Runs the real client.js ProjectStatusMarkers with fake React/DOM: a project row shows the same status as its
// chats (pending > unread done > running incl. subagents), ignores archived/blank/subagent chats, and portals
// the marker into each `workspace:<id>` row.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../client.js',import.meta.url),'utf8');
let mod;globalThis.window={__ModuleLoader__:{load:m=>{mod=m;}}};eval(src);
const mkEl=(attrs={})=>({attrs,children:[],isConnected:true,style:{},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k];},
 querySelector(){return this.children.find(c=>'data-composer-plus-project-status' in c.attrs)??null;},
 insertBefore(n){this.children.unshift(n);},remove(){}});
const rows=[mkEl({'data-row-key':'workspace:w1'}),mkEl({'data-row-key':'workspace:w2'}),mkEl({'data-row-key':'workspace:w3'})];
globalThis.document={createElement:()=>mkEl(),querySelectorAll:q=>q.includes('workspace:')?rows:[],body:{}};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
let state=[],si=0,layout=[];
const React={useState:v=>{const i=si++;if(!(i in state))state[i]=v;return [state[i],x=>{state[i]=typeof x==='function'?x(state[i]):x;}];},
 useMemo:f=>f(),useLayoutEffect:f=>layout.push(f),createElement:(t,p,...c)=>({t,p,c}),Fragment:'F'};
const StateDot=()=>null;
const plugin=mod.factory(n=>n==='react'?React:n==='react-dom'?{createPortal:(el,host,key)=>({portal:el,host,key})}:n==='@deepseek-ai/dsh-client-ui-primitives'?{StateDot}:{});
const regs=[];plugin.apply({slots:{inject:(n,f)=>f(),register:(o,C)=>{regs.push([o,C]);return()=>{};}}});
const [opt,C]=regs.find(([o])=>o.id==='project-status');assert.equal(opt.name,'shell.overlay');
const summary=(id,o={})=>[id,{id,blank:false,running:false,origin:'user',...o}];
const list={byId:Object.fromEntries([summary('a'),summary('b',{running:true}),summary('c'),summary('d'),summary('e',{blank:true,running:true}),summary('f',{running:true}),summary('kid')]),
 projectionsBySession:{c:{values:{subagentCatalog:[{id:'kid'}]}}}};
const statuses=new Map([['a',{completionUnread:true}],['d',{pendingInteraction:{kind:'approval'}}],['kid',{running:true}]]);
const workspaces={items:[{workspaceId:'w1',sessionIds:['a','b']},{workspaceId:'w2',sessionIds:['c','d','e']},{workspaceId:'w3',sessionIds:['f']}],archivedSessionIds:['f']};
const render=()=>{si=0;layout=[];return C({useWorkspaces:f=>f(workspaces),useSessions:f=>f(list),useSessionStatus:f=>f(statuses),t:(k,v)=>v?`${k}:${v.count}`:k});};
render();layout[0]();const out=render();
const marks=Object.fromEntries(out.c.map(p=>[p.key,{state:p.portal.c[0].p.state,label:p.portal.p.title,host:p.host}]));
assert.deepEqual(Object.keys(marks).sort(),['w1','w2'],'w3 only has an archived chat');
// A finished chat that is not opened yet shows its green dot also while another chat of the project runs.
assert.equal(marks.w1.state,'done','unread done beats running');assert.equal(marks.w1.label,'project.done · project.running:1','the label still says one runs');
assert.equal(marks.w2.state,'warning','approval wins over subagent running; blank chat ignored');assert.equal(marks.w2.label,'project.approval');
assert.equal(marks.w1.host,rows[0].children[0],'portaled into the project row');
statuses.delete('d');list.byId.b[1]=undefined;Object.assign(list.byId.b,{running:false});
const out2=render();const m2=Object.fromEntries(out2.c.map(p=>[p.key,p.portal.c[0].p.state]));
assert.deepEqual(m2,{w1:'done',w2:'ongoing'},'unread done; subagent running counts for its parent');
statuses.delete('a');Object.assign(list.byId.b,{running:true});
const m3=Object.fromEntries(render().c.map(p=>[p.key,p.portal.c[0].p.state]));
assert.equal(m3.w1,'ongoing','once the done chat is opened (no green dot), the running chat shows');
Object.assign(list.byId.b,{running:false});statuses.delete('kid');assert.equal(render().c.length,0,'idle projects show nothing');
console.log('project-status checks passed');

// Active projects first: the real watcher moves running/waiting projects above idle ones with dsh's insertBefore,
// keeps relative order, never moves a finished project down, and serializes overlapping updates.
{
  const listeners=[];const store=(get)=>({getSnapshot:get,subscribe:(f)=>{listeners.push(f);return()=>listeners.splice(listeners.indexOf(f),1);}});
  let items=['p1','p2','p3','p4'].map((id,i)=>({workspaceId:id,sessionIds:['s'+(i+1)]}));
  const byId=Object.fromEntries(['s1','s2','s3','s4'].map(id=>[id,{id,blank:false,running:false,origin:'user'}]));
  const st=new Map();const calls=[];
  const workspaces={list:store(()=>({items,archivedSessionIds:[]})),insertBefore:async(id,before)=>{calls.push([id,before]);
    const ids=items.map(i=>i.workspaceId).filter(x=>x!==id);ids.splice(ids.indexOf(before),0,id);items=ids.map(x=>items.find(i=>i.workspaceId===x));}};
  const regs2=[];let watch;
  plugin.apply({slots:{inject:(n,f)=>f(),register:()=>()=>{}},locale:{register:()=>()=>{},bind:()=>k=>k},effect:(f)=>f(),inject:(deps,f)=>{if(deps[0]==='workspaces')watch=f;}});
  let stop;watch({workspaces,sessions:{list:store(()=>({byId,projectionsBySession:{}}))},uiSession:{sessionStatus:store(()=>st)},effect:(f)=>{stop=f();}});
  const tick=()=>new Promise(r=>setTimeout(r,0));
  await tick();assert.deepEqual(calls,[],'nothing active, nothing moves');
  byId.s3.running=true;st.set('s4',{pendingInteraction:{kind:'question'}});listeners.forEach(f=>f());await tick();await tick();
  assert.deepEqual(items.map(i=>i.workspaceId),['p3','p4','p1','p2'],'running and waiting projects go to the top in their order');
  calls.length=0;byId.s3.running=false;st.set('s3',{completionUnread:true});st.delete('s4');listeners.forEach(f=>f());await tick();
  assert.deepEqual(calls,[],'finished projects stay where they are');
  // A project with a green dot and a running chat is still active: it goes to the top.
  calls.length=0;st.set('s1',{completionUnread:true});byId.s1.running=false;byId.s4.running=true;st.set('s4',{completionUnread:true});listeners.forEach(f=>f());await tick();await tick();
  assert.deepEqual(items.map(i=>i.workspaceId),['p4','p3','p1','p2'],'done + running still counts as active');
  byId.s4.running=false;st.delete('s4');st.delete('s1');st.delete('s3');listeners.forEach(f=>f());await tick();
  items=['p3','p4','p1','p2'].map(id=>items.find(i=>i.workspaceId===id));calls.length=0;
  byId.s2.running=true;listeners.forEach(f=>f());listeners.forEach(f=>f());await tick();await tick();
  assert.deepEqual(items.map(i=>i.workspaceId),['p2','p3','p4','p1']);assert.equal(calls.length,1,'overlapping updates move once');
  stop();assert.equal(listeners.length,0,'unsubscribes');
}
console.log('active-first checks passed');
