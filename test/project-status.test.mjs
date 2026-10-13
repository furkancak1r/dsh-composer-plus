// Runs the real client.js ProjectStatusMarkers with fake React/DOM: a project row shows the same status as its
// chats (pending > running incl. subagents > unread done), ignores archived/blank/subagent chats, and portals
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
assert.equal(marks.w1.state,'ongoing','running beats unread done');assert.equal(marks.w1.label,'project.running:1');
assert.equal(marks.w2.state,'warning','approval wins over subagent running; blank chat ignored');assert.equal(marks.w2.label,'project.approval');
assert.equal(marks.w1.host,rows[0].children[0],'portaled into the project row');
statuses.delete('d');list.byId.b[1]=undefined;Object.assign(list.byId.b,{running:false});
const out2=render();const m2=Object.fromEntries(out2.c.map(p=>[p.key,p.portal.c[0].p.state]));
assert.deepEqual(m2,{w1:'done',w2:'ongoing'},'unread done; subagent running counts for its parent');
statuses.delete('a');statuses.delete('kid');assert.equal(render().c.length,0,'idle projects show nothing');
console.log('project-status checks passed');
