// Blocked commands (Host half): a tools/pre-execute gate, after the other gates, denies the agent's `bash` / `pwsh` call
// when its command matches a "block" rule, and asks the user first (dsh's approval card) for an "ask first" rule. The
// scanner finds the simple commands of a shell text (separators, quotes, $(…), backticks, bash -c, eval, here-documents);
// a rule's first word is any word of a simple command, its other words follow in order. A denied or cancelled call stays
// so; the ask never looks like an Auto review ask (Allow for this chat must not answer it). The Host keeps the switch and
// the list (owner-only file); bad lists are refused. Linear time on long commands.
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOCKED_PATH, BLOCK_MAX, BLOCK_RULE_MAX, blockedHit, installBlockedCommands, parseRules, shellCommands, wildMatch } from '../index.js';
import { isGrantedAsk } from '../tether/gateway/server.mjs';

// parseRules: spaces made single, first of two same rules (any case) kept; a save with one bad rule is refused.
assert.deepEqual(parseRules([{ rule: '  npm   publish ', mode: 'block' }, { rule: 'NPM publish', mode: 'ask' }, { rule: 'git push --force', mode: 'ask' }]),
  [{ rule: 'npm publish', mode: 'block' }, { rule: 'git push --force', mode: 'ask' }]);
assert.deepEqual(parseRules([]), []);
for (const bad of [undefined, null, 'npm', {}, [{ rule: 'x' }], [{ rule: 'x', mode: 'deny' }], [{ rule: '', mode: 'block' }], [{ rule: '   ', mode: 'block' }],
  [{ rule: 'a\nb', mode: 'block' }], [{ rule: 'a\0', mode: 'block' }], [{ rule: 'x'.repeat(BLOCK_RULE_MAX + 1), mode: 'block' }], [{ rule: 'x', mode: 'block', extra: 1 }],
  Array.from({ length: BLOCK_MAX + 1 }, (_, i) => ({ rule: `c${i}`, mode: 'block' }))]) assert.equal(parseRules(bad), undefined, JSON.stringify(bad)?.slice(0, 60));
assert.deepEqual(parseRules([{ rule: 'ok', mode: 'block' }, { rule: '', mode: 'block' }, 7], false), [{ rule: 'ok', mode: 'block' }], 'a saved file keeps its good rules');

// wildMatch: `*` any characters (also `/`), `?` one.
assert.ok(wildMatch('*192.168.2.19', 'root@192.168.2.19')); assert.ok(wildMatch('a?c', 'abc')); assert.ok(wildMatch('*', ''));
assert.ok(!wildMatch('a*', 'b')); assert.ok(!wildMatch('a?c', 'ac')); assert.ok(wildMatch('--force*', '--force-with-lease')); assert.ok(wildMatch('*/bin/*', '/usr/bin/npm'));
// A `*` in the command text is a character that a rule's `*` also matches (AGENTS.md rule 13), and the matcher agrees with
// a regular expression on many random rules and texts.
for (const [p, s] of [['rm *', 'rm *.log'], ['rm -rf *', 'rm -rf *.bak'], ['*log', '*.log'], ['*', '*x'], ['a*', 'a*x'], ['a*b', 'a**b']]) assert.ok(wildMatch(p, s), `${p} vs ${s}`);
{
  const ref = (p, s) => new RegExp(`^${[...p].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c === '.' ? '\\.' : c)).join('')}$`, 's').test(s);
  let seed = 7;
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % n; };
  const text = (max) => Array.from({ length: rnd(max + 1) }, () => 'ab*?.'[rnd(5)]).join('');
  for (let k = 0; k < 50000; k++) { const p = text(6); const s = text(8); assert.equal(wildMatch(p, s), ref(p, s), `${JSON.stringify(p)} vs ${JSON.stringify(s)}`); }
}

// The scanner.
const cmds = (text, pwsh) => shellCommands(text, pwsh).map((w) => w.join(' '));
const has = (text, want, pwsh) => assert.ok(cmds(text, pwsh).includes(want), `${JSON.stringify(text)} has ${JSON.stringify(want)}: ${JSON.stringify(cmds(text, pwsh))}`);
const lacks = (text, want, pwsh) => assert.ok(!cmds(text, pwsh).includes(want), `${JSON.stringify(text)} has no ${JSON.stringify(want)}`);
has('cd web && npm publish', 'npm publish'); has('a; npm publish', 'npm publish'); has('a | npm publish', 'npm publish'); has('a || npm publish &', 'npm publish');
has('a\nnpm publish', 'npm publish'); has('(cd x; npm publish)', 'npm publish'); has('{ npm publish; }', 'npm publish'); has('x(){ npm publish; }; x', 'npm publish');
has('echo "$(npm publish)"', 'npm publish'); has('echo `npm publish`', 'npm publish'); has('echo "a `npm publish` b"', 'npm publish'); has('echo $(echo $(npm publish))', 'npm publish');
has("bash -c 'npm publish'", 'npm publish'); has('sh -lc "cd x && npm publish"', 'npm publish'); has('/bin/zsh -c "npm publish"', 'npm publish');
has('eval "npm publish"', 'npm publish'); has("bash <<< 'npm publish'", 'npm publish'); has("bash <<<'npm publish'", 'npm publish');
has("bash <<'EOF'\nnpm publish\nEOF", 'npm publish', false); has("cat <<'EOF' | bash\nnpm publish\nEOF", 'npm publish');
has('cat <<EOF\n$(npm publish)\nEOF', 'npm publish'); has('cat <<-EOF\n\t$(npm publish)\n\tEOF\nls', 'npm publish'); has('npm\\\n publish', 'npm publish');
has('echo $((1<<2)); npm publish', 'npm publish', false); has('cat <<EOF\nno end line; npm publish', 'npm publish');
lacks("cat <<'EOF' > notes.md\nnpm publish\nEOF\nls", 'npm publish'); lacks("cat <<< 'npm publish'", 'npm publish'); lacks('# npm publish\nls', 'npm publish');
assert.deepEqual(cmds('git commit -m "npm publish fix"'), ['git commit -m npm publish fix'], 'a quoted text is one word');
assert.deepEqual(cmds("echo 'a;b' \"c|d\" e\\;f"), ['echo a;b c|d e;f'], 'quoted and escaped separators are text');
assert.deepEqual(cmds('echo ${A}{b,c} {x}'), ['echo ${A}{b,c} {x}'], 'a brace word is not a group');
assert.deepEqual(cmds("echo 'never closed; npm publish"), ['echo never closed; npm publish'], 'an open quote never throws');
for (const odd of ['', ')', '))))', '`', '$(', '"$(', "'", '<<', '<<"', '{', '}', '\\', 'a <<EOF', '<<EOF\n', 'eval', 'bash -c', 'iex']) assert.ok(Array.isArray(shellCommands(odd)), JSON.stringify(odd));
// pwsh: backtick escape, '' and "" inside quotes, $(…), & "name", iex and -Command.
has('& "npm" publish', 'npm publish', true); has('Write-Output "$(npm publish)"', 'npm publish', true); has('iex "npm publish"', 'npm publish', true);
has("pwsh -Command 'npm publish'", 'npm publish', true); has('powershell -c "npm publish"', 'npm publish', true); has("bash -c 'npm publish'", 'npm publish', true);
assert.deepEqual(cmds("echo 'it''s' \"a\"\"b\" x`;y", true), ["echo it's a\"b x;y"]);
// The script is where the shell takes it (AGENTS.md rule 13). sh: the first word that is not an option after a `-…c…`
// group (`+c` too); `--`/`-` end the options; each `o`/`O` of a group takes a value; case-sensitive (`-C` is noclobber).
// pwsh (any case): `-`, `--` or `/` and a prefix of `command` (the rest of the words), `-cwa`/`-CommandWithArgs` (the next
// word); `-CustomPipeName` and `-ConfigurationFile` are not `-Command`.
for (const text of ['bash -c -x "npm publish"', 'bash -c -- "npm publish"', 'bash -c -o pipefail "npm publish"', 'bash -o pipefail -c "npm publish"',
  'bash -co pipefail "npm publish"', 'bash -oc pipefail "npm publish"', 'bash -coO pipefail extglob "npm publish"', 'bash -c +O extglob "npm publish"',
  'bash --rcfile /dev/null -c "npm publish"', 'bash --norc -xc "npm publish"', 'bash +c "npm publish"', 'sh -c - "npm publish"', 'bash -c -- -x', 'su - root -c "npm publish"',
  'pwsh -CustomPipeName p -Command "npm publish"', 'pwsh -ConfigurationFile c.json -c "npm publish"', 'pwsh -NoProfile -co "npm publish"', 'pwsh --command "npm publish"',
  'pwsh /c "npm publish"', 'pwsh -COMMAND npm publish', 'pwsh -cwa "npm publish" x', 'powershell -CommandWithArgs "npm publish"']) {
  const want = text.endsWith('-x') ? '-x' : 'npm publish';
  has(text, want); has(text, want, true);
}
for (const text of ['bash script.sh', 'bash -C x.sh', 'pwsh -File s.ps1', 'pwsh -c', 'bash -c']) assert.deepEqual(cmds(text), [text], `${text}: no script to read again`);

// Rules against commands.
const R = parseRules([{ rule: 'npm publish', mode: 'block' }, { rule: 'git push --force', mode: 'ask' }, { rule: 'ssh *192.168.2.19', mode: 'block' }, { rule: 'rm -rf', mode: 'ask' }]);
const rule = (command, pwsh) => blockedHit(R, command, pwsh)?.rule;
for (const [command, want] of [
  ['npm publish --access public', 'npm publish'], ['cd web && npm publish', 'npm publish'], ['git -C /x push origin main --force', 'git push --force'],
  ['sudo -u ci npm publish', 'npm publish'], ['env A=1 npm publish', 'npm publish'], ['timeout 5 npm publish', 'npm publish'], ['/usr/bin/NPM.exe Publish', 'npm publish'],
  ['bash -c "npm publish"', 'npm publish'], ['echo "$(npm publish)"', 'npm publish'], ['ssh -i k root@192.168.2.19 uptime', 'ssh *192.168.2.19'],
  ['git commit -m "npm publish fix"', undefined], ['git status; echo push', undefined], ['git push origin main', undefined], ['npm install', undefined],
  ['CMD=npm; $CMD publish', undefined], ['ssh 192.168.2.20', undefined], ['', undefined],
  ['bash -c -x "npm publish"', 'npm publish'], ['bash -c -- "npm publish"', 'npm publish'], ['pwsh -CustomPipeName p -Command "npm publish"', 'npm publish'],
  ['pwsh -ConfigurationFile c.json -c "npm publish"', 'npm publish'],
]) assert.equal(rule(command), want, command);
assert.equal(blockedHit(parseRules([{ rule: 'rm -rf *', mode: 'block' }]), 'rm -rf *.bak')?.rule, 'rm -rf *', 'a * rule and a shell glob');
assert.equal(rule('npm.cmd publish', true), 'npm publish', 'pwsh: npm.cmd');
const askFirst = parseRules([{ rule: 'rm -rf', mode: 'ask' }, { rule: 'npm publish', mode: 'block' }]);
assert.deepEqual(blockedHit(askFirst, 'rm -rf build && npm publish'), { rule: 'npm publish', mode: 'block', command: 'npm publish' }, 'a block rule wins over an earlier ask rule');
assert.equal(rule('# npm publish\nls'), undefined, 'a comment is not a command');
assert.equal(rule('ls # npm publish'), undefined, 'a comment after a command');
assert.deepEqual(blockedHit(R, 'rm -rf build'), { rule: 'rm -rf', mode: 'ask', command: 'rm -rf build' });
assert.equal(blockedHit([], 'npm publish'), undefined); assert.equal(blockedHit(R, undefined), undefined); assert.equal(blockedHit(R, { command: 'npm publish' }), undefined);

// Time: a long command is read in linear time; deep nesting stops at the depth limit.
{
  const one = [{ rule: 'npm publish', mode: 'block' }];
  let t = Date.now();
  assert.equal(blockedHit(one, `echo ${'a'.repeat(1 << 20)} && npm publish`)?.rule, 'npm publish');
  assert.ok(Date.now() - t < 2000, `1 MB command: ${Date.now() - t} ms`);
  t = Date.now();
  blockedHit(one, '$('.repeat(200000)); blockedHit(one, 'eval '.repeat(100000)); blockedHit(one, 'bash -c "'.repeat(50000)); blockedHit(one, '<<A\n'.repeat(50000));
  assert.ok(Date.now() - t < 4000, `nested commands: ${Date.now() - t} ms`);
  t = Date.now();
  blockedHit(Array.from({ length: BLOCK_MAX }, (_, i) => ({ rule: `x${i}* y* z*`, mode: 'block' })), 'a b c; '.repeat(100000));
  assert.ok(Date.now() - t < 4000, `50 rules × 100k commands: ${Date.now() - t} ms`);
}

// The gate and the route, with fake dsh services.
const root = await mkdtemp(join(tmpdir(), 'cp-blocked-'));
try {
  const home = join(root, 'home');
  const file = join(home, 'storages/dsh-composer-plus/blocked-commands.json');
  const listeners = []; const routes = new Map();
  let policy; // the chat's effective approval policy (dsh-user-approval `effectivePolicy`: its override, else the default)
  installBlockedCommands({
    on: (name, fn) => listeners.push([name, fn]),
    get: (name) => (name === 'approval' ? { effectivePolicy: () => policy ?? 'ask', overrideOf: () => undefined } : undefined),
    connection: { fetch: { register: (r) => routes.set(r.path, r) } },
  }, home, file);
  const gate = listeners.find(([n]) => n === 'tools/pre-execute')[1];
  const run = (name, command, downstream = { kind: 'allow' }, raw = false) => gate({ name, arguments: raw ? { command } : JSON.stringify({ command }), agent: { session: {} } }, async () => downstream);
  const call = async (method, body) => {
    const r = await routes.get(BLOCKED_PATH).fetch(new Request(`http://h${BLOCKED_PATH}`, method === 'GET' ? {} : { method, body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: r.status, data: await r.json() };
  };
  let r = await call('GET');
  assert.deepEqual(r.data, { on: true, rules: [] }, 'on with no rules');
  assert.deepEqual(await run('bash', 'npm publish'), { kind: 'allow' }, 'no rules: nothing changes');
  for (const body of ['nope', 'null', '[]', {}, { on: 'yes' }, { rules: 'x' }, { rules: [{ rule: '', mode: 'block' }] }, { on: true, rules: [] }]) assert.equal((await call('POST', body)).status, 400, JSON.stringify(body));
  r = await call('POST', { rules: [{ rule: 'npm publish', mode: 'block' }, { rule: 'git push --force', mode: 'ask' }] });
  assert.equal(r.status, 200); assert.deepEqual(r.data.rules, [{ rule: 'npm publish', mode: 'block' }, { rule: 'git push --force', mode: 'ask' }]);
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'owner-only');

  // block: denied with the reason; the agent is told to ask the user.
  let d = await run('bash', 'cd web && npm publish --access public');
  assert.equal(d.kind, 'deny');
  assert.match(d.reason, /^Blocked command: npm publish --access public matches "npm publish" in Composer Plus → Blocked commands\./);
  assert.match(d.reason, /ask the user/);
  assert.equal((await run('bash', 'npm publish', { kind: 'ask', reason: 'later gate' })).kind, 'deny', 'a block rule also refuses a call that would ask');
  assert.equal((await run('pwsh', '& npm publish')).kind, 'deny', 'pwsh');
  assert.equal((await run('bash', 'npm publish', { kind: 'allow' }, true)).kind, 'deny', 'object arguments');
  // A denied or cancelled call stays so; other tools and other commands are not changed.
  assert.deepEqual(await run('bash', 'npm publish', { kind: 'deny', reason: 'approval' }), { kind: 'deny', reason: 'approval' }, 'another gate decides first');
  assert.deepEqual(await run('bash', 'npm publish', { kind: 'cancel' }), { kind: 'cancel' });
  assert.deepEqual(await run('bash', 'npm test'), { kind: 'allow' });
  assert.deepEqual(await run('bash', 'npm test', { kind: 'ask', reason: 'x' }), { kind: 'ask', reason: 'x' });
  assert.deepEqual(await gate({ name: 'read', arguments: { file_path: 'npm publish', command: 'npm publish' } }, async () => ({ kind: 'allow' })), { kind: 'allow' }, 'only bash and pwsh');
  assert.deepEqual(await gate({ name: 'bash', arguments: 'not json' }, async () => ({ kind: 'allow' })), { kind: 'allow' }, 'unreadable arguments');

  // ask first: dsh's approval card; never an Auto review ask; a later gate's ask keeps its own reason.
  d = await run('bash', 'git push origin main --force');
  assert.equal(d.kind, 'ask');
  assert.match(d.reason, /^Composer Plus → Blocked commands: git push origin main --force matches "git push --force" \(ask first\)\.$/);
  assert.ok(!d.reason.startsWith('Auto review denied tool '));
  assert.equal(isGrantedAsk({ event: 'approval/request', agentId: 's1', request: { reason: d.reason, toolName: 'bash' } }, { s1: ['bash'] }), false,
    'Tether: Allow for this chat does not answer a Blocked commands ask');
  d = await run('bash', 'git push --force', { kind: 'ask', reason: 'Auto review denied tool "bash": risky' });
  assert.equal(d.kind, 'ask'); assert.match(d.reason, /^Composer Plus → Blocked commands: .*\(ask first\)\. Auto review denied tool "bash": risky$/);
  assert.ok(!d.reason.startsWith('Auto review denied tool '), 'Allow for this chat must not answer it');
  // A chat that cannot ask (approval policy never) gets the reason as a deny.
  policy = 'never';
  d = await run('bash', 'git push --force');
  assert.equal(d.kind, 'deny'); assert.match(d.reason, /\(ask first, and this chat cannot ask: its approval policy is never\)/);
  policy = undefined;
  // An older approval service without effectivePolicy: its override, else its configured default.
  {
    const ls = []; const fake = { overrideOf: () => undefined, config: { policy: 'never' } };
    installBlockedCommands({ on: (n, fn) => ls.push([n, fn]), get: (n) => (n === 'approval' ? fake : undefined), connection: { fetch: { register() {} } } }, home, file);
    const g = ls[0][1];
    assert.equal((await g({ name: 'bash', arguments: { command: 'git push --force' }, agent: { session: {} } }, async () => ({ kind: 'allow' }))).kind, 'deny', 'the configured default never');
    fake.overrideOf = () => 'ask';
    assert.equal((await g({ name: 'bash', arguments: { command: 'git push --force' }, agent: { session: {} } }, async () => ({ kind: 'allow' }))).kind, 'ask', 'the chat override ask');
    fake.overrideOf = () => { throw Error('no session'); };
    assert.equal((await g({ name: 'bash', arguments: { command: 'git push --force' }, agent: { session: {} } }, async () => ({ kind: 'allow' }))).kind, 'ask', 'a failing service: ask (dsh decides)');
  }

  // The list applies at once; an empty list and the switch.
  await call('POST', { rules: [] });
  assert.deepEqual(await run('bash', 'npm publish'), { kind: 'allow' }, 'an empty list blocks nothing');
  await call('POST', { rules: [{ rule: 'npm publish', mode: 'block' }] });
  r = await call('POST', { on: false }); assert.equal(r.data.on, false); assert.deepEqual(r.data.rules, [{ rule: 'npm publish', mode: 'block' }], 'the switch keeps the list');
  assert.deepEqual(await run('bash', 'npm publish'), { kind: 'allow' }, 'switched off');
  await call('POST', { on: true });
  assert.equal((await run('bash', 'npm publish')).kind, 'deny', 'switched on again');
  // A long command shows cut in the reason (no control characters).
  d = await run('bash', `npm publish ${'x'.repeat(500)}\u0007`);
  assert.ok(d.reason.length < 400); assert.doesNotMatch(d.reason, /[\u0000-\u001f]/);

  // A broken file reads as on with its good rules.
  await writeFile(file, '{"on": true, "rules": [{"rule": "", "mode": "block"}, {"rule": "rm -rf", "mode": "ask"}]}');
  const again = new Map();
  installBlockedCommands({ on() {}, get() {}, connection: { fetch: { register: (x) => again.set(x.path, x) } } }, home, file);
  assert.deepEqual(await (await again.get(BLOCKED_PATH).fetch(new Request(`http://h${BLOCKED_PATH}`))).json(), { on: true, rules: [{ rule: 'rm -rf', mode: 'ask' }] });
  await writeFile(file, 'not json');
  const third = new Map();
  installBlockedCommands({ on() {}, get() {}, connection: { fetch: { register: (x) => third.set(x.path, x) } } }, home, file);
  assert.deepEqual(await (await third.get(BLOCKED_PATH).fetch(new Request(`http://h${BLOCKED_PATH}`))).json(), { on: true, rules: [] });
} finally { await rm(root, { recursive: true, force: true }); }
console.log('blocked commands checks passed');
