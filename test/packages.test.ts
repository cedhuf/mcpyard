import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { app, Hub } from '../src/front.ts';
import { newKey } from '../src/keys.ts';
import { Packages, type Installer } from '../src/packages.ts';
import type { State } from '../src/upstream.ts';

const fixture = join(import.meta.dirname, 'fixture-server.ts');

/** Lays out what `npm install` would: a manifest and a `.bin` script. `broken` versions exit at once, `multi` ones have two bins. */
function fakeInstaller(installs: string[]): Installer {
  return {
    async install(spec, version, dir) {
      installs.push(version);
      const pkg = join(dir, 'node_modules', spec.npm!);
      const bins = join(dir, 'node_modules', '.bin');
      mkdirSync(pkg, { recursive: true });
      mkdirSync(bins, { recursive: true });
      const names = version.includes('multi') ? ['one', 'two'] : ['fake'];
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: spec.npm, version, bin: Object.fromEntries(names.map((n) => [n, 'x'])) }));
      for (const name of names) {
        const body = version.includes('broken') ? 'exit 1' : `FIXTURE_VERSION=${version} exec "${process.execPath}" "${fixture}"`;
        writeFileSync(join(bins, name), `#!/bin/sh\n${body}\n`);
        chmodSync(join(bins, name), 0o755);
      }
    },
  };
}

function setup(yaml: string, latest: { version: string }, dataDir = mkdtempSync(join(tmpdir(), 'mcpyard-pkg-'))) {
  const installs: string[] = [];
  const packages = new Packages({ dataDir, registry: { latest: async () => latest.version }, installer: fakeInstaller(installs) });
  const hub = new Hub(parseConfig(yaml), packages);
  hub.start();
  return { hub, installs, dataDir };
}

async function until(hub: Hub, server: string, states: State[]): Promise<void> {
  while (!states.includes(hub.upstreams.get(server)!.state)) await new Promise((r) => setTimeout(r, 20));
}

async function servedVersion(hub: Hub, server: string): Promise<unknown> {
  return ((await hub.upstreams.get(server)!.callTool('version', {})).content as { text: string }[])[0]!.text;
}

const unpinned = 'servers:\n  pkg: { package: { npm: fake-pkg } }';

test('unpinned package installs the registry latest and records it', async () => {
  const latest = { version: '1.0.0' };
  const { hub, installs, dataDir } = setup(unpinned, latest);
  await until(hub, 'pkg', ['ready']);
  assert.equal(await servedVersion(hub, 'pkg'), '1.0.0');
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'versions.json'), 'utf8')), { pkg: { version: '1.0.0' } });
  await hub.stop();

  latest.version = '2.0.0';
  const again = setup(unpinned, latest, dataDir);
  await until(again.hub, 'pkg', ['ready']);
  assert.equal(await servedVersion(again.hub, 'pkg'), '1.0.0', 'never updates on its own');
  assert.deepEqual(again.installs, [], 'reuses the installed directory');
  assert.deepEqual(again.hub.packageStatus().pkg, {
    pinned: false,
    installed: '1.0.0',
    previous: undefined,
    latest: { version: '2.0.0', checkedAt: again.hub.packageStatus().pkg!.latest!.checkedAt },
    updating: false,
    updateError: undefined,
  });
  assert.deepEqual(installs, ['1.0.0']);
  await again.hub.stop();
});

test('update switches to the new version, keeps one for rollback, survives a broken one', async () => {
  const { hub, dataDir } = setup(unpinned, { version: '1.0.0' });
  await until(hub, 'pkg', ['ready']);
  await hub.update('pkg', '1.1.0');
  await hub.update('pkg', '1.2.0');
  assert.equal(await servedVersion(hub, 'pkg'), '1.2.0');
  assert.equal(hub.packageStatus().pkg!.previous, '1.1.0');
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'versions.json'), 'utf8')), { pkg: { version: '1.2.0', previous: '1.1.0' } });
  assert.deepEqual(readdirSync(join(dataDir, 'packages', 'pkg')).sort(), ['1.1.0', '1.2.0']);

  await assert.rejects(hub.update('pkg', '1.3.0-broken'));
  assert.equal(hub.upstreams.get('pkg')!.state, 'ready');
  assert.equal(await servedVersion(hub, 'pkg'), '1.2.0');
  assert.ok(hub.packageStatus().pkg!.updateError);
  await hub.stop();
});

test('pinned package installs its version and refuses updates', async () => {
  const { hub, dataDir } = setup('servers:\n  pkg: { package: { npm: fake-pkg, version: 1.0.0 } }', { version: '2.0.0' });
  await until(hub, 'pkg', ['ready']);
  assert.equal(await servedVersion(hub, 'pkg'), '1.0.0');
  await assert.rejects(hub.update('pkg'), /not an unpinned package/);
  assert.deepEqual(readdirSync(dataDir).sort(), ['packages']);
  await hub.stop();
});

test('changing a pinned version removes the version pinned before', async () => {
  const first = setup('servers:\n  pkg: { package: { npm: fake-pkg, version: 1.0.0 } }', { version: '9.9.9' });
  await until(first.hub, 'pkg', ['ready']);
  await first.hub.stop();
  const second = setup('servers:\n  pkg: { package: { npm: fake-pkg, version: 1.1.0 } }', { version: '9.9.9' }, first.dataDir);
  await until(second.hub, 'pkg', ['ready']);
  assert.deepEqual(readdirSync(join(first.dataDir, 'packages', 'pkg')), ['1.1.0']);
  await second.hub.stop();
});

test('a package with several bins and no package.bin fails without blocking others', async () => {
  const { hub } = setup(
    `servers:\n  multi: { package: { npm: fake-pkg, version: 1.0.0-multi } }\n  pkg: { package: { npm: fake-pkg, version: 1.0.0 } }`,
    { version: '1.0.0' },
  );
  await until(hub, 'multi', ['failed']);
  assert.match(hub.upstreams.get('multi')!.lastError!, /several bins \(one, two\)/);
  await until(hub, 'pkg', ['ready']);
  await hub.stop();
});

test('invalid versions never become paths', async () => {
  const { hub } = setup(unpinned, { version: '../../escape' });
  await until(hub, 'pkg', ['failed']);
  assert.match(hub.upstreams.get('pkg')!.lastError!, /invalid version/);
  await hub.stop();
});

test('yard-update_server updates and rolls back over MCP', async () => {
  const { hub, dataDir } = setup(unpinned, { version: '1.0.0' });
  await until(hub, 'pkg', ['ready']);
  const admin = newKey('ops');
  admin.key.scope = { servers: ['yard'], tools: {} };
  writeFileSync(join(dataDir, 'keys.json'), JSON.stringify([admin.key]));
  const server = app(hub, join(dataDir, 'keys.json'));
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://hub.test/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${admin.token}` } },
      fetch: async (url, init) => server.fetch(new Request(url, init)),
    }),
  );
  const update = async (args: Record<string, string>) => {
    const result = await client.callTool({ name: 'yard-update_server', arguments: { name: 'pkg', ...args } });
    return { isError: result.isError, text: (result.content as { text: string }[])[0]!.text };
  };

  const updated = JSON.parse((await update({ version: '2.0.0' })).text);
  assert.equal(updated.package.installed, '2.0.0');
  assert.equal(updated.package.previous, '1.0.0');
  assert.equal(await servedVersion(hub, 'pkg'), '2.0.0');

  const failed = await update({ version: '3.0.0-broken' });
  assert.equal(failed.isError, true);
  assert.equal(await servedVersion(hub, 'pkg'), '2.0.0', 'a failed update leaves the running version');

  JSON.parse((await update({ version: '1.0.0' })).text);
  assert.equal(await servedVersion(hub, 'pkg'), '1.0.0');
  await client.close();
  await hub.stop();
});
