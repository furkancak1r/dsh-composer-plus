// Runs the real client.js "Copy deeplink" item and row right-click with fake React/DOM. The link format is
// checked against dsh's own decoder when dsh is installed globally; otherwise against a local decode.
import assert from 'node:assert/strict';import {readFileSync,existsSync} from 'node:fs';
const src=readFileSync(new URL('../client.js',import.meta.url),'utf8');
let mod;globalThis.window={__ModuleLoader__:{load:m=>{mod=m;}}};eval(src);
const copied=[];const primitives={MenuItemButton:'MenuItemButton',IconLinkOutlineRegular:'Icon',writeClipboard:async t=>{copied.push(t);return true;}};
let effects=[];let anchorEl;
const React={useRef:()=>({current:anchorEl}),useEffect:f=>effects.push(f),createElement:(t,p,...c)=>({t,p,c})};
const plugin=mod.factory(n=>n==='react'?React:n==='@deepseek-ai/dsh-client-ui-primitives'?primitives:{});
const dicts={};const regs=[];plugin.apply({effect:f=>f(),locale:{register:(ns,d)=>{dicts[ns]=d;return()=>{};}},sessions:{scope:()=>undefined},slots:{inject:(n,f)=>f(),register:(o,C)=>{regs.push([o,C]);return()=>{};}}});
const [opt,Item]=regs.find(([o])=>o.id==='copy-deeplink');assert.equal(opt.name,'sidebar.workspaces.session.menu.item');
assert.ok(opt.order>450,'the item comes after dsh\'s own "Copy Session ID" (order 450)');
assert.deepEqual(Object.keys(dicts[opt.locale]).sort(),['en','zh'],'en + zh here; other languages come from locales/');for(const d of Object.values(dicts[opt.locale]))assert.ok(d.copyDeeplink,'label in every language');
const t=k=>dicts[opt.locale].en[k];
const ids=['session-fd7c92c7-787f-40dc-b837-95b53cc19c98','ğüş "quoted" ✓','a'];
const decode=uri=>JSON.parse(Buffer.from(uri.slice('dsh-session:'.length),'base64url').toString('utf8'));
const ref='/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-reference/lib/index.js';
const dsh=existsSync(ref)?await import(ref):null;
for(const id of ids){let open=true;copied.length=0;
 const el=Item({sessionId:id,t,useMenuOpenState:()=>[open,v=>{open=v;}]});
 assert.equal(el.t,'MenuItemButton');assert.equal(el.c[0],'Copy session link');el.p.onSelect();
 assert.equal(open,false,'menu closes');const [link]=copied;assert.match(link,/^dsh-session:[A-Za-z0-9_-]+$/);
 assert.equal(decode(link),id);if(dsh){assert.equal(link,dsh.encodeSessionReferenceUri(id));assert.equal(dsh.decodeSessionReferenceUri(link),id);}}
// Right-click opens the row's own "…" menu; plugin-slot buttons (archive/pin) are skipped.
const [ropt,Row]=regs.find(([o])=>o.id==='session-context-menu');assert.equal(ropt.name,'sidebar.workspaces.session.row.action');
const make=(withMenu)=>{let clicks=0;const slot={};const menuBtn={closest:()=>null,click:()=>clicks++};const slotBtn={closest:()=>slot,click:()=>{throw new Error('slot button clicked');}};
 let handler;const row={contains:n=>n===slot,querySelectorAll:()=>withMenu?[menuBtn,slotBtn]:[slotBtn],addEventListener:(t,f)=>{assert.equal(t,'contextmenu');handler=f;},removeEventListener:(t,f)=>{if(f===handler)handler=null;}};
 anchorEl={closest:q=>{assert.equal(q,'[data-row-key^="session:"]');return row;}};effects=[];Row();const off=effects[0]();
 const e={prevented:0,preventDefault(){this.prevented++;}};handler(e);return {clicks:()=>clicks,e,off,live:()=>handler};};
const a=make(true);assert.equal(a.clicks(),1,'opens "…" menu');assert.equal(a.e.prevented,1,'suppresses native menu');a.off();assert.equal(a.live(),null,'cleanup');
const b=make(false);assert.equal(b.clicks(),0);assert.equal(b.e.prevented,0,'no "…" button: native menu stays');
anchorEl={closest:()=>null};effects=[];Row();assert.equal(effects[0](),undefined,'outside a row: no listener');
console.log('deeplink checks passed'+(dsh?' (verified with dsh decoder)':''));
