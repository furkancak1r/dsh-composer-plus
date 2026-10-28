// Runs the real client.js QueueReorder with fake React/DOM: grip placement, drag order, rotation edits, revert, edges.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../client.js',import.meta.url),'utf8');
let mod;globalThis.window={__ModuleLoader__:{load:m=>{mod=m;}},listeners:{},addEventListener(t,f){this.listeners[t]=f;},removeEventListener(t){delete this.listeners[t];}};eval(src);
// observed: dsh's dock scan (watches the seat). listObs: the drag's watch on the list (dsh redraws the rows).
let observed,listObs;globalThis.MutationObserver=class{constructor(f){this.f=f;}observe(t){if(t===seat)observed=this.f;else listObs=this;}disconnect(){if(listObs===this)listObs=null;}};
const el=(tag)=>{const e={tagName:tag,isConnected:true,attrs:{},style:{},children:[],setAttribute(k,v){this.attrs[k]=v;},hasAttribute(k){return k in this.attrs;},removeAttribute(k){delete this.attrs[k];},
 get firstElementChild(){return this.children[0]??null;},get firstChild(){return this.children[0]??null;},get parentElement(){return this.parent??null;},insertBefore(n,ref){const i=ref?this.children.indexOf(ref):this.children.length;this.children.splice(i,0,n);n.parent=this;},
 appendChild(n){this.children.push(n);n.parent=this;return n;},cloneNode(){const c=el(this.tagName);c.attrs={...this.attrs};c.style={...this.style};c.getBoundingClientRect=this.getBoundingClientRect;return c;},
 getBoundingClientRect:()=>({top:0,bottom:0,left:0,width:0,height:0}),closest:()=>seat,
 remove(){this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=undefined;},querySelector:()=>null};return e;};
globalThis.document={createElement:el,body:el('body'),head:el('head')};
const list=el('ul');list.scrollTop=0;
const lis=[0,1,2,3].map(i=>{const li=el('li');li.children.push(el('span'));li.getBoundingClientRect=()=>({top:i*40,bottom:i*40+40,left:0,width:300,height:40});list.appendChild(li);return li;});
const seat={querySelector:()=>({querySelectorAll:()=>lis}),querySelectorAll:()=>lis.flatMap(li=>li.children.filter(c=>c.hasAttribute('data-queue-grip')))};
const ghost=()=>document.body.children.find(c=>c.tagName==='li');
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
let state=[],si=0,layout=[];
const React={useRef:()=>({current:{closest:()=>seat}}),useState:v=>{const i=si++;if(!(i in state))state[i]=v;return [state[i],x=>{state[i]=typeof x==='function'?x(state[i]):x;}];},
 useMemo:f=>f(),useSyncExternalStore:(_,get)=>get(),useLayoutEffect:f=>layout.push(f),createElement:(t,p,...c)=>({t,p,c}),Fragment:'F'};
const plugin=mod.factory(n=>n==='react'?React:{createPortal:(e,host,key)=>({portal:e,host,key})});
const regs=[];plugin.apply({sessions:{scope:()=>undefined},slots:{inject:(n,f)=>f(),register:(o,C)=>{regs.push([o,C]);return()=>{};}}});
const [,C]=regs.find(([o])=>o.id==='queue-reorder');
const row=(id,text)=>({id,source:{kind:'user'},content:[{type:'text',text}]});
let rows=['A','B','C','D'].map((t,i)=>row('r'+i,t));let calls=[],fail=null,notes=[];
const updateQueue=async(id,a)=>{calls.push([id,a.content[0].text]);if(fail?.(id,calls.length))throw Error('claimed');};
// Older Host without /api/composer-plus.queue-move: it answers 404, so the client rotates texts (the checks below).
let moves=[],hostAnswer=()=>false;const moveQueued=async(b)=>{moves.push(b);return hostAnswer(b);};
const render=()=>{si=0;layout=[];return C({useSession:s=>s({pendingSubmissions:[],subagent:null}),useProjection:()=>({'next-turn':rows}),updateQueue,notify:(l,t)=>notes.push(t),t:k=>k,sessionId:'s1',moveQueued});};
render();const cleanup=layout[0]();let out=render();
assert.ok(lis.every(li=>li.children[0].hasAttribute('data-queue-grip')),'grip host is the first (leftmost) child');
assert.equal(out.c.length,5);const grip=i=>out.c[1+i].portal;assert.equal(out.c[1].host,lis[0].children[0]);
const tick=()=>new Promise(r=>setTimeout(r,5));
// editing a row hides its grip; when editing ends the grip comes back (regression: it stayed hidden)
let before=state[0];lis[1].querySelector=(q)=>q==='textarea'?{}:null;observed();assert.notEqual(state[0],before,'edit start triggers a re-render');out=render();assert.equal(out.c.length,4,'edited row has no grip');
before=state[0];lis[1].querySelector=()=>null;observed();assert.notEqual(state[0],before,'edit end triggers a re-render');out=render();assert.equal(out.c.length,5,'grip returns after editing');assert.equal(out.c[2].host,lis[1].children[0]);

// drag D (index 3) above B: pointer to y=50 (between A and B midpoints → slot 1)
grip(3).p.onPointerDown({button:0,clientY:130,preventDefault(){}});
// picked up: a raised copy of the row floats in <body>; the row itself is the empty slot
assert.ok(ghost(),'a lifted card is in <body>');assert.match(ghost().style.transform,/scale\(1\.03\)/);assert.match(ghost().style.boxShadow,/16px 32px/);
assert.equal(ghost().style.position,'fixed');assert.equal(ghost().style.pointerEvents,'none');assert.ok(lis[3].hasAttribute('data-queue-drag-slot'));
assert.ok(document.head.children.length===1,'drag styles are on');
window.listeners.pointermove({clientY:50});
assert.match(ghost().style.transform,/translateY\(-80px\)/,'the card follows the pointer');
assert.deepEqual(lis.map(li=>li.style.transform),['','translateY(40px)','translateY(40px)','translateY(-80px)'],'B and C slide down, the slot goes to place 1');
window.listeners.pointerup();await tick();
assert.deepEqual(moves,[{sessionId:'s1',itemId:'r3',to:1,before:['r0','r1','r2','r3']}],'the Host route is asked first');
out=render();assert.equal(state[2],false,'404: the client remembers that this Host has no route');
assert.deepEqual(calls,[['r3','C'],['r2','B'],['r1','D']],'rotate tail→head: A D B C');
assert.equal(ghost(),undefined,'text edits: the card is gone before the texts change');assert.ok(lis.every(li=>li.style.transform===''&&!li.hasAttribute('data-queue-drag-slot')));
assert.equal(document.head.children.length,0,'drag styles are off');
// keyboard: ArrowUp on row 1 swaps with row 0
calls=[];out=render();grip(1).p.onKeyDown({key:'ArrowUp',preventDefault(){}});await tick();assert.deepEqual(calls,[['r1','A'],['r0','B']]);
// failure on second edit reverts the first
calls=[];fail=(id)=>id==='r0';out=render();grip(1).p.onKeyDown({key:'ArrowUp',preventDefault(){}});await tick();
assert.deepEqual(calls,[['r1','A'],['r0','B'],['r1','B']]);assert.equal(notes.length,1);fail=null;
// escape cancels, edges and image rows
calls=[];out=render();grip(0).p.onPointerDown({button:0,clientY:10,preventDefault(){}});window.listeners.pointermove({clientY:150});window.listeners.keydown({key:'Escape',preventDefault(){}});
assert.equal(ghost().style.transform,'','Esc: the card goes back down to its place');assert.ok(lis.every(li=>li.style.transform===''),'Esc: the rows go back');
grip(1).p.onPointerDown({button:0,clientY:50,preventDefault(){}});assert.equal(window.listeners.pointermove,undefined,'no second drag while the card settles');
await wait(200);assert.equal(ghost(),undefined);assert.deepEqual(calls,[]);
grip(0).p.onKeyDown({key:'ArrowUp',preventDefault(){}});await tick();assert.deepEqual(calls,[],'first row cannot go up');
rows[2]={id:'r2',source:{kind:'user'},content:[{type:'image'}]};out=render();assert.equal(grip(2).p.disabled,true);
grip(3).p.onPointerDown({button:0,clientY:130,preventDefault(){}});window.listeners.pointermove({clientY:10});
assert.equal(ghost().style.opacity,'0.6','a place it cannot go: the card fades');assert.equal(document.body.style.cursor,'not-allowed');assert.ok(lis.every(li=>li.style.transform===''),'the rows do not part');
window.listeners.pointerup();await wait(200);assert.deepEqual(calls,[],'cannot cross an image row');assert.equal(ghost(),undefined);
grip(1).p.onPointerDown({button:0,clientY:50,preventDefault(){}});window.listeners.pointermove({clientY:10});window.listeners.pointerup();await tick();assert.deepEqual(calls,[['r1','A'],['r0','B']]);
cleanup();assert.ok(lis.every(li=>!li.children[0].hasAttribute('data-queue-grip')),'cleanup removes grip hosts');
rows=rows.slice(0,1);state=[];render();layout[0]();assert.equal(render().c.length,0,'1 row: no grips');

// New Host: the route moves any of your own rows, also one with an image, and no text edit runs.
{ state=[];si=0;moves=[];calls=[];notes=[];hostAnswer=()=>true;
  rows=[row('a','A'),{id:'b',source:{kind:'user'},content:[{type:'image'},{type:'text',text:'B'}]},row('c','C'),{id:'g',source:{kind:'goal'},content:[{type:'text',text:'G'}]}];
  lis.forEach(li=>{li.children.length=0;li.children.push(el('span'));li.querySelector=()=>null;});
  render();const off=layout[0]();out=render();
  assert.equal(grip(1).p.disabled,false,'an image row can move with the Host route');
  assert.equal(grip(3).p.disabled,true,'a goal round is not yours: no move');
  grip(2).p.onKeyDown({key:'ArrowUp',preventDefault(){}});await tick();
  assert.deepEqual(moves,[{sessionId:'s1',itemId:'c',to:1,before:['a','b','c','g']}]);assert.deepEqual(calls,[],'no text edits');
  grip(2).p.onKeyDown({key:'ArrowDown',preventDefault(){}});await tick();assert.equal(moves.length,1,'cannot cross a goal round');
  // a refusal (the queue changed) shows the failure and edits nothing
  hostAnswer=()=>{throw Error('the queue changed');};out=render();grip(1).p.onKeyDown({key:'ArrowUp',preventDefault(){}});await tick();
  assert.deepEqual(notes,['queue.failed']);assert.deepEqual(calls,[]);
  // Drop with the Host route: the card settles into the slot and the new order stays until dsh redraws the list.
  let release;hostAnswer=()=>new Promise(r=>{release=r;});notes=[];out=render();
  grip(2).p.onPointerDown({button:0,clientY:90,preventDefault(){}});window.listeners.pointermove({clientY:10});window.listeners.pointerup();
  assert.match(ghost().style.transform,/^translateY\(-80px\)$/,'dropped: the card goes down into the slot (no lift)');
  assert.deepEqual(lis.slice(0,3).map(li=>li.style.transform),['translateY(40px)','translateY(40px)','translateY(-80px)'],'the new order shows while the Host works');
  release(true);await tick();assert.ok(ghost(),'still there until dsh redraws');
  listObs.f();assert.equal(ghost(),undefined,'dsh redrew the list: the plain rows show');assert.ok(lis.every(li=>li.style.transform===''));
  // dsh changes the list while you drag (a message starts to send): the drag stops, nothing moves
  moves=[];out=render();grip(2).p.onPointerDown({button:0,clientY:90,preventDefault(){}});window.listeners.pointermove({clientY:10});
  listObs.f();assert.equal(ghost(),undefined);assert.equal(window.listeners.pointerup,undefined,'listeners are off');assert.deepEqual(moves,[]);
  // a refused drop: the card goes back to its place
  hostAnswer=()=>{throw Error('the queue changed');};out=render();
  grip(2).p.onPointerDown({button:0,clientY:90,preventDefault(){}});window.listeners.pointermove({clientY:10});window.listeners.pointerup();await tick();
  assert.equal(ghost().style.transform,'','refused: the card goes back');assert.deepEqual(notes,['queue.failed']);await wait(200);assert.equal(ghost(),undefined);
  // switched off while dragging: the card and the drag styles go away
  out=render();grip(2).p.onPointerDown({button:0,clientY:90,preventDefault(){}});off();
  assert.equal(ghost(),undefined);assert.equal(document.head.children.length,0);assert.equal(window.listeners.pointermove,undefined); }
console.log('queue-drag checks passed');
