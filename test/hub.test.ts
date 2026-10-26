import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { app, Hub } from '../src/front.ts';
import { loadKeys, newKey } from '../src/keys.ts';
import { logs } from '../src/logs.ts';
import { Skills } from '../src/skills.ts';

const dir = mkdtempSync(join(tmpdir(), 'mcpyard-'));
const full = newKey('full');
const narrow = newKey('narrow');
narrow.key.scope.tools = { deny: ['*-delete_*'] };
const admin = newKey('admin');
admin.key.scope = { servers: ['yard'], tools: {} };
const both = newKey('both', true);
const readOnly = newKey('read-only');
readOnly.key.scope = { servers: ['other', 'yard'], tools: { allow: ['yard-list_*', 'yard-get_*'] } };
writeFileSync(join(dir, 'keys.json'), JSON.stringify([full.key, narrow.key, admin.key, readOnly.key, both.key]));

process.env.SECRET_FROM_HUB = 'leaked';
const hub = new Hub(
  parseConfig(`
servers:
  fix-ture:
    command: ${process.execPath}
    args: [${join(import.meta.dirname, 'fixture-server.ts')}]
    tools: { deny: [env_never] }
`),
);
function writeSkill(path: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, 'skills', path, name, '..'), { recursive: true });
    writeFileSync(join(dir, 'skills', path, name), text);
  }
}
const skillMd = (name: string, body = 'Read `references/rules.md` first.') => `---\nname: ${name}\ndescription: How to use ${name}.\n---\n\n${body}\n`;
writeSkill('fix-ture/echo-well', { 'SKILL.md': skillMd('echo-well'), 'references/rules.md': 'Never echo secrets.\n' });
writeSkill('ghost/haunt', { 'SKILL.md': skillMd('haunt') });
writeSkill('loose', { 'SKILL.md': skillMd('loose') });

let url: URL;
let http: ReturnType<typeof serve>;

before(async () => {
  hub.skills = await Skills.load(join(dir, 'skills'));
  hub.start();
  await new Promise<void>((resolve) => {
    http = serve({ fetch: app(hub, join(dir, 'keys.json')).fetch, port: 0 }, (info: AddressInfo) => {
      url = new URL(`http://127.0.0.1:${info.port}/mcp`);
      resolve();
    });
  });
  while (hub.upstreams.get('fix-ture')!.state !== 'ready') await new Promise((r) => setTimeout(r, 50));
});

after(async () => {
  http.close();
  await hub.stop();
});

async function connect(token: string, path = '/mcp'): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(path, url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

test('merges tools under <server>-<tool> and routes calls', async () => {
  const client = await connect(full.token);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['fix-ture-delete_all', 'fix-ture-echo', 'fix-ture-env', 'fix-ture-version']);
  const result = await client.callTool({ name: 'fix-ture-echo', arguments: { text: 'hi' } });
  assert.deepEqual(result.content, [{ type: 'text', text: 'hi' }]);
  const [call] = logs.list().filter((e) => e.kind === 'call');
  assert.deepEqual([call!.text, call!.server, call!.fields?.key, call!.error], ['fix-ture-echo', 'fix-ture', 'full', false], 'the call is in the UI log');
  await client.close();
});

test('a health check pings every running server', async () => {
  const report = await hub.healthCheck();
  const [result] = report.results;
  assert.equal(result!.server, 'fix-ture');
  assert.ok(result!.ok && typeof result!.ms === 'number', 'the fixture answers its ping');
  assert.equal(hub.lastHealth, report);

  hub.lastHealth = { at: report.at, results: [{ server: 'fix-ture', ok: false, error: 'down' }] };
  await hub.healthCheck();
  assert.ok(logs.list().some((e) => e.text === 'server_answering' && e.server === 'fix-ture'), 'a server answering again is logged');
});

test('a used key records when it was last used', async () => {
  const client = await connect(full.token);
  await client.listTools();
  await client.close();
  const stored = (JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8')) as { id: string; lastUsed: string | null }[]).find((k) => k.id === full.key.id)!;
  assert.ok(stored.lastUsed && Date.now() - Date.parse(stored.lastUsed) < 60_000);
});

test('upstreams never inherit the hub environment', async () => {
  const client = await connect(full.token);
  const result = await client.callTool({ name: 'fix-ture-env' });
  assert.deepEqual(result.content, [{ type: 'text', text: 'unset' }]);
  await client.close();
});

test('key scope hides and refuses tools', async () => {
  const client = await connect(narrow.token);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(!names.includes('fix-ture-delete_all'));
  await assert.rejects(client.callTool({ name: 'fix-ture-delete_all' }));
  await client.close();
});

test('bad and missing keys get 401 on /mcp', async () => {
  for (const auth of [`Bearer ${full.token}x`, '']) {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: auth, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
  }
});

const json = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((result.content as { text: string }[])[0]!.text);

test('a key without administration never sees the yard tools', async () => {
  const client = await connect(full.token);
  assert.ok(!(await client.listTools()).tools.some((t) => t.name.startsWith('yard-')));
  await assert.rejects(client.callTool({ name: 'yard-restart_server', arguments: { name: 'fix-ture' } }), /unknown tool/);
  await client.close();
});

test('an administration-only key manages every server without seeing their tools', async () => {
  const client = await connect(admin.token);
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [
    'yard-check_updates',
    'yard-disable_server',
    'yard-enable_server',
    'yard-get_server',
    'yard-health_check',
    'yard-list_servers',
    'yard-overview',
    'yard-read_logs',
    'yard-reload_config',
    'yard-restart_server',
    'yard-set_title',
    'yard-update_all',
    'yard-update_server',
  ]);
  const [ping] = json(await client.callTool({ name: 'yard-health_check' }));
  assert.equal(ping.server, 'fix-ture');
  assert.equal(ping.ok, true);
  assert.deepEqual(json(await client.callTool({ name: 'yard-check_updates' })), [], 'no package server, nothing to update');
  assert.deepEqual(json(await client.callTool({ name: 'yard-update_all' })), { updating: [] });
  const summary = json(await client.callTool({ name: 'yard-overview' }));
  assert.deepEqual(summary.servers.healthy, ['fix-ture']);
  assert.ok(summary.keyList.some((k: { name: string }) => k.name === 'admin'), 'a key managing every server sees the keys');
  assert.ok(!JSON.stringify(summary.keyList).includes('hash'), 'never their hashes');
  const lines = json(await client.callTool({ name: 'yard-read_logs', arguments: { kind: 'calls', limit: 3 } }));
  assert.ok(lines.length > 0 && lines.length <= 3 && lines.every((l: { kind: string }) => l.kind === 'call'));
  assert.equal(lines[0].text, 'yard-overview', 'the newest first: a call is logged once it returns');
  const [server] = json(await client.callTool({ name: 'yard-list_servers' }));
  assert.equal(server.name, 'fix-ture');
  assert.equal(server.state, 'ready');
  assert.equal(server.tools, 4);
  const detail = json(await client.callTool({ name: 'yard-get_server', arguments: { name: 'fix-ture' } }));
  assert.deepEqual(detail.tools.find((t: { name: string }) => t.name === 'fix-ture-echo'), { name: 'fix-ture-echo', exposed: true });
  const restarted = json(await client.callTool({ name: 'yard-restart_server', arguments: { name: 'fix-ture' } }));
  assert.equal(restarted.state, 'ready');

  const off = json(await client.callTool({ name: 'yard-disable_server', arguments: { name: 'fix-ture' } }));
  assert.deepEqual([off.enabled, off.switchedOff, off.state], [false, true, 'stopped']);
  const fullClient = await connect(full.token);
  assert.ok(!(await fullClient.listTools()).tools.some((t) => t.name.startsWith('fix-ture-')), 'a switched-off server hides its tools');
  await fullClient.close();
  const on = json(await client.callTool({ name: 'yard-enable_server', arguments: { name: 'fix-ture' } }));
  assert.deepEqual([on.enabled, on.switchedOff, on.state], [true, false, 'ready']);
  await client.close();
});

test('the scope limits which servers and yard tools an admin key has', async () => {
  const client = await connect(readOnly.token);
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ['yard-get_server', 'yard-list_servers']);
  assert.deepEqual(json(await client.callTool({ name: 'yard-list_servers' })), []);
  assert.equal((await client.callTool({ name: 'yard-get_server', arguments: { name: 'fix-ture' } })).isError, true);
  await client.close();
});

test('a key with servers and administration has both on one connection', async () => {
  const client = await connect(both.token);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('fix-ture-echo') && names.includes('yard-list_servers'));
  await client.close();
});

test('keys from before administration moved into /mcp are converted', () => {
  const legacy = join(dir, 'legacy.json');
  const base = { id: 'abcd0123', hash: 'sha256:00', prefix: 'yard_abcd0123', created: '2026-01-01', lastUsed: null, enabled: true };
  writeFileSync(
    legacy,
    JSON.stringify([
      { ...base, name: 'ops', kind: 'admin', scope: { servers: ['*'], tools: { deny: ['restart_server'] } } },
      { ...base, name: 'scoped-ops', kind: 'admin', scope: { servers: ['mail'], tools: {} } },
      { ...base, name: 'assistant', kind: 'both', scope: { servers: ['*'], tools: {} } },
      { ...base, name: 'laptop', kind: 'client', scope: { servers: ['*'], tools: {} } },
    ]),
  );
  assert.deepEqual(
    loadKeys(legacy).map((k) => [k.name, k.scope, 'kind' in k]),
    [
      ['ops', { servers: ['yard'], tools: { deny: ['yard-restart_server'] } }, false],
      ['scoped-ops', { servers: ['mail', 'yard'], tools: { allow: ['yard-*'] } }, false],
      ['assistant', { servers: ['*', 'yard'], tools: {} }, false],
      ['laptop', { servers: ['*'], tools: {} }, false],
    ],
  );
});

test('config needs exactly one of package, url or command', () => {
  assert.throws(() => parseConfig('servers:\n  a: { command: x, url: "http://x" }'), /exactly one/);
  assert.throws(() => parseConfig('servers:\n  "a b": { command: x }'), /Invalid key.*"a b"/s);
  assert.throws(() => parseConfig('servers:\n  a: { command: "${NOPE_NOT_SET}" }', {}), /NOPE_NOT_SET/);
  assert.throws(() => parseConfig('servers:\n  a: { command: x, env: { T: ${T} } }', { T: 't' }), /quote references/);
  assert.throws(() => parseConfig('servers:\n  yard: { command: x }'), /reserved/);
});

test('hub skills reach the keys that see their server, and only those', async () => {
  const client = await connect(full.token);
  const skills = new SkillsClient(client);
  assert.ok(skills.supported);
  const { skills: listed } = await skills.list();
  assert.deepEqual(listed.map((s) => s.uri), ['skill://fix-ture/echo-well/SKILL.md'], 'unknown servers and loose skills stay hidden');
  const manifest = await skills.read(listed[0]!);
  assert.equal(manifest.frontmatter?.name, 'echo-well');
  assert.match(manifest.body!, /references\/rules\.md/);
  assert.equal((await skills.read(listed[0]!, 'references/rules.md')).text, 'Never echo secrets.\n');
  await assert.rejects(skills.get('skill://ghost/haunt/SKILL.md'));
  await client.close();

  const other = await connect(admin.token);
  assert.deepEqual((await new SkillsClient(other).list()).skills, []);
  await assert.rejects(other.readResource({ uri: 'skill://fix-ture/echo-well/SKILL.md' }));
  await other.close();
});

test('a reload serves new skills, and a switched-off server takes its skills along', async () => {
  writeSkill('fix-ture/later', { 'SKILL.md': skillMd('later', 'Added after start.') });
  await hub.reloadSkills();
  const client = await connect(full.token);
  const uris = async () => (await new SkillsClient(client).list()).skills.map((s) => s.uri);
  assert.deepEqual(await uris(), ['skill://fix-ture/echo-well/SKILL.md', 'skill://fix-ture/later/SKILL.md']);
  await hub.setDisabled('fix-ture', true);
  try {
    assert.deepEqual(await uris(), []);
  } finally {
    await hub.setDisabled('fix-ture', false);
    while (hub.upstreams.get('fix-ture')!.state !== 'ready') await new Promise((r) => setTimeout(r, 50));
  }
  await client.close();
});
