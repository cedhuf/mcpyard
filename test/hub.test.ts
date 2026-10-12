import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { app, Hub } from '../src/front.ts';
import { loadKeys, newKey } from '../src/keys.ts';

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
let url: URL;
let http: ReturnType<typeof serve>;

before(async () => {
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
  await client.close();
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
    'yard-get_server',
    'yard-list_servers',
    'yard-reload_config',
    'yard-restart_server',
    'yard-update_server',
  ]);
  const [server] = json(await client.callTool({ name: 'yard-list_servers' }));
  assert.equal(server.name, 'fix-ture');
  assert.equal(server.state, 'ready');
  assert.equal(server.tools, 4);
  const detail = json(await client.callTool({ name: 'yard-get_server', arguments: { name: 'fix-ture' } }));
  assert.deepEqual(detail.tools.find((t: { name: string }) => t.name === 'fix-ture-echo'), { name: 'fix-ture-echo', exposed: true });
  const restarted = json(await client.callTool({ name: 'yard-restart_server', arguments: { name: 'fix-ture' } }));
  assert.equal(restarted.state, 'ready');
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
