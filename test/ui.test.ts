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
import type { Key } from '../src/keys.ts';
import { Oidc, Signer } from '../src/oidc.ts';
import { ui } from '../src/ui.ts';

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
  const res = await request('/');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<strong>alpha<\/strong>/);
  assert.match(body, /http:\/\/beta\.test\/mcp/);
  const csp = res.headers.get('content-security-policy')!;
  const nonce = csp.match(/script-src 'nonce-([^']+)'/)![1];
  assert.ok(body.includes(`<script nonce="${nonce}">`), 'the only script carries the nonce');
  assert.ok(!/ on[a-z]+="/.test(body), 'no inline event handlers');
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
  assert.equal((await post(`/keys/${key!.id}`, { name: 'agent-2', servers: ['beta'], allow: 'beta-*' })).status, 303);
  const [updated] = JSON.parse(readFileSync(keysPath, 'utf8')) as Key[];
  assert.equal(updated!.name, 'agent-2');
  assert.deepEqual(updated!.scope, { servers: ['beta'], tools: { allow: ['beta-*'] } });
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
    const claims = { iss: idp.url, aud: 'mcpyard', sub: 'u1', preferred_username: 'admin', nonce: grant.nonce, groups: idp.groups, exp: Date.now() / 1000 + 300 };
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

test('without a session the UI redirects to login and refuses posts', async () => {
  const { request, post } = oidcSetup();
  const res = await request('/keys');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/auth/login?return=%2Fkeys');
  assert.equal((await post('/keys', { name: 'x' })).status, 401);
});

test('OIDC login with PKCE opens a session', async () => {
  const { request } = oidcSetup();
  const callback = await login(request);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/keys');
  const session = callback.headers.get('set-cookie')!.match(/mcpyard_session=[^;]+/)![0];
  const page = await request('/keys', { headers: { cookie: session } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /font-medium">admin<\/div>/);
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
