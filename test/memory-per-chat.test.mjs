// Do not use memory in this chat. Host: a chat switched off gets no memory section, its memory tools refuse and leave its
// tool list (dsh's per-agent `tools.restrict({deny})`, while the tools are registered), and the review sends none of its
// lines to a model (its cursor still moves); other chats are not changed; a subagent follows its root chat. The choice is
// saved in memory-chats.json (owner-only) and survives a restart; it is undone by switching it back on. The restrictions are
// lifted before the tools go (Project memory off, unload), and come back with them. Its own Host switch (on by default):
// off ignores the list. Client (real client.js, fake React): the header button and the New chat chip read the chat's
// state, one change at a time from both, not in a subagent chat, and only while Project memory is on.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_PATH, MEMORY_CHAT_PATH, MEMORY_TOOLS, installMemory } from '../index.js';

const root = await mkdtemp(join(tmpdir(), 'cp-memory-chat-'));
try {
  const project = join(root, 'acme-web'); await mkdir(project);
  const home = join(root, 'home');
  // A fake dsh: tools/sections registered through one fiber; agents with their own ctx.tools.restrict; a log per agent.
  const registered = { tools: new Map(), sections: new Map() };
  const log = [];
  const agents = new Map();
  const makeAgent = (id, parentSession) => {
    const restrictions = new Set();
    const agent = { id, session: { header: { cwd: project, ...(parentSession ? { parentSession, origin: 'subagent' } : {}) } }, restrictions,
      ctx: { tools: { restrict: (filter) => {
        for (const n of filter.deny) if (!registered.tools.has(n)) throw new Error(`tools.restrict() names unknown global tool "${n}"`);
        const r = { deny: [...filter.deny] }; restrictions.add(r); log.push(`restrict ${id}`);
        return () => { restrictions.delete(r); log.push(`unrestrict ${id}`); };
      } } } };
    agents.set(id, agent);
    return agent;
  };
  const visibleTools = (agent) => [...registered.tools.keys()].filter((n) => ![...agent.restrictions].some((r) => r.deny.includes(n)));
  let seq = 0;
  const user = (text) => ({ seq: seq++, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
  const events = new Map();
  const llmCalls = [];
  const llm = { prepareCall: async (route, signal, configure) => ({ config: { ...route, ...configure({}, {}) }, async *stream(req) { llmCalls.push(req); yield { type: 'text-delta', text: '{"changes":[]}' }; yield { type: 'finish', reason: { kind: 'stop' } }; } }) };
  const handlers = new Map();
  const routes = new Map(); const effects = [];
  const makeCtx = () => ({
    on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    effect: (fn) => effects.push(fn()),
    logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? llm : name === 'agents' ? { get: (id) => agents.get(id) } : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'demo', model: 'm' }) } : undefined),
    connection: { fetch: { register: (r) => routes.set(r.path, r) } },
    sessionQuery: { observeSession: async (id) => ({ events: events.get(id) ?? [], header: agents.get(id)?.session.header ?? { cwd: project }, inheritedEventCount: 0 }) },
    inject: (deps, setup) => {
      const offs = [];
      setup({ tools: { register: (t) => { registered.tools.set(t.name, t); offs.push(() => registered.tools.delete(t.name)); } },
        systemPrompt: { section: (sec) => { registered.sections.set(sec.name, sec); offs.push(() => registered.sections.delete(sec.name)); } } });
      return { dispose: () => { for (const r of [...agents.values()].flatMap((a) => [...a.restrictions])) for (const n of r.deny) if (!registered.tools.has(n)) throw new Error('restricted tool vanished first'); log.push('dispose'); offs.forEach((f) => f()); } };
    },
  });
  const mem = installMemory(makeCtx(), home);
  await mem.ready;
  const call = async (path, body, query = '') => {
    const r = await routes.get(path).fetch(new Request(`http://h${path}${query}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  assert.deepEqual((await call(MEMORY_CHAT_PATH)).body, { on: true }, 'on by default');
  await call(MEMORY_PATH, { on: true });
  const a = makeAgent('session-a'); const b = makeAgent('session-b'); const kid = makeAgent('session-kid', 'session-a');
  for (const ag of [a, b, kid]) for (const fn of handlers.get('agent/created') ?? []) fn({ agent: ag });
  await mem.store.add({ scope: mem.store.project(project), text: 'The user deploys with make release', actor: 'agent' });
  const section = (agent) => registered.sections.get('composer-plus:memory').text({ agent });
  assert.match(section(a), /make release/, 'on: the section');
  assert.deepEqual(visibleTools(a).sort(), [...MEMORY_TOOLS].sort());
  // Bad bodies.
  for (const bad of [{ sessionId: 'session-a' }, { sessionId: 'session-a', off: 'yes' }, { sessionId: '', off: true }, { sessionId: 'session-a', off: true, x: 1 }]) {
    assert.equal((await call(MEMORY_CHAT_PATH, bad)).status, 400, JSON.stringify(bad));
  }
  // Switch it off for chat A (its section was rendered, so it is frozen now).
  assert.match(section(a), /make release/);
  const offA = await call(MEMORY_CHAT_PATH, { sessionId: 'session-a', off: true });
  assert.deepEqual(offA.body, { on: true, memory: true, sessionId: 'session-a', off: true });
  assert.equal(section(a), '', 'off: no section (the frozen one goes)');
  assert.match(section(b), /make release/, 'another chat is not changed');
  assert.deepEqual(visibleTools(a), [], 'off: the memory tools leave its list');
  assert.deepEqual(visibleTools(b).sort(), [...MEMORY_TOOLS].sort());
  assert.equal(section(kid), '', 'a subagent follows its root chat');
  await assert.rejects(registered.tools.get('memory_remember').execute({ text: 'x' }, { agent: a }), /switched off for this chat/);
  await assert.rejects(registered.tools.get('memory_recall').execute({}, { agent: kid }), /switched off for this chat/, 'the subagent\'s tools refuse too');
  assert.match(await registered.tools.get('memory_recall').execute({}, { agent: b }), /make release/);
  assert.deepEqual((await call(MEMORY_CHAT_PATH, undefined, '?sessionId=session-kid')).body, { on: true, memory: true, sessionId: 'session-kid', off: true, root: true });
  const saved = join(home, 'storages', 'dsh-composer-plus', 'memory-chats.json');
  assert.deepEqual(Object.keys(JSON.parse(await readFile(saved, 'utf8')).off), ['session-a']);
  assert.equal((await stat(saved)).mode & 0o777, 0o600, 'owner-only');
  // The review: no model call for chat A (its cursor moves), one for chat B.
  events.set('session-a', [user('I deploy with docker now')]); events.set('session-b', [user('I use pnpm')]);
  await mem.review('session-a');
  assert.equal(llmCalls.length, 0, 'off: the review sends nothing');
  await mem.review('session-b');
  assert.equal(llmCalls.length, 1);
  assert.match(llmCalls[0].messages[0].content[0].text, /pnpm/); assert.doesNotMatch(llmCalls[0].messages[0].content[0].text, /docker/);
  // Switching A back on later does not send what was said while it was off.
  await call(MEMORY_CHAT_PATH, { sessionId: 'session-a', off: false });
  await mem.review('session-a');
  assert.equal(llmCalls.length, 1, 'the lines of the time it was off are not read later');
  assert.match(section(a), /make release/, 'on again: the section is back'); assert.equal(visibleTools(a).length, 3, 'and the tools');
  // Project memory off: the restriction is lifted before the tools go; on again: it comes back.
  await call(MEMORY_CHAT_PATH, { sessionId: 'session-a', off: true });
  log.length = 0;
  await call(MEMORY_PATH, { on: false });
  assert.deepEqual(log, ['unrestrict session-a', 'dispose'], 'the restriction goes before the tools');
  await call(MEMORY_PATH, { on: true });
  assert.deepEqual(visibleTools(a), [], 'on again: the restriction is back');
  // A chat that starts later with the memory off gets its restriction when it starts.
  await call(MEMORY_CHAT_PATH, { sessionId: 'session-new', off: true });
  const late = makeAgent('session-new');
  for (const fn of handlers.get('agent/created') ?? []) fn({ agent: late });
  assert.deepEqual(visibleTools(late), [], 'a chat that starts later');
  // The feature's own switch off: the list is ignored (the section and the tools come back); the phone never sends it.
  assert.deepEqual((await call(MEMORY_CHAT_PATH, { on: false })).body, { on: false });
  assert.match(section(a), /make release/); assert.equal(visibleTools(a).length, 3);
  assert.equal((await call(MEMORY_CHAT_PATH, { sessionId: 'session-a', off: true })).status, 409, 'off: no per-chat change');
  await call(MEMORY_CHAT_PATH, { on: true });
  assert.deepEqual(visibleTools(a), [], 'on again: the saved choice applies');
  // Unload: restrictions before the tools.
  log.length = 0;
  effects.forEach((f) => f?.());
  assert.deepEqual(log.slice(-1), ['dispose']); assert.ok(log.includes('unrestrict session-a'));
  // A restart: the saved choice is read before the memory switch applies, so the tools of a live chat are restricted at once.
  registered.tools.clear(); registered.sections.clear();
  const restarted = makeAgent('session-a');
  const again = installMemory(makeCtx(), home);
  await again.ready;
  assert.equal(registered.sections.get('composer-plus:memory').text({ agent: restarted }), '', 'the choice survives a restart');
  assert.deepEqual(visibleTools(restarted), [], 'and its tools are restricted as soon as the memory is on');

  // Client (real client.js, fake React).
  {
    const memStore = new Map();
    globalThis.localStorage = { getItem: (k) => (memStore.has(k) ? memStore.get(k) : null), setItem: (k, v) => memStore.set(k, String(v)) };
    let gate; const posts = []; let hostOn = true; const offs = new Set(['session-x']);
    globalThis.fetch = async (url, init) => {
      if (url === '/api/composer-plus.memory') return new Response(JSON.stringify({ on: true }), { status: 200 });
      if (url.startsWith('/api/composer-plus.memory-chat')) {
        const q = new URL(url, 'http://h').searchParams;
        if (init?.method === 'POST') {
          const body = JSON.parse(init.body); posts.push(body);
          if (body.on !== undefined) { hostOn = body.on; return new Response(JSON.stringify({ on: hostOn }), { status: 200 }); }
          if (gate) await gate;
          if (body.off) offs.add(body.sessionId); else offs.delete(body.sessionId);
          return new Response(JSON.stringify({ on: true, memory: true, sessionId: body.sessionId, off: offs.has(body.sessionId) }), { status: 200 });
        }
        if (!q.has('sessionId')) return new Response(JSON.stringify({ on: hostOn }), { status: 200 });
        return new Response(JSON.stringify({ on: hostOn, memory: true, sessionId: q.get('sessionId'), off: offs.has(q.get('sessionId')) }), { status: 200 });
      }
      if (url.startsWith('/api/composer-plus.memory-history')) return new Response(JSON.stringify({ on: true }), { status: 200 });
      return new Response('{}', { status: 404 });
    };
    let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
    eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
    let cur;
    const React = { Fragment: 'F', createElement: (t, p, ...c) => ({ t, p: p ?? {}, c: c.flat() }),
      useState: (v) => { const i = cur.si++; const st = cur.state; if (!(i in st)) st[i] = v; return [st[i], (x) => { st[i] = typeof x === 'function' ? x(st[i]) : x; }]; },
      useRef: (v) => ({ current: v }), useEffect: (f) => { f(); }, useLayoutEffect: () => {}, useSyncExternalStore: (_, get) => get() };
    const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input', Modal: 'Modal' } : {}));
    const live = new Map(); let next = 0;
    plugin.apply({ effect: () => {}, configForms: { get: () => ({}) }, locale: { register: () => () => {}, bind: () => (k) => k },
      sessions: { list: { getSnapshot: () => ({ byId: { 'session-x': {}, 'session-y': {}, 'session-sub': { origin: 'subagent' } } }) } },
      slots: { inject: (n, f) => { const off = f(); return () => off(); }, register: (o, C) => { const key = next++; live.set(key, [o, C]); return () => live.delete(key); } } });
    await new Promise((r) => setTimeout(r, 20));
    const [opts, Settings] = [...live.values()].find(([o]) => o.id === 'composer-plus');
    const section = opts.inject();
    const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);
    const settingsInst = { state: [] };
    const rows = () => { cur = settingsInst; settingsInst.si = 0; return Settings({ useComposerPlusToggles: (f) => f(section.hooks.composerPlusToggles.getSnapshot()), setFeature: section.setFeature, memory: section.memory, memoryEditor: section.memoryEditor, memoryHistorySwitch: section.memoryHistorySwitch, memoryChatSwitch: section.memoryChatSwitch, t }).c; };
    await section.memoryChatSwitch.refresh();
    const row = rows().find((r) => r?.p?.key === 'memoryPerChat');
    assert.ok(row, 'its own Settings row'); assert.equal(row.c[2].p.checked, true, 'on by default'); assert.equal(row.c[0].p.id, 'memoryPerChat');
    const slotOf = (id) => [...live.values()].find(([o]) => o.id === id);
    const [headerOpts, Header] = slotOf('memory-chat'); const [chipOpts, Chip] = slotOf('memory-chat-chip');
    assert.equal(headerOpts.name, 'conversation.session.header.utilities'); assert.equal(chipOpts.name, 'conversation.hero.options');
    const draw = (C, o, sessionId) => { cur = { state: [], si: 0 }; return C({ sessionId, ...o.inject(sessionId), t }); };
    draw(Header, headerOpts, 'session-x'); await new Promise((r) => setTimeout(r, 10));
    let header = draw(Header, headerOpts, 'session-x');
    const button = (tree) => tree?.c?.find((n) => n?.t === 'button');
    assert.equal(button(header).p['data-composer-plus-memory-chat'], 'off', 'reads the chat\'s saved choice'); assert.equal(button(header).p['aria-pressed'], true);
    // A subagent chat: the Host would answer for it too (it follows its root), but the button does not show.
    offs.add('session-sub'); draw(Header, headerOpts, 'session-sub'); await new Promise((r) => setTimeout(r, 10));
    assert.equal(draw(Header, headerOpts, 'session-sub'), null, 'not in a subagent chat');
    // One change at a time, from the header and from the chip.
    let release; gate = new Promise((r) => { release = r; });
    button(header).p.onClick();
    await new Promise((r) => setTimeout(r, 5));
    header = draw(Header, headerOpts, 'session-x');
    assert.equal(button(header).p.disabled, true, 'busy while it saves');
    const chip = draw(Chip, chipOpts, 'session-x');
    assert.equal(button(chip).p['data-composer-plus-memory-chat-chip'], 'off');
    button(chip).p.onClick();
    release(); gate = undefined; await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts.filter((p) => p.sessionId === 'session-x').length, 1, 'one change while one runs');
    assert.deepEqual(posts[0], { sessionId: 'session-x', off: false });
    assert.equal(button(draw(Header, headerOpts, 'session-x')).p['data-composer-plus-memory-chat'], 'on');
    // Another chat has its own state.
    draw(Header, headerOpts, 'session-y'); await new Promise((r) => setTimeout(r, 10));
    assert.equal(button(draw(Header, headerOpts, 'session-y')).p['data-composer-plus-memory-chat'], 'on');
    // Off (a Host switch): the slots go.
    await section.setFeature('memoryPerChat', false);
    assert.deepEqual(posts.at(-1), { on: false }, 'the switch goes to the Host');
    assert.equal(slotOf('memory-chat'), undefined, 'off: no header button'); assert.equal(slotOf('memory-chat-chip'), undefined, 'off: no chip');
  }
  console.log('memory per chat checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
