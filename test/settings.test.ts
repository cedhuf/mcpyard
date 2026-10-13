import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
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
import { setAppearance, stylesheet } from '../src/ui-layout.ts';
import { YARD_TOOLS } from '../src/yard.ts';

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
  const admin = newKey('ops', true);
  writeFileSync(keysPath, JSON.stringify([admin.key]));
  hub.yardEnabled = () => settings.value('adminTools');
  const server = app(hub, keysPath, ui(hub, { keysPath, auth: { kind: 'none' }, publicUrl: PUBLIC, settings, configFile }));
  const request = (path: string, init: RequestInit = {}) => server.request(`${PUBLIC}${path}`, init);
  const post = (path: string, form: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const one of [v].flat()) body.append(k, one);
    return request(path, { method: 'POST', body, headers: { origin: PUBLIC } });
  };
  return { dir, configPath, settings, hub, request, post, admin, server };
}

test('settings come from the environment, then the file, then defaults', () => {
  const { dir, settings } = setup({ MCPYARD_VERSION_CHECK_HOURS: '12' });
  assert.deepEqual(settings.get('versionCheckHours'), { value: 12, source: 'env', env: 'MCPYARD_VERSION_CHECK_HOURS' });
  assert.throws(() => settings.set('versionCheckHours', '3'), /set by MCPYARD_VERSION_CHECK_HOURS/);
  assert.equal(settings.get('adminTools').source, 'default');
  settings.set('adminTools', 'false');
  assert.deepEqual(new Settings(dir, {}).get('adminTools'), { value: false, source: 'file', env: 'MCPYARD_ADMIN_TOOLS' });
  assert.throws(() => new Settings(dir, {}).set('versionCheckHours', '-1'), /0 to 720/);
  assert.throws(() => new Settings(dir, { MCPYARD_ADMIN_TOOLS: 'maybe' }), /true or false/);
});

test('the settings page locks environment values and turns hub administration off', async () => {
  const { request, post, admin, server } = setup({ MCPYARD_VERSION_CHECK_HOURS: '12' });
  const page = await (await request('/settings')).text();
  assert.match(page, /<span>12 hours<\/span><span class="badge[^>]*>[\s\S]{0,800}MCPYARD_VERSION_CHECK_HOURS/);
  assert.match(page, /<form method="post" action="\/settings" data-autosave>/, 'settings save on change');
  assert.ok(!page.includes('name="versionCheckHours"'), 'a locked setting has no input');
  assert.match(page, /<section id="about"/);
  assert.match(page, /name="updateCheck"/);
  assert.match(page, /name="healthCheckMinutes"[^>]*value="5"/, 'the health check runs every 5 minutes by default');

  const yardTools = async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${PUBLIC}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${admin.token}` } },
        fetch: async (url, init) => server.fetch(new Request(url, init)),
      }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('yard-'));
    await client.close();
    return names.length;
  };
  assert.equal(await yardTools(), YARD_TOOLS.length);
  assert.equal((await post('/settings', { adminTools: 'false' })).status, 200);
  assert.equal(await yardTools(), 0);
  await post('/settings', { adminTools: ['false', 'true'] });
  assert.equal(await yardTools(), YARD_TOOLS.length);
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

test('themes are chosen from daisyUI, applied to pages and baked into the stylesheet', async () => {
  const { dir, settings, post, request } = setup({ MCPYARD_THEME_DARK: 'night' });
  assert.throws(() => settings.set('lightTheme', 'neon'), /expected one of/);
  assert.equal((await post('/settings', { theme: 'dark', lightTheme: 'cupcake' })).status, 200);
  assert.deepEqual([settings.value('theme'), settings.value('lightTheme'), settings.value('darkTheme')], ['dark', 'cupcake', 'night']);
  assert.match(await (await request('/settings')).text(), /MCPYARD_THEME_DARK/, 'the environment locks the dark theme');

  await setAppearance({ mode: 'dark', light: 'cupcake', dark: 'night' });
  const page = await (await request('/')).text();
  assert.match(page, /<html lang="en" data-theme="night">/);
  const night = (await stylesheet()).version;
  await setAppearance({ mode: 'system', light: 'winter', dark: 'dim' });
  assert.notEqual((await stylesheet()).version, night);
  assert.match(await (await request('/')).text(), /<html lang="en" >/);
  assert.ok(new Settings(dir, {}).value('lightTheme') === 'cupcake');
});
