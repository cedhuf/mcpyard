import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { Hub } from '../src/front.ts';
import type { State } from '../src/upstream.ts';

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
