// Runs the real client.js apply(): every feature is on by default, a Settings switch removes/reinstalls only that
// feature's slots and services live, the choice survives a reload, and unloading the plugin removes everything.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../client.js',import.meta.url),'utf8');
const mem=new Map();globalThis.localStorage={getItem:k=>mem.has(k)?mem.get(k):null,setItem:(k,v)=>mem.set(k,String(v))};
let mod;globalThis.window={__ModuleLoader__:{load:m=>{mod=m;}}};eval(src);
let q='';const React={createElement:(t,p,...c)=>({t,p,c}),useState:v=>[q,x=>{q=x;}]};
const plugin=mod.factory(n=>n==='react'?React:n==='@deepseek-ai/dsh-client-ui-primitives'?{Switch:'Switch'}:{});
function boot(){
  const live=new Map();let next=0;const scopes=new Set();const effects=[];
  const slots={inject:(name,f)=>{const off=f();return()=>off();},register:(o)=>{const key=`${o.name}#${o.id??o.key}#${next++}`;live.set(key,o);return()=>live.delete(key);}};
  const ctx={slots,configForms:{get:()=>({})},effect:(f)=>{effects.push(f());},locale:{register:()=>()=>{},bind:()=>(k)=>k},
    inject:(deps,setup)=>{const id=deps.join(',');scopes.add(id);
      setup({effect:()=>{},uiSession:{sessionStatus:{getSnapshot:()=>new Map(),subscribe:()=>()=>{}}},sessions:{list:{getSnapshot:()=>({}),subscribe:()=>()=>{}}},
        uiWorkspace:{},workspaces:{list:{getSnapshot:()=>undefined,subscribe:()=>()=>{}}},sidebarRight:{},sidebarRightTabs:{register:()=>()=>{}}});
      return{dispose:()=>scopes.delete(id)};}}; // real Cordis returns a fiber
  plugin.apply(ctx);
  const ids=()=>[...live.values()].map(o=>o.id??o.key).sort();
  const settings=[...live.values()].find(o=>o.id==='composer-plus');
  return {ids,scopes,settings,unload:()=>effects.forEach(f=>typeof f==='function'&&f())};
}
let app=boot();
const all=['chat-tool-grants','collapse-projects','composer-continue','composer-history','composer-keep-focus','composer-plan-toggle','composer-plus','copy-deeplink','project-path-menu','project-status','queue-reorder','recent-projects','session-context-menu','status-order'];
assert.deepEqual(app.ids(),all,'every feature on by default, plus the settings section');
assert.ok(app.scopes.has('workspaces,uiSession,sessions')&&app.scopes.has('uiSession,uiWorkspace,sessions')&&app.scopes.has('sidebarRight,sidebarRightTabs'));
assert.equal(app.settings.name,'settings.section');
const {setFeature,hooks}=app.settings.inject();
setFeature('copyDeeplink',false);
assert.deepEqual(app.ids(),all.filter(i=>i!=='copy-deeplink'&&i!=='session-context-menu'),'copy deeplink removes both of its slots only');
setFeature('activeProjectsFirst',false);setFeature('notifications',false);
assert.ok(!app.scopes.has('workspaces,uiSession,sessions')&&!app.scopes.has('uiSession,uiWorkspace,sessions')&&app.scopes.has('sidebarRight,sidebarRightTabs'),'service features stop');
assert.deepEqual(hooks.composerPlusToggles.getSnapshot(),{copyDeeplink:false,activeProjectsFirst:false,notifications:false});
setFeature('copyDeeplink',true);assert.ok(app.ids().includes('copy-deeplink')&&app.ids().includes('session-context-menu'),'switching back on reinstalls');
assert.deepEqual(JSON.parse(mem.get('dsh-composer-plus.features')),{activeProjectsFirst:false,notifications:false},'only off switches are stored');
app.unload();assert.deepEqual(app.ids(),['composer-plus'],'unload removes every feature slot (dsh disposes the settings section with the plugin)');assert.equal(app.scopes.size,0);
app=boot();assert.ok(app.ids().includes('copy-deeplink'));assert.ok(!app.scopes.has('workspaces,uiSession,sessions'),'off switch survives a reload');
// Settings UI: one Switch per feature, reflecting state and writing back.
let renders=[];const row=app.settings;const C=(() => { let comp; const slots={inject:(n,f)=>f(),register:(o,Comp)=>{if(o.id==='composer-plus')comp=Comp;return()=>{};}};
  plugin.apply({slots,effect:()=>{},locale:{register:()=>()=>{},bind:()=>k=>k}});return comp; })();
const calls=[];const tree=C({useComposerPlusToggles:f=>f({planToggle:false}),setFeature:(id,on)=>calls.push([id,on]),t:k=>k});
assert.equal(tree.c[1].p['data-composer-plus-search'],'');assert.equal(tree.c[3],null,'no update row without an updater');assert.equal(tree.c[4],null,'no empty notice');const switches=tree.c.slice(5).map(r=>r.c[2]);assert.equal(tree.c.slice(5).filter(r=>r.c[0].p.id!==undefined).length,19,'every feature row has a screenshot (the auto-update switch shows the update row\'s)');assert.equal(switches.length,19);
const plan=switches.find(s=>s.p.label==='feature.planToggle');assert.equal(plan.p.checked,false);assert.equal(switches.filter(s=>s.p.checked).length,16,'plan mode is off here; Mobile connect and Resume after restart are off by default');
assert.equal(switches.find(s=>s.p.label==='feature.mobileConnect').p.checked,false);assert.equal(switches.find(s=>s.p.label==='feature.resumeAfterRestart').p.checked,false);
plan.p.onChange(true);assert.deepEqual(calls,[['planToggle',true]]);
// Settings search: filters by title, description or id; accent/case/Turkish-ı insensitive; Esc clears; empty notice.
{ q='';let C2;const sl={inject:(n,f)=>f(),register:(o,Comp)=>{if(o.id==='composer-plus')C2=Comp;return()=>{};}};
  plugin.apply({slots:sl,effect:()=>{},locale:{register:()=>()=>{},bind:()=>k=>k}});
  const tr={'feature.notifications':'Arka plan bildirimleri','feature.notifications.description':'Dock rozeti','feature.changesPanel':'Değişiklikler paneli','language.title':'Uygulama dili'};
  const tt=k=>tr[k]??k;
  const render=()=>{return C2({useComposerPlusToggles:f=>f({}),setFeature:()=>{},updater:{subscribe:()=>()=>{},getSnapshot:()=>({status:'current'}),check(){}},t:tt});};
  const ids=(tree)=>tree.c.slice(5).map(r=>r.p.key);
  let tree=render();assert.equal(ids(tree).length,19,'empty query shows all');assert.ok(tree.c[2]&&tree.c[3],'language + update rows');
  const input=tree.c[1].c[0];assert.equal(input.p.type,'search');
  input.p.onChange({target:{value:'BİLDİRİM'}});tree=render();assert.deepEqual(ids(tree),['notifications'],'case + dotted İ');
  input.p.onChange({target:{value:'degisiklik'}});tree=render();assert.deepEqual(ids(tree),['changesPanel'],'accent-insensitive ğ/ş');
  input.p.onChange({target:{value:'dock'}});tree=render();assert.deepEqual(ids(tree),['notifications'],'description match');
  input.p.onChange({target:{value:'dil'}});tree=render();assert.ok(tree.c[2]!==null&&ids(tree).length===0,'language row found');
  input.p.onChange({target:{value:'zzzz'}});tree=render();assert.equal(tree.c[4].p.role,'status');assert.equal(tree.c[2],null);assert.equal(tree.c[3],null);
  let stopped=0;tree.c[1].c[0].p.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){stopped++;}});assert.equal(q,'');assert.equal(stopped,1,'Esc clears without closing Settings');
  tree=render();tree.c[1].c[0].p.onKeyDown({key:'Escape',preventDefault(){throw Error('must not trap Esc when empty');},stopPropagation(){}});
}
// Changes tab chip title: its own seat, so it follows a language switch instead of dsh's title saved when the tab opened.
{ const regs=[];const ctx={slots:{inject:(n,f)=>f(),register:(o,Comp)=>{regs.push([o,Comp]);return()=>{};}},configForms:{get:()=>({})},effect:()=>{},locale:{register:()=>()=>{},bind:()=>k=>k},
    inject:(deps,setup)=>{if(deps.includes('sidebarRightTabs'))setup({effect:f=>f(),sidebarRight:{},sidebarRightTabs:{register:()=>()=>{}}});return{dispose(){}};}};
  plugin.apply(ctx);const title=regs.find(([o])=>o.name==='sidebar.right.pane.tab.title');
  assert.ok(title,'title seat registered');assert.equal(title[0].key,'dsh-composer-plus/changes');assert.equal(title[0].locale,'dsh-composer-plus');
  assert.equal(title[1]({t:k=>({'changes.title':'Değişiklikler'})[k]}),'Değişiklikler'); }
console.log('toggle checks passed');
