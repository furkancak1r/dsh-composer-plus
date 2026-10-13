// Runs the real client.js apply(): every feature is on by default, a Settings switch removes/reinstalls only that
// feature's slots and services live, the choice survives a reload, and unloading the plugin removes everything.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../client.js',import.meta.url),'utf8');
const mem=new Map();globalThis.localStorage={getItem:k=>mem.has(k)?mem.get(k):null,setItem:(k,v)=>mem.set(k,String(v))};
let mod;globalThis.window={__ModuleLoader__:{load:m=>{mod=m;}}};eval(src);
const React={createElement:(t,p,...c)=>({t,p,c})};
const plugin=mod.factory(n=>n==='react'?React:n==='@deepseek-ai/dsh-client-ui-primitives'?{Switch:'Switch'}:{});
function boot(){
  const live=new Map();let next=0;const scopes=new Set();const effects=[];
  const slots={inject:(name,f)=>{const off=f();return()=>off();},register:(o)=>{const key=`${o.name}#${o.id??o.key}#${next++}`;live.set(key,o);return()=>live.delete(key);}};
  const ctx={slots,effect:(f)=>{effects.push(f());},locale:{register:()=>()=>{},bind:()=>(k)=>k},
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
const all=['chat-tool-grants','composer-continue','composer-history','composer-plan-toggle','composer-plus','copy-deeplink','project-status','queue-reorder','session-context-menu'];
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
const switches=tree.c.slice(1).map(r=>r.c[1]);assert.equal(switches.length,10);
const plan=switches.find(s=>s.p.label==='feature.planToggle');assert.equal(plan.p.checked,false);assert.equal(switches.filter(s=>s.p.checked).length,9);
plan.p.onChange(true);assert.deepEqual(calls,[['planToggle',true]]);
console.log('toggle checks passed');
