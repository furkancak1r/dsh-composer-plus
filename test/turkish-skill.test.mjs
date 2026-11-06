// Turkish skill pack (Host half and client switch): the pack is installed only while the reported UI language is
// Turkish and the switch is on (on by default); the files come from a fake GitHub (commit, file list, raw files), only
// plain Markdown names under the skill folder are taken, each must hash to its id in the list, a bad file leaves no
// copy; a daily check downloads a newer commit and removes the old copy; another language unregisters the skill;
// switching off unregisters it and deletes the copy; the client reports dsh's UI language and sends it with a switch click.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TURKISH_SKILL, TURKISH_SKILL_PATH, downloadTurkishSkill, gitBlobSha, installTurkishSkill, isTurkishLanguage, parseSkillFile } from '../index.js';

const C1 = 'a'.repeat(40); const C2 = 'b'.repeat(40);
const SKILL = (name = TURKISH_SKILL.name) => `---\nname: ${name}\ndescription: Türkçe metinleri doğal yazar.\nlicense: MIT\nmetadata:\n  author: x\n---\n\n# Kurallar\n\nKısa yaz.\n`;
const dir = TURKISH_SKILL.dir;
/** A fake GitHub: `repo[commit] = { path: text }` (paths from the repository root). */
const fakeGithub = (repo, head) => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url); assert.equal(opts.redirect, 'error', 'no redirects');
    let m = url.match(/^https:\/\/api\.github\.com\/repos\/yucezerey\/turkish-anti-ai-skill\/commits\/HEAD$/);
    if (m) return head.value === undefined ? new Response('nope', { status: 503 }) : new Response(head.value);
    m = url.match(/^https:\/\/api\.github\.com\/repos\/yucezerey\/turkish-anti-ai-skill\/git\/trees\/([0-9a-f]{40})\?recursive=1$/);
    if (m) {
      const files = repo[m[1]]; if (files === undefined) return new Response('{}', { status: 404 });
      const tree = Object.entries(files).map(([path, f]) => (typeof f === 'string' ? { path, mode: '100644', type: 'blob', sha: gitBlobSha(Buffer.from(f)), size: Buffer.byteLength(f) } : { path, ...f }));
      return Response.json({ sha: m[1], truncated: false, tree });
    }
    m = url.match(/^https:\/\/raw\.githubusercontent\.com\/yucezerey\/turkish-anti-ai-skill\/([0-9a-f]{40})\/(.+)$/);
    if (m) { const f = repo[m[1]]?.[m[2]]; return typeof f === 'string' ? new Response(f) : f?.raw !== undefined ? new Response(f.raw) : new Response('missing', { status: 404 }); }
    throw Error(`unexpected URL ${url}`);
  };
  return { fetchImpl, calls };
};

// Pure helpers.
assert.equal(isTurkishLanguage('tr'), true); assert.equal(isTurkishLanguage('tr-TR'), true);
for (const id of ['en', 'trk', 'zh', '', undefined, 'TR-x']) assert.equal(isTurkishLanguage(id), id === 'TR-x', String(id));
assert.equal(gitBlobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a', 'git hash-object of "hello\\n"');
assert.deepEqual(parseSkillFile(SKILL()), { name: TURKISH_SKILL.name, description: 'Türkçe metinleri doğal yazar.', body: '# Kurallar\n\nKısa yaz.' });
assert.equal(parseSkillFile('---\nname: "a-b"\ndescription: >\n  one\n  two\n---\nbody').description, 'one two', 'folded description');
for (const bad of ['no frontmatter', '---\nname: Bad Name\ndescription: x\n---\n', '---\nname: ok\n---\n', `---\nname: ok\ndescription: ${'x'.repeat(1100)}\n---\n`]) assert.throws(() => parseSkillFile(bad), JSON.stringify(bad.slice(0, 30)));

const root = await mkdtemp(join(tmpdir(), 'cp-turkish-skill-'));
try {
  // The download: only plain Markdown under the skill folder; scripts, dot files, `..`, symlinks and other modes stay out.
  {
    const good = { [`${dir}/SKILL.md`]: SKILL(), [`${dir}/references/a.md`]: 'A\n', 'README.md': 'not in the folder',
      [`${dir}/run.sh`]: 'rm -rf ~', [`${dir}/.hidden.md`]: 'x', [`${dir}/references/../../evil.md`]: 'x',
      [`${dir}/link.md`]: { mode: '120000', type: 'blob', sha: gitBlobSha(Buffer.from('/etc/passwd')), size: 11, raw: '/etc/passwd' },
      [`${dir}/exec.md`]: { mode: '100755', type: 'blob', sha: gitBlobSha(Buffer.from('x')), size: 1, raw: 'x' } };
    const gh = fakeGithub({ [C1]: good }, { value: C1 });
    const out = join(root, 'dl', C1);
    const skill = await downloadTurkishSkill({ fetchImpl: gh.fetchImpl, commit: C1, dir: out });
    assert.equal(skill.name, TURKISH_SKILL.name);
    assert.deepEqual((await readdir(out, { recursive: true })).sort(), ['SKILL.md', 'references', 'references/a.md']);
    assert.equal((await stat(join(out, 'SKILL.md'))).mode & 0o777, 0o600, 'owner-only files');
    assert.ok(!gh.calls.some((u) => /run\.sh|hidden|evil|link\.md|exec\.md|README/.test(u)), 'never asks for a file it does not keep');
    // A changed file (hash mismatch), a wrong skill name, no SKILL.md, a too large file: no folder is left.
    const cases = {
      hash: { [`${dir}/SKILL.md`]: { mode: '100644', type: 'blob', sha: gitBlobSha(Buffer.from(SKILL())), size: 10, raw: SKILL().replace('Kısa', 'Uzun') } },
      name: { [`${dir}/SKILL.md`]: SKILL('other-skill') },
      none: { [`${dir}/references/a.md`]: 'A\n' },
      large: { [`${dir}/SKILL.md`]: SKILL(), [`${dir}/references/big.md`]: { mode: '100644', type: 'blob', sha: C2, size: 300 * 1024, raw: 'x' } },
      lying: { [`${dir}/SKILL.md`]: { mode: '100644', type: 'blob', sha: C2, size: 10, raw: 'y'.repeat(300 * 1024) } },
    };
    for (const [why, files] of Object.entries(cases)) {
      const g = fakeGithub({ [C2]: files }, { value: C2 });
      const target = join(root, `bad-${why}`, C2);
      if (why === 'large') { await downloadTurkishSkill({ fetchImpl: g.fetchImpl, commit: C2, dir: target }); assert.ok(!existsSync(join(target, 'references/big.md')), 'a file over the limit is not listed'); continue; }
      await assert.rejects(downloadTurkishSkill({ fetchImpl: g.fetchImpl, commit: C2, dir: target }), undefined, why);
      assert.deepEqual(await readdir(join(root, `bad-${why}`)).catch(() => []), [], `${why}: nothing is left`);
    }
    await assert.rejects(downloadTurkishSkill({ fetchImpl: gh.fetchImpl, commit: '../x', dir: join(root, 'x') }), /bad commit/);
  }

  // The Host: on by default, installs only for Turkish, daily update, off removes everything.
  {
    const repo = { [C1]: { [`${dir}/SKILL.md`]: SKILL(), [`${dir}/references/a.md`]: 'A\n' }, [C2]: { [`${dir}/SKILL.md`]: SKILL().replace('Kısa', 'Net'), [`${dir}/references/b.md`]: 'B\n' } };
    const head = { value: C1 };
    const gh = fakeGithub(repo, head);
    let clock = 1_000_000;
    const routes = new Map(); const skills = new Map(); const effects = []; let injects = 0;
    const ctx = {
      effect: (fn) => effects.push(fn()),
      connection: { fetch: { register: (r) => routes.set(r.path, r) } },
      inject: (deps, setup) => {
        assert.deepEqual(deps, ['skills']); injects++;
        const offs = [];
        setup({ skills: { register: (s) => { assert.ok(!skills.has(s.name), 'one registration at a time'); skills.set(s.name, s); offs.push(() => skills.delete(s.name)); } } });
        return { dispose: () => offs.forEach((f) => f()) };
      },
    };
    const home = join(root, 'home');
    const cache = join(home, 'cache', 'composer-plus', 'turkish-skill');
    const host = installTurkishSkill(ctx, home, { fetchImpl: gh.fetchImpl, now: () => clock });
    await host.ready; await host.refresh();
    const req = async (body) => { const r = await routes.get(TURKISH_SKILL_PATH).fetch(new Request(`http://h${TURKISH_SKILL_PATH}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
    assert.deepEqual((await req()).body, { on: true, turkish: false, installed: false }, 'on by default, no language yet');
    assert.equal(gh.calls.length, 0, 'no network call before a Turkish UI is reported');
    for (const bad of [{ on: 'yes' }, { lang: 'not a language!' }, { lang: '' }, { on: true, x: 1 }, {}, [], { lang: 'tr', on: 1 }]) assert.equal((await req(bad)).status, 400, JSON.stringify(bad));
    // English: nothing is downloaded.
    await req({ lang: 'en' }); await host.refresh();
    assert.equal(gh.calls.length, 0); assert.equal(skills.size, 0);
    // Turkish: downloaded and registered as a runtime skill with its folder as the resource base.
    await req({ lang: 'tr' }); await host.refresh();
    let s = skills.get(TURKISH_SKILL.name);
    assert.ok(s, 'registered'); assert.equal(s.description, 'Türkçe metinleri doğal yazar.'); assert.equal(s.content, '# Kurallar\n\nKısa yaz.');
    assert.deepEqual(s.resourceBase, { kind: 'directory', path: join(cache, C1) }); assert.equal(s.source, 'runtime');
    assert.equal(readFileSync(join(cache, C1, 'references', 'a.md'), 'utf8'), 'A\n');
    assert.deepEqual((await req()).body, { on: true, turkish: true, installed: true, commit: C1, checkedAt: clock });
    assert.deepEqual(JSON.parse(await readFile(join(home, 'storages', 'dsh-composer-plus', 'turkish-skill.json'), 'utf8')), { on: true, lang: 'tr' });
    // Within a day: no new check. After a day: a newer commit replaces the copy; the old one goes.
    const calls = gh.calls.length; await host.refresh(); assert.equal(gh.calls.length, calls, 'checks at most once a day');
    head.value = C2; clock += 24 * 60 * 60 * 1000; await host.refresh();
    assert.equal(skills.get(TURKISH_SKILL.name).content, '# Kurallar\n\nNet yaz.', 'the newer version is in use');
    assert.deepEqual((await readdir(cache)).sort(), [C2, 'meta.json'], 'the old copy is removed');
    // A failed check keeps the copy in use and shows why.
    head.value = undefined; clock += 24 * 60 * 60 * 1000; await host.refresh();
    assert.ok(skills.has(TURKISH_SKILL.name)); assert.match((await req()).body.failed, /GitHub answered 503/);
    const failedCalls = gh.calls.length; clock += 60 * 60 * 1000; await host.refresh();
    assert.equal(gh.calls.length, failedCalls, 'a failed check also waits a day (GitHub allows 60 calls an hour)');
    // A restart registers the saved copy without a download (the check is not due).
    head.value = C2; await host.refresh(); const before = gh.calls.length;
    effects.splice(0).forEach((f) => typeof f === 'function' && f()); assert.equal(skills.size, 0, 'unload unregisters');
    await host.refresh(); assert.equal(skills.size, 0, 'an unloaded Host registers nothing');
    const again = installTurkishSkill({ ...ctx, connection: { fetch: { register: () => {} } } }, home, { fetchImpl: gh.fetchImpl, now: () => clock });
    await again.ready; await again.refresh();
    assert.ok(skills.has(TURKISH_SKILL.name), 'the saved copy comes back after a restart'); assert.equal(gh.calls.length, before, 'no download at restart');
    effects.splice(0).forEach((f) => typeof f === 'function' && f()); assert.equal(skills.size, 0);
    // Another language unregisters and keeps the copy; off removes the copy.
    const host2 = installTurkishSkill(ctx, home, { fetchImpl: gh.fetchImpl, now: () => clock });
    await host2.ready; await host2.refresh(); assert.ok(skills.has(TURKISH_SKILL.name));
    await req({ lang: 'de' }); await host2.refresh();
    assert.equal(skills.size, 0, 'not Turkish: unregistered'); assert.ok(existsSync(join(cache, C2)), 'the copy stays for a switch back');
    await req({ lang: 'tr-TR' }); await host2.refresh(); assert.ok(skills.has(TURKISH_SKILL.name), 'tr-TR counts as Turkish');
    assert.deepEqual((await req({ on: false })).body, { on: false, turkish: true, installed: false });
    assert.equal(skills.size, 0); assert.ok(!existsSync(cache), 'off deletes the downloaded copy');
    await host2.refresh(); assert.equal(skills.size, 0, 'off stays off');
    // Two clicks in a row end on the newest one; on + lang in one request.
    await Promise.all([req({ on: true, lang: 'tr' }), req({ on: false }), req({ on: true })]);
    await host2.refresh(); assert.equal((await req()).body.on, true); assert.ok(skills.has(TURKISH_SKILL.name));
    effects.splice(0).forEach((f) => typeof f === 'function' && f()); assert.equal(skills.size, 0);
    assert.ok(injects >= 3);
  }

  // No copy and GitHub down: the hourly timer does not ask again within a day; a click on the switch asks at once.
  {
    const head = { value: undefined }; const gh = fakeGithub({ [C1]: { [`${dir}/SKILL.md`]: SKILL() } }, head);
    const routes = new Map(); const skills = new Map(); let clock = 5_000_000;
    const ctx = { connection: { fetch: { register: (r) => routes.set(r.path, r) } },
      inject: (deps, setup) => { const offs = []; setup({ skills: { register: (sk) => { skills.set(sk.name, sk); offs.push(() => skills.delete(sk.name)); } } }); return { dispose: () => offs.forEach((f) => f()) }; } };
    const host = installTurkishSkill(ctx, join(root, 'down'), { fetchImpl: gh.fetchImpl, now: () => clock });
    await host.ready;
    const post = async (body) => routes.get(TURKISH_SKILL_PATH).fetch(new Request(`http://h${TURKISH_SKILL_PATH}`, { method: 'POST', body: JSON.stringify(body) }));
    await post({ lang: 'tr' }); await host.refresh();
    assert.equal(gh.calls.length, 1, 'one failed check'); clock += 60 * 60 * 1000; await host.refresh();
    assert.equal(gh.calls.length, 1, 'the timer waits a day after a failure');
    await post({ lang: 'tr' }); await host.refresh(); assert.equal(gh.calls.length, 1, 'the same language again (a page load) does not ask');
    head.value = C1; await post({ lang: 'de' }); await post({ lang: 'tr' }); await host.refresh();
    assert.ok(skills.has(TURKISH_SKILL.name), 'a switch back to Turkish asks at once and installs');
  }

  // Without a skill registry (an old dsh or a test without `inject`): no download at all.
  {
    const gh = fakeGithub({}, { value: C1 }); const routes = new Map();
    const host = installTurkishSkill({ connection: { fetch: { register: (r) => routes.set(r.path, r) } } }, join(root, 'bare'), { fetchImpl: gh.fetchImpl });
    await host.ready;
    await routes.get(TURKISH_SKILL_PATH).fetch(new Request(`http://h${TURKISH_SKILL_PATH}`, { method: 'POST', body: '{"lang":"tr"}' }));
    await host.refresh(); assert.equal(gh.calls.length, 0);
  }
} finally { await rm(root, { recursive: true, force: true }); }

// Client: the switch is on by default, a click sends the UI language with it, the feature reports the language and
// stops when it is switched off.
{
  let mod; globalThis.window = { __ModuleLoader__: { load: (m) => { mod = m; } } };
  const posts = [];
  const server = { on: true };
  globalThis.fetch = async (url, init) => {
    if (init?.body) { const body = JSON.parse(init.body); posts.push([url, body]); if (url === TURKISH_SKILL_PATH && 'on' in body) server.on = body.on; }
    return Response.json(url === TURKISH_SKILL_PATH ? { ...server } : { on: true });
  };
  eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'));
  const React = { createElement: (t, p, ...c) => ({ t, p, c }), Fragment: 'F', useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, useSyncExternalStore: (_, get) => get() };
  const plugin = mod.factory((n) => (n === 'react' ? React : n === '@deepseek-ai/dsh-client-ui-primitives' ? { Switch: 'Switch', Input: 'Input' } : {}));
  let active = 'en'; const subs = new Set(); let section;
  const locale = { register: () => () => {}, bind: () => (k) => k, getSnapshot: () => ({ active, locales: [] }), subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } };
  const effects = [];
  plugin.apply({ effect: (fn) => effects.push(fn()), configForms: { get: () => ({}) }, locale, sessions: {},
    slots: { inject: (n, f) => f(), register: (o) => { if (o.id === 'composer-plus') section = o; return () => {}; } } });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  await flush();
  const mine = () => posts.filter(([u]) => u === TURKISH_SKILL_PATH).map(([, b]) => b);
  assert.deepEqual(mine(), [{ lang: 'en' }], 'reports the UI language at start');
  active = 'tr'; for (const fn of [...subs]) fn(); await flush();
  assert.deepEqual(mine().at(-1), { lang: 'tr' }, 'reports a language switch');
  const before = mine().length; for (const fn of [...subs]) fn(); await flush(); assert.equal(mine().length, before, 'the same language is not sent twice');
  const inj = section.inject();
  assert.equal(inj.hooks.composerPlusToggles.getSnapshot().turkishSkill, true, 'on by default (the Host answered on)');
  inj.setFeature('turkishSkill', false); await flush();
  assert.deepEqual(mine().at(-1), { on: false, lang: 'tr' }, 'a click sends the switch with the UI language');
  assert.equal(inj.hooks.composerPlusToggles.getSnapshot().turkishSkill, false);
  assert.equal(subs.size, [...subs].length); const langPosts = mine().length; active = 'de'; for (const fn of [...subs]) fn(); await flush();
  assert.equal(mine().length, langPosts, 'switched off: the language is not reported (the listener is gone)'); active = 'tr';
  inj.setFeature('turkishSkill', true); await flush(); assert.deepEqual(mine().at(-1), { on: true, lang: 'tr' });
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.ok(!/OFF_BY_DEFAULT = \[[^\]]*'turkishSkill'/.test(src), 'not in OFF_BY_DEFAULT');
}
console.log('turkish skill checks passed');
