import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigFile, parseConfig } from '../src/config.ts';
import { Hub } from '../src/front.ts';
import { newKey } from '../src/keys.ts';
import type { State } from '../src/upstream.ts';
import { YARD_TOOLS } from '../src/yard.ts';

const fixture = (extra = '') => `{ command: ${process.execPath}, args: [${join(import.meta.dirname, 'fixture-server.ts')}]${extra} }`;

async function until(hub: Hub, server: string, state: State): Promise<void> {
  while (hub.upstreams.get(server)?.state !== state) await new Promise((r) => setTimeout(r, 20));
}

test('reload starts, stops and restarts only what changed', async () => {
  let yaml = `servers:\n  a: ${fixture()}`;
  const hub = new Hub(parseConfig(yaml), undefined, () => parseConfig(yaml));
  hub.start();
  await until(hub, 'a', 'ready');
  const a = hub.upstreams.get('a');

  yaml = `servers:\n  a: ${fixture()}\n  b: ${fixture()}`;
  assert.deepEqual(await hub.reload(), { added: ['b'], removed: [], changed: [] });
  await until(hub, 'b', 'ready');
  assert.equal(hub.upstreams.get('a'), a, 'an unchanged server keeps running');

  yaml = `servers:\n  a: ${fixture(', tools: { deny: [delete_*] }')}`;
  assert.deepEqual(await hub.reload(), { added: [], removed: ['b'], changed: ['a'] });
  assert.equal(a!.state, 'stopped');
  assert.ok(!hub.upstreams.has('b'));
  await until(hub, 'a', 'ready');

  yaml = 'servers:\n  a: { command: x, url: "http://x" }';
  await assert.rejects(hub.reload(), /exactly one/);
  assert.ok(hub.configs.a!.tools.deny, 'a file that does not parse changes nothing');
  await hub.stop();
});

test('yard-set_title edits the server file without restarting the server', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mcpyard-')), 'mcpyard.yaml');
  writeFileSync(path, `servers:\n  a: ${fixture()}\n`);
  const file = new ConfigFile(path);
  const hub = new Hub(file.load(), undefined, () => file.load());
  hub.configFile = file;
  const a = hub.upstreams.get('a');
  const setTitle = YARD_TOOLS.find((t) => t.tool.name === 'set_title')!;
  const admin = newKey('admin').key;
  admin.scope = { servers: ['yard'], tools: {} };

  assert.equal(((await setTitle.run(hub, admin, { name: 'a', title: ' Server A ' })) as { title?: string }).title, 'Server A');
  assert.match(readFileSync(path, 'utf8'), /title: Server A/);
  assert.equal(hub.upstreams.get('a'), a, 'a title change does not restart the server');
  await setTitle.run(hub, admin, { name: 'a', title: '' });
  assert.equal(hub.configs.a!.title, undefined);
  await hub.stop();
});
