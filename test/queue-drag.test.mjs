// Runs the real client.js QueueReorder with fake React/DOM: grip placement, drag order, rotation edits, revert, edges.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../client.js',import.meta.url),'utf8');
let mod;globalThis.window={__ModuleLoader__:{load:m=>{mod=m;}},listeners:{},addEventListener(t,f){this.listeners[t]=f;},removeEventListener(t){delete this.listeners[t];}};eval(src);
globalThis.MutationObserver=class{observe(){}disconnect(){}};
const el=(tag)=>{const e={tagName:tag,attrs:{},style:{},children:[],setAttribute(k,v){this.attrs[k]=v;},hasAttribute(k){return k in this.attrs;},
 get firstElementChild(){return this.children[0]??null;},get firstChild(){return this.children[0]??null;},insertBefore(n,ref){const i=ref?this.children.indexOf(ref):this.children.length;this.children.splice(i,0,n);n.parent=this;},
 remove(){this.parent.children.splice(this.parent.children.indexOf(this),1);},querySelector:()=>null};return e;};
globalThis.document={createElement:el,body:{style:{}}};
const lis=[0,1,2,3].map(i=>{const li=el('li');li.children.push(el('span'));li.getBoundingClientRect=()=>({top:i*40,height:40});return li;});
const seat={querySelector:()=>({querySelectorAll:()=>lis}),querySelectorAll:()=>lis.flatMap(li=>li.children.filter(c=>c.hasAttribute('data-queue-grip')))};
let state=[],si=0,layout=[];
const React={useRef:()=>({current:{closest:()=>seat}}),useState:v=>{const i=si++;if(!(i in state))state[i]=v;return [state[i],x=>{state[i]=typeof x==='function'?x(state[i]):x;}];},
 useMemo:f=>f(),useLayoutEffect:f=>layout.push(f),createElement:(t,p,...c)=>({t,p,c}),Fragment:'F'};
const plugin=mod.factory(n=>n==='react'?React:{createPortal:(e,host,key)=>({portal:e,host,key})});
const regs=[];plugin.apply({sessions:{scope:()=>undefined},slots:{inject:(n,f)=>f(),register:(o,C)=>{regs.push([o,C]);return()=>{};}}});
const [,C]=regs.find(([o])=>o.id==='queue-reorder');
const row=(id,text)=>({id,source:{kind:'user'},content:[{type:'text',text}]});
let rows=['A','B','C','D'].map((t,i)=>row('r'+i,t));let calls=[],fail=null,notes=[];
const updateQueue=async(id,a)=>{calls.push([id,a.content[0].text]);if(fail?.(id,calls.length))throw Error('claimed');};
const render=()=>{si=0;layout=[];return C({useSession:s=>s({pendingSubmissions:[],subagent:null}),useProjection:()=>({'next-turn':rows}),updateQueue,notify:(l,t)=>notes.push(t)});};
render();const cleanup=layout[0]();let out=render();
assert.ok(lis.every(li=>li.children[0].hasAttribute('data-queue-grip')),'grip host is the first (leftmost) child');
assert.equal(out.c.length,5);const grip=i=>out.c[1+i].portal;assert.equal(out.c[1].host,lis[0].children[0]);
const tick=()=>new Promise(r=>setTimeout(r,5));
// drag D (index 3) above B: pointer to y=50 (between A and B midpoints → slot 1)
grip(3).p.onPointerDown({button:0,preventDefault(){}});window.listeners.pointermove({clientY:50});assert.equal(lis[3].style.opacity,'0.5');
window.listeners.pointerup();await tick();
assert.deepEqual(calls,[['r3','C'],['r2','B'],['r1','D']],'rotate tail→head: A D B C');assert.equal(lis[3].style.opacity,'');
// keyboard: ArrowUp on row 1 swaps with row 0
calls=[];out=render();grip(1).p.onKeyDown({key:'ArrowUp',preventDefault(){}});await tick();assert.deepEqual(calls,[['r1','A'],['r0','B']]);
// failure on second edit reverts the first
calls=[];fail=(id)=>id==='r0';out=render();grip(1).p.onKeyDown({key:'ArrowUp',preventDefault(){}});await tick();
assert.deepEqual(calls,[['r1','A'],['r0','B'],['r1','B']]);assert.equal(notes.length,1);fail=null;
// escape cancels, edges and image rows
calls=[];out=render();grip(0).p.onPointerDown({button:0,preventDefault(){}});window.listeners.pointermove({clientY:150});window.listeners.keydown({key:'Escape',preventDefault(){}});await tick();assert.deepEqual(calls,[]);
grip(0).p.onKeyDown({key:'ArrowUp',preventDefault(){}});await tick();assert.deepEqual(calls,[],'first row cannot go up');
rows[2]={id:'r2',source:{kind:'user'},content:[{type:'image'}]};out=render();assert.equal(grip(2).p.disabled,true);
grip(3).p.onPointerDown({button:0,preventDefault(){}});window.listeners.pointermove({clientY:10});window.listeners.pointerup();await tick();assert.deepEqual(calls,[],'cannot cross an image row');
grip(1).p.onPointerDown({button:0,preventDefault(){}});window.listeners.pointermove({clientY:10});window.listeners.pointerup();await tick();assert.deepEqual(calls,[['r1','A'],['r0','B']]);
cleanup();assert.ok(lis.every(li=>!li.children[0].hasAttribute('data-queue-grip')),'cleanup removes grip hosts');
rows=rows.slice(0,1);state=[];render();layout[0]();assert.equal(render().c.length,0,'1 row: no grips');
console.log('queue-drag checks passed');
