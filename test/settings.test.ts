import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigFile } from '../src/config.ts';
import { app, Hub } from '../src/front.ts';
import { newKey } from '../src/keys.ts';
import { Settings } from '../src/settings.ts';
import { ui } from '../src/ui.ts';

const PUBLIC = 'http://yard.test';
const fixture = join(import.meta.dirname, 'fixture-server.ts');

function setup(env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpyard-settings-'));
  const configPath = join(dir, 'mcpyard.yaml');
  writeFileSync(configPath, `# hand-written comment\nservers:\n  a:\n    command: ${process.execPath}\n    args: [${fixture}]\n    env:\n      TOKEN: \${A_TOKEN}\n`);
  const fullEnv = { A_TOKEN: 'secret', ...env };
  const configFile = new ConfigFile(configPath, fullEnv);
  const settings = new Settings(dir, fullEnv);
  const hub = new Hub(configFile.load(), undefined, () => configFile.load());
  const keysPath = join(dir, 'keys.json');
  const admin = newKey('ops', 'admin');
  writeFileSync(keysPath, JSON.stringify([admin.key]));
  const server = app(hub, keysPath, ui(hub, { keysPath, auth: { kind: 'none' }, publicUrl: PUBLIC, settings, configFile }), () => settings.value('adminEndpoint'));
  const request = (path: string, init: RequestInit = {}) => server.request(`${PUBLIC}${path}`, init);
  const post = (path: string, form: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const one of [v].flat()) body.append(k, one);
    return request(path, { method: 'POST', body, headers: { origin: PUBLIC } });
  };
  return { dir, configPath, settings, hub, request, post, admin };
}

test('settings come from the environment, then the file, then defaults', () => {
  const { dir, settings } = setup({ MCPYARD_VERSION_CHECK_HOURS: '12' });
  assert.deepEqual(settings.get('versionCheckHours'), { value: 12, source: 'env', env: 'MCPYARD_VERSION_CHECK_HOURS' });
  assert.throws(() => settings.set('versionCheckHours', '3'), /set by MCPYARD_VERSION_CHECK_HOURS/);
  assert.equal(settings.get('adminEndpoint').source, 'default');
  settings.set('adminEndpoint', 'false');
  assert.deepEqual(new Settings(dir, {}).get('adminEndpoint'), { value: false, source: 'file', env: 'MCPYARD_ADMIN_ENDPOINT' });
  assert.throws(() => new Settings(dir, {}).set('versionCheckHours', '0'), /1 to 168/);
  assert.throws(() => new Settings(dir, { MCPYARD_ADMIN_ENDPOINT: 'maybe' }), /true or false/);
});

test('the settings page locks environment values and turns the admin endpoint off', async () => {
  const { request, post, admin } = setup({ MCPYARD_VERSION_CHECK_HOURS: '12' });
  const page = await (await request('/settings')).text();
  assert.match(page, /<strong>12 h<\/strong> <span class="locked"/);
  assert.ok(!page.includes('name="versionCheckHours"'), 'a locked setting has no input');

  const mcp = (token: string) =>
    request('/admin/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
  assert.notEqual((await mcp(admin.token)).status, 404);
  assert.equal((await post('/settings', { adminEndpoint: 'false' })).status, 200);
  assert.equal((await mcp(admin.token)).status, 404);
  await post('/settings', { adminEndpoint: ['false', 'true'] });
  assert.notEqual((await mcp(admin.token)).status, 404);
});

test('servers are added, edited and removed through the file, keeping comments and references', async () => {
  const { configPath, hub, request, post } = setup();
  hub.start();

  const added = await post('/servers', { name: 'b', kind: 'command', command: process.execPath, args: fixture, env: 'KEY=${A_TOKEN}', deny: 'delete_*', enabled: 'true' });
  assert.equal(added.status, 303);
  let text = readFileSync(configPath, 'utf8');
  assert.match(text, /# hand-written comment/);
  assert.match(text, /TOKEN: \$\{A_TOKEN\}/, 'references stay references');
  assert.match(text, /KEY: \$\{A_TOKEN\}/);
  assert.ok(hub.upstreams.has('b'));
  assert.deepEqual(hub.configs.b!.tools, { deny: ['delete_*'] });

  const form = await (await request('/servers/b/edit')).text();
  assert.match(form, /KEY=\$\{A_TOKEN\}/);

  assert.equal((await post('/servers/b', { kind: 'command', command: process.execPath, args: fixture })).status, 303);
  assert.equal(hub.configs.b!.enabled, false, 'an unchecked box disables the server');

  const bad = await post('/servers/b', { kind: 'url', url: 'not a url', enabled: 'true' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Not saved/);
  assert.equal(hub.configs.b!.command, process.execPath, 'an invalid entry changes nothing');

  assert.equal((await post('/servers', { name: 'a', kind: 'command', command: 'x' })).status, 400, 'names are unique');
  assert.equal((await post('/servers', { name: 'a b', kind: 'command', command: 'x' })).status, 400);

  assert.equal((await post('/servers/b/delete', {})).status, 303);
  text = readFileSync(configPath, 'utf8');
  assert.ok(!/^  b:/m.test(text));
  assert.ok(!hub.upstreams.has('b'));
  await hub.stop();
});
