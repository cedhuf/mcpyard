import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { app, Hub } from '../src/front.ts';
import { event, logs, note } from '../src/logs.ts';
import type { Key } from '../src/keys.ts';
import { Oidc, Signer } from '../src/oidc.ts';
import { ui } from '../src/ui.ts';
import { Skills } from '../src/skills.ts';
import { contextTokens, type Row } from '../src/ui-servers.ts';
import type { Upstream } from '../src/upstream.ts';

const PUBLIC = 'http://yard.test';
const hub = new Hub(parseConfig('servers:\n  alpha: { command: /bin/true }\n  beta: { url: "http://beta.test/mcp" }'));

function setup(auth: Parameters<typeof ui>[1]['auth']) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpyard-ui-'));
  const keysPath = join(dir, 'keys.json');
  const server = app(hub, keysPath, ui(hub, { keysPath, auth, publicUrl: PUBLIC }));
  const request = (path: string, init: RequestInit = {}) => server.request(`${PUBLIC}${path}`, init);
  const post = (path: string, form: Record<string, string | string[]>, headers: Record<string, string> = { origin: PUBLIC }) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const one of [v].flat()) body.append(k, one);
    return request(path, { method: 'POST', body, headers });
  };
  return { dir, keysPath, request, post };
}

test('servers page lists every server with its state', async () => {
  const { request } = setup({ kind: 'none' });
  const res = await request('/servers');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<a class="[^"]*after:inset-0[^"]*" href="\/servers\/alpha"><span class="font-mono">alpha<\/span><\/a>/);
  assert.match(body, /http:\/\/beta\.test\/mcp/);
  const csp = res.headers.get('content-security-policy')!;
  const nonce = csp.match(/script-src 'nonce-([^']+)'/)![1];
  assert.ok(body.includes(`<script nonce="${nonce}">`), 'the only script carries the nonce');
  assert.ok(!/ on[a-z]+="/.test(body), 'no inline event handlers');
});

test('the navbar search looks in the current section and keeps its filters', async () => {
  const { request, post } = setup({ kind: 'none' });
  await post('/keys', { name: 'laptop' });
  assert.match(await (await request('/')).text(), /<form method="get" action="\/servers"[^>]*role="search"/, 'the dashboard searches servers');
  assert.match(await (await request('/logs?kind=calls')).text(), /<form method="get" action="\/logs"[^>]*>\s*<input type="hidden" name="kind" value="calls"/);
  const keys = await (await request('/keys?q=nothing-like-this')).text();
  assert.match(keys, /<form method="get" action="\/keys"/);
  assert.match(keys, /No key matches <strong>nothing-like-this<\/strong>/);
  assert.ok(!(await (await request('/servers?q=bet')).text()).includes('href="/servers/alpha"'), 'the servers search filters');
});

test('unknown pages get the mascot, and the font and mascot are served', async () => {
  const { request } = setup({ kind: 'none' });
  const missing = await request('/nothing-here');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Nothing grows here/);
  assert.equal((await request('/keys/none/edit')).status, 404);
  const font = await request('/assets/fredoka.woff2');
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal((await request('/icon.png')).status, 200);
});

test('the dashboard sums up the yard and runs checks', async () => {
  const { request, post } = setup({ kind: 'none' });
  const page = await (await request('/')).text();
  for (const text of ['Healthy servers', 'Health check', 'Updates', 'Security check', 'Web UI sign-in', 'data-clock']) assert.ok(page.includes(text), text);
  assert.match(page, /Sign-in is off: anyone reaching the port manages the hub/);
  const health = await post('/dashboard/health', {});
  assert.equal(health.headers.get('location'), '/?done=health');
  assert.ok(hub.lastHealth && hub.lastHealth.results.every((r) => !r.ok), 'servers that never started do not answer');
  assert.equal((await post('/dashboard/update-all', {})).headers.get('location'), '/?done=update&n=0');
  assert.equal((await post('/dashboard/reload', {})).status, 400, 'no server file to reload');
});

test('each server has its own page with tabs and breadcrumbs', async () => {
  const { request } = setup({ kind: 'none' });
  note('hello from alpha', { server: 'alpha' });
  const overview = await (await request('/servers/alpha')).text();
  assert.match(overview, /class="breadcrumbs[\s\S]*href="\/servers">Servers<\/a>[\s\S]*aria-current="page">alpha</);
  assert.match(overview, /href="\/servers\/alpha\/logs"[^>]*>Logs<span[^>]*>\d+</);
  const logsTab = await (await request('/servers/alpha/logs')).text();
  assert.ok(logsTab.includes('hello from alpha'));
  assert.equal((await request('/servers/nope')).status, 404);
});

test('skills are added, edited and deleted from the server page', async () => {
  const { dir, request, post } = setup({ kind: 'none' });
  hub.skills = await Skills.load(join(dir, 'skills'));
  try {
    assert.match(await (await request('/servers/alpha/skills')).text(), /No skills yet[\s\S]*href="\/servers\/alpha\/new-skill"/);
    assert.equal((await post('/servers/alpha/skills', { name: 'Bad Name', description: 'x', body: '' })).status, 400);
    assert.equal((await post('/servers/alpha/skills', { name: 'triage', description: '', body: '' })).status, 400, 'a description is required');
    const added = await post('/servers/alpha/skills', { name: 'triage', description: 'Sort mail: use for inbox zero.', body: 'Archive old newsletters.' });
    assert.equal(added.headers.get('location'), '/servers/alpha/skills?saved=triage');
    assert.equal(readFileSync(join(dir, 'skills/alpha/triage/SKILL.md'), 'utf8'), '---\nname: triage\ndescription: "Sort mail: use for inbox zero."\n---\n\nArchive old newsletters.\n');
    assert.equal((await post('/servers/alpha/skills', { name: 'triage', description: 'again', body: '' })).status, 400, 'names are unique per server');
    const list = await (await request('/servers/alpha/skills')).text();
    assert.match(list, /href="\/servers\/alpha\/skills"[^>]*>Skills<span[^>]*>1</);
    assert.match(list, /Sort mail: use for inbox zero\./);
    assert.match(await (await request('/servers/alpha/skills/triage')).text(), /<textarea[^>]*name="body"[^>]*>Archive old newsletters\.<\/textarea>/);
    await post('/servers/alpha/skills/triage', { description: 'Sort mail.', body: 'New text.' });
    assert.match(readFileSync(join(dir, 'skills/alpha/triage/SKILL.md'), 'utf8'), /description: Sort mail\.\n---\n\nNew text\.\n$/);
    assert.match(await (await request('/servers')).text(), /1 skill · ~\d+ tokens/);
    assert.equal((await post('/servers/alpha/skills/triage/delete', {})).headers.get('location'), '/servers/alpha/skills?deleted=triage');
    assert.equal(hub.skillsOf('alpha').length, 0);
    assert.equal((await request('/servers/alpha/skills/triage')).status, 404);
  } finally {
    hub.skills = undefined;
  }
});

test('the context estimate counts only the exposed tools', () => {
  const tool = (name: string) => ({ name, description: 'x'.repeat(400), inputSchema: { type: 'object' as const } });
  const row = (deny: string[]): Row => ({
    name: 's',
    config: parseConfig(`servers:\n  s: { command: x, tools: { deny: [${deny.join(',')}] } }`).s!,
    upstream: { tools: [tool('a'), tool('b')] } as unknown as Upstream,
    uiDisabled: false,
    skills: [],
  });
  const both = contextTokens(row([]));
  assert.ok(both > 200 && both < 260, String(both));
  assert.equal(contextTokens(row(['b'])), Math.round(both / 2));
});

test('a server is switched off from the UI, kept off across restarts, and filtered', async () => {
  const { dir, post, request } = setup({ kind: 'none' });
  const state = join(dir, 'state.json');
  hub.useState(state);
  const res = await post('/servers/alpha/disable', {}, { origin: PUBLIC, referer: `${PUBLIC}/servers?state=online` });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/servers?state=online');
  assert.ok(hub.isDisabled('alpha'));
  assert.equal(hub.upstreams.get('alpha')!.state, 'stopped');
  assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')), { disabled: ['alpha'] });

  const off = await (await request('/servers?state=disabled')).text();
  assert.match(off, /action="\/servers\/alpha\/enable"/);
  assert.ok(!off.includes('>beta<'), 'the filter hides the other servers');
  assert.match(await (await request('/servers?q=bet')).text(), />beta</);

  const again = new Hub(parseConfig('servers:\n  alpha: { command: /bin/true }'));
  again.useState(state);
  assert.ok(again.isDisabled('alpha'), 'the switch survives a restart');
  assert.equal((await post('/servers/nope/disable', {})).status, 404);
  await hub.setDisabled('alpha', false);
  await hub.upstreams.get('alpha')!.stop();
});

test('the logs page lists calls, actions and output, and filters them', async () => {
  const { request, post } = setup({ kind: 'none' });
  logs.clear();
  event('tool_call', { key: 'laptop', server: 'alpha', tool: 'alpha-search', ok: true, ms: 12 });
  event('tool_call', { key: 'agent', server: 'beta', tool: 'beta-send', ok: false, ms: 40, error: 'quota exceeded' });
  note('listening on stdio', { server: 'alpha' });
  await post('/keys', { name: 'logged' });

  const all = await (await request('/logs')).text();
  for (const text of ['alpha-search', 'beta-send', 'quota exceeded', 'listening on stdio', 'key created']) assert.ok(all.includes(text), text);

  const calls = await (await request('/logs?kind=calls')).text();
  assert.ok(calls.includes('alpha-search') && !calls.includes('listening on stdio'), 'the calls tab shows only MCP calls');
  assert.match(calls, /stat-title">Failed<\/div>\s*<div class="stat-value[^"]*text-error">1</);

  const errors = await (await request('/logs?kind=errors')).text();
  assert.ok(errors.includes('beta-send') && !errors.includes('alpha-search'));
  const alpha = await (await request('/logs?server=alpha')).text();
  assert.ok(alpha.includes('alpha-search') && !alpha.includes('beta-send'), 'a server link narrows to that server');
  assert.ok(!(await (await request('/logs?q=quota')).text()).includes('alpha-search'), 'the search matches error text');
});

test('keys are created with a scope, shown once, disabled and deleted', async () => {
  const { keysPath, post, request } = setup({ kind: 'none' });
  const res = await post('/keys', { name: 'laptop', servers: ['alpha'], deny: '*-delete_*, *-send_*' });
  assert.equal(res.status, 200);
  const token = (await res.text()).match(/yard_[0-9a-f]{8}_[A-Za-z0-9_-]+/)![0];
  const [key] = JSON.parse(readFileSync(keysPath, 'utf8')) as Key[];
  assert.deepEqual(key!.scope, { servers: ['alpha'], tools: { deny: ['*-delete_*', '*-send_*'] } });
  assert.ok(!readFileSync(keysPath, 'utf8').includes(token), 'only the hash is stored');

  assert.equal((await post(`/keys/${key!.id}/disable`, {})).status, 303);
  assert.equal((JSON.parse(readFileSync(keysPath, 'utf8')) as Key[])[0]!.enabled, false);
  const mcp = await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal(mcp.status, 401, 'a disabled key is refused');

  assert.equal((await post(`/keys/${key!.id}/delete`, {})).status, 303);
  assert.deepEqual(JSON.parse(readFileSync(keysPath, 'utf8')), []);
});

test('a key can be renamed and rescoped without changing its token', async () => {
  const { keysPath, post, request } = setup({ kind: 'none' });
  const token = (await (await post('/keys', { name: 'agent', servers: ['alpha'] })).text()).match(/yard_[0-9a-f]{8}_[A-Za-z0-9_-]+/)![0];
  const [key] = JSON.parse(readFileSync(keysPath, 'utf8')) as Key[];
  const form = await (await request(`/keys/${key!.id}/edit`)).text();
  assert.match(form, /value="agent"/);
  assert.match(form, /value="alpha" checked/);
  assert.equal((await post(`/keys/${key!.id}`, { name: 'agent-2', admin: ['false', 'true'], servers: ['beta'], allow: 'beta-*' })).status, 303);
  const [updated] = JSON.parse(readFileSync(keysPath, 'utf8')) as Key[];
  assert.equal(updated!.name, 'agent-2');

  assert.deepEqual(updated!.scope, { servers: ['beta', 'yard'], tools: { allow: ['beta-*'] } });
  assert.equal(updated!.hash, key!.hash);
  assert.ok(token);
});

test('reload without a configuration file reports the error and changes nothing', async () => {
  const { post } = setup({ kind: 'none' });
  const res = await post('/reload', {});
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Configuration not reloaded[\s\S]*no configuration file to reload/);
  assert.equal(hub.upstreams.size, 2);
});

test('posts without a same-origin Origin header are refused', async () => {
  const { post } = setup({ kind: 'none' });
  assert.equal((await post('/keys', { name: 'x' }, {})).status, 403);
  assert.equal((await post('/keys', { name: 'x' }, { origin: 'http://evil.test' })).status, 403);
  assert.equal((await post('/keys', { name: 'x' }, { origin: 'null' })).status, 403);
});

// A minimal identity provider: discovery, JWKS and a token endpoint that checks PKCE and signs ES256 id_tokens.
const idp = { url: '', groups: ['mcpyard-admins'], tamper: false, codes: new Map<string, { challenge: string; nonce: string }>() };
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
let idpServer: ReturnType<typeof serve>;

before(async () => {
  const provider = new Hono();
  provider.get('/*', async (c, next) => (c.req.path.endsWith('/.well-known/openid-configuration') ? c.json(discovery()) : next()));
  const discovery = () => ({ issuer: idp.url, authorization_endpoint: `${idp.url}/authorize`, token_endpoint: `${idp.url}/token`, jwks_uri: `${idp.url}/jwks` });
  provider.get('/jwks', (c) => c.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'ES256' }] }));
  provider.post('/token', async (c) => {
    const form = await c.req.parseBody();
    const grant = idp.codes.get(String(form.code));
    const verifier = createHash('sha256').update(String(form.code_verifier)).digest('base64url');
    if (!grant || verifier !== grant.challenge || c.req.header('authorization') !== `Basic ${btoa('mcpyard:s3cret')}`) {
      return c.json({ error: 'invalid_grant' }, 400);
    }
    const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const claims = { iss: idp.url, aud: 'mcpyard', sub: 'u1', preferred_username: 'admin', picture: 'https://avatars.example.test/u1.png', nonce: grant.nonce, groups: idp.groups, exp: Date.now() / 1000 + 300 };
    const input = `${enc({ alg: 'ES256', kid: 'k1' })}.${enc(claims)}`;
    let signature = sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    if (idp.tamper) signature = signature.slice(0, -4) + (signature.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    return c.json({ id_token: `${input}.${signature}`, access_token: 'x', token_type: 'Bearer' });
  });
  await new Promise<void>((resolve) => {
    idpServer = serve({ fetch: provider.fetch, port: 0 }, (info: AddressInfo) => {
      idp.url = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

after(() => idpServer.close());

function oidcSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'mcpyard-oidc-'));
  const oidc = new Oidc({ issuer: idp.url, clientId: 'mcpyard', clientSecret: 's3cret', publicUrl: PUBLIC, allowedGroups: ['mcpyard-admins'] });
  return setup({ kind: 'oidc', oidc, signer: new Signer(dir) });
}

/** Plays the browser through login and returns the callback response. */
async function login(request: ReturnType<typeof setup>['request']): Promise<Response> {
  const start = await request('/auth/login?return=/keys');
  const authorize = new URL(start.headers.get('location')!);
  assert.equal(authorize.origin + authorize.pathname, `${idp.url}/authorize`);
  const code = `code-${Math.random()}`;
  idp.codes.set(code, { challenge: authorize.searchParams.get('code_challenge')!, nonce: authorize.searchParams.get('nonce')! });
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  return request(`/auth/callback?code=${code}&state=${authorize.searchParams.get('state')}`, { headers: { cookie } });
}

test('the logo files are public and cached', async () => {
  const { request } = oidcSetup();
  for (const path of ['/favicon.ico', '/favicon-32x32.png', '/apple-touch-icon.png']) {
    const res = await request(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('cache-control')!, /max-age/);
  }
});

test('without a session the UI redirects to login and refuses posts', async () => {
  const { request, post } = oidcSetup();
  const res = await request('/keys');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/auth/login?return=%2Fkeys');
  assert.equal((await post('/keys', { name: 'x' })).status, 401);
  const form = await post('/keys', { name: 'x' }, { origin: PUBLIC, referer: `${PUBLIC}/servers/mail`, 'sec-fetch-mode': 'navigate' });
  assert.equal(form.status, 303, 'a form posted after the session expired goes to login');
  assert.equal(form.headers.get('location'), '/auth/login?return=%2Fservers%2Fmail');
});

test('OIDC login with PKCE opens a session', async () => {
  const { request } = oidcSetup();
  const callback = await login(request);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/keys');
  const session = callback.headers.get('set-cookie')!.match(/mcpyard_session=[^;]+/)![0];
  const page = await request('/keys', { headers: { cookie: session } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<li class="menu-title truncate">admin<\/li>/);
  assert.match(await (await request('/keys', { headers: { cookie: session } })).text(), /<img src="https:\/\/avatars\.example\.test\/u1\.png"/);
  assert.match(page.headers.get('content-security-policy')!, /img-src 'self' data: https:\/\/avatars\.example\.test;/, 'the avatar host is allowed, nothing else');
});

test('a provider announcing another issuer is refused', async () => {
  const oidc = new Oidc({ issuer: `${idp.url}/other`, clientId: 'mcpyard', publicUrl: PUBLIC });
  await assert.rejects(oidc.begin('/'), /announces issuer/);
});

test('a bad signature or a missing group never opens a session', async () => {
  const { request } = oidcSetup();
  idp.tamper = true;
  const tampered = await login(request);
  idp.tamper = false;
  assert.equal(tampered.status, 403);
  assert.match(await tampered.text(), /signature is invalid/);

  idp.groups = ['users'];
  const outsider = await login(request);
  idp.groups = ['mcpyard-admins'];
  assert.equal(outsider.status, 403);
  assert.ok(!outsider.headers.get('set-cookie')?.includes('mcpyard_session=ey'));
});
