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
import { newKey } from '../src/keys.ts';

const dir = mkdtempSync(join(tmpdir(), 'mcpyard-'));
const full = newKey('full');
const narrow = newKey('narrow');
narrow.key.scope.tools = { deny: ['*-delete_*'] };
const admin = newKey('admin', 'admin');
const readOnly = newKey('read-only', 'admin');
readOnly.key.scope = { servers: ['other'], tools: { allow: ['list_servers', 'get_server'] } };
writeFileSync(join(dir, 'keys.json'), JSON.stringify([full.key, narrow.key, admin.key, readOnly.key]));

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

test('bad, missing and admin keys get 401 on /mcp', async () => {
  for (const auth of [`Bearer ${full.token}x`, '', `Bearer ${admin.token}`]) {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: auth, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
  }
});

const json = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((result.content as { text: string }[])[0]!.text);

test('admin endpoint reports and restarts servers', async () => {
  const client = await connect(admin.token, '/admin/mcp');
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ['get_server', 'list_servers', 'reload_config', 'restart_server', 'update_server']);
  const [server] = json(await client.callTool({ name: 'list_servers' }));
  assert.equal(server.name, 'fix-ture');
  assert.equal(server.state, 'ready');
  assert.equal(server.tools, 4);
  const detail = json(await client.callTool({ name: 'get_server', arguments: { name: 'fix-ture' } }));
  assert.deepEqual(detail.tools.find((t: { name: string }) => t.name === 'fix-ture-echo'), { name: 'fix-ture-echo', exposed: true });
  const restarted = json(await client.callTool({ name: 'restart_server', arguments: { name: 'fix-ture' } }));
  assert.equal(restarted.state, 'ready');
  await client.close();
});

test('admin key scope limits servers and tools', async () => {
  const client = await connect(readOnly.token, '/admin/mcp');
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ['get_server', 'list_servers']);
  assert.deepEqual(json(await client.callTool({ name: 'list_servers' })), []);
  const result = await client.callTool({ name: 'get_server', arguments: { name: 'fix-ture' } });
  assert.equal(result.isError, true);
  await client.close();
});

test('client keys get 401 on /admin/mcp', async () => {
  const res = await fetch(new URL('/admin/mcp', url), { method: 'POST', headers: { Authorization: `Bearer ${full.token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
});

test('config needs exactly one of package, url or command', () => {
  assert.throws(() => parseConfig('servers:\n  a: { command: x, url: "http://x" }'), /exactly one/);
  assert.throws(() => parseConfig('servers:\n  "a b": { command: x }'), /Invalid key.*"a b"/s);
  assert.throws(() => parseConfig('servers:\n  a: { command: "${NOPE_NOT_SET}" }', {}), /NOPE_NOT_SET/);
  assert.throws(() => parseConfig('servers:\n  a: { command: x, env: { T: ${T} } }', { T: 't' }), /quote references/);
});
