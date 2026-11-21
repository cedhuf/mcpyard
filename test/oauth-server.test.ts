import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { app, Hub } from '../src/front.ts';
import type { Key } from '../src/keys.ts';
import { AuthServer, redirectMatches } from '../src/oauth-server.ts';
import { Oidc, Signer } from '../src/oidc.ts';
import { ui } from '../src/ui.ts';

const PUBLIC = 'https://yard.test';
const CLIENT = 'https://client.test/oauth/metadata.json';
const REDIRECT = 'http://127.0.0.1:43123/callback';
const hub = new Hub(parseConfig('servers:\n  alpha: { command: /bin/true }'));

function setup(documents: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpyard-oauth-'));
  const keysPath = join(dir, 'keys.json');
  const signer = new Signer(dir);
  const fetched: string[] = [];
  const fetcher = (async (url: string) => {
    fetched.push(url);
    return url in documents ? Response.json(documents[url], { headers: { 'cache-control': 'max-age=60' } }) : new Response('missing', { status: 404 });
  }) as typeof fetch;
  const resolve = async (host: string) => (host === 'intranet.test' ? ['192.168.1.10'] : ['93.184.216.34']);
  const authServer = new AuthServer(PUBLIC, signer, keysPath, fetcher, resolve);
  const oidc = new Oidc({ issuer: 'https://idp.test', clientId: 'yard', publicUrl: PUBLIC });
  const server = app(hub, keysPath, ui(hub, { keysPath, auth: { kind: 'oidc', oidc, signer }, authServer, publicUrl: PUBLIC }), authServer);
  const cookie = `mcpyard_session=${signer.sign({ sub: 'u1', name: 'alice' }, 3600)}`;
  const request = (path: string, init: RequestInit = {}) => server.request(`${PUBLIC}${path}`, init);
  const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    request(path, { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  const keys = () => JSON.parse(readFileSync(keysPath, 'utf8')) as Key[];
  return { keysPath, cookie, request, form, keys, fetched };
}

const verifier = 'a-verifier-long-enough-to-be-a-real-pkce-verifier-0123456789';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const metadata = { client_id: CLIENT, client_name: 'Test Client', redirect_uris: ['http://127.0.0.1/callback'] };

function authorizeQuery(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st4te',
    resource: `${PUBLIC}/mcp`,
    ...overrides,
  }).toString();
}

/** Runs the browser part of the flow and returns the authorization code. */
async function signIn(t: ReturnType<typeof setup>, query = authorizeQuery(), choice: Record<string, string> = { servers: '*' }): Promise<string> {
  const page = await t.request(`/oauth/authorize?${query}`, { headers: { cookie: t.cookie } });
  assert.equal(page.status, 200);
  const body = await page.text();
  const sealed = body.match(/name="request" value="([^"]+)"/)![1]!;
  const approved = await t.form('/oauth/authorize', { request: sealed, decision: 'allow', name: 'laptop', ...choice }, { cookie: t.cookie, origin: PUBLIC });
  assert.equal(approved.status, 303);
  const back = new URL(approved.headers.get('location')!);
  assert.equal(back.origin + back.pathname, 'http://127.0.0.1:43123/callback');
  assert.equal(back.searchParams.get('state'), 'st4te');
  assert.equal(back.searchParams.get('iss'), PUBLIC);
  return back.searchParams.get('code')!;
}

const exchange = (t: ReturnType<typeof setup>, code: string, client = CLIENT, codeVerifier = verifier) =>
  t.form('/oauth/token', { grant_type: 'authorization_code', code, client_id: client, redirect_uri: REDIRECT, code_verifier: codeVerifier, resource: `${PUBLIC}/mcp` });

test('the MCP endpoint points clients to the hub as their authorization server', async () => {
  const t = setup();
  const denied = await t.request('/mcp', { method: 'POST' });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('www-authenticate'), `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`);
  const resource = await (await t.request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.deepEqual(resource.authorization_servers, [PUBLIC]);
  assert.equal(resource.resource, `${PUBLIC}/mcp`);
  const meta = await t.request('/.well-known/oauth-authorization-server');
  assert.equal(meta.headers.get('access-control-allow-origin'), '*');
  const server = await meta.json();
  assert.equal(server.issuer, PUBLIC);
  assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
  assert.equal(server.client_id_metadata_document_supported, true);
  assert.equal(server.authorization_response_iss_parameter_supported, true);
});

test('a metadata-document client signs in, picks rights, refreshes, and reuse disables the key', async () => {
  const t = setup({ [CLIENT]: metadata });
  const page = await t.request(`/oauth/authorize?${authorizeQuery()}`, { headers: { cookie: t.cookie } });
  const body = await page.text();
  assert.match(body, /Allow Test Client\?/);
  assert.match(body, /127\.0\.0\.1:43123/, 'the redirect host is shown');
  assert.match(page.headers.get('content-security-policy')!, /form-action 'self' http:\/\/127\.0\.0\.1:43123/);

  const code = await signIn(t, authorizeQuery(), { servers: 'alpha', deny: '*-delete_*' });
  assert.equal((await exchange(t, code, CLIENT, 'wrong-verifier')).status, 400, 'a wrong verifier fails and burns the code');
  const again = await signIn(t, authorizeQuery(), { servers: 'alpha', deny: '*-delete_*' });
  const tokens = await (await exchange(t, again)).json();
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, 3600);
  assert.equal((await exchange(t, again)).status, 400, 'a code is single use');

  const [key] = t.keys();
  assert.deepEqual(key!.scope, { servers: ['alpha'], tools: { deny: ['*-delete_*'] } });
  assert.equal(key!.oauth!.clientName, 'Test Client');
  assert.equal(key!.oauth!.user, 'alice');
  const bearer = (token: string) => t.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.notEqual((await bearer(tokens.access_token)).status, 401);

  const refresh = (token: string) => t.form('/oauth/token', { grant_type: 'refresh_token', refresh_token: token, client_id: CLIENT });
  const renewed = await (await refresh(tokens.refresh_token)).json();
  assert.ok(renewed.access_token && renewed.refresh_token !== tokens.refresh_token, 'the refresh token rotates');
  assert.equal((await bearer(tokens.access_token)).status, 401, 'the previous access token stops working');
  assert.notEqual((await bearer(renewed.access_token)).status, 401);
  assert.equal((await refresh(tokens.refresh_token)).status, 400);
  assert.equal(t.keys()[0]!.enabled, false, 'a reused refresh token disables the key');
  assert.equal((await bearer(renewed.access_token)).status, 401);

  const listing = await (await t.request('/keys', { headers: { cookie: t.cookie } })).text();
  assert.match(listing, /Signed-in clients[\s\S]*Test Client · <span class="font-mono">127\.0\.0\.1:43123<\/span>[\s\S]*>Keys</);
});

test('an expired access token is refused until the client refreshes', async () => {
  const t = setup({ [CLIENT]: metadata });
  const tokens = await (await exchange(t, await signIn(t))).json();
  const keys = t.keys();
  keys[0]!.oauth!.expires = new Date(Date.now() - 1000).toISOString();
  writeFileSync(t.keysPath, JSON.stringify(keys));
  assert.equal((await t.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 401);
});

test('metadata documents are checked before anything is shown or redirected', async () => {
  const other = 'https://client.test/other.json';
  const t = setup({ [CLIENT]: metadata, [other]: { ...metadata, client_id: 'https://elsewhere.test/x' } });
  const refused = async (query: string, pattern: RegExp) => {
    const res = await t.request(`/oauth/authorize?${query}`, { headers: { cookie: t.cookie } });
    assert.equal(res.status, 400, query);
    assert.match(await res.text(), pattern);
  };
  await refused(authorizeQuery({ client_id: other }), /another client_id/);
  await refused(authorizeQuery({ client_id: 'https://intranet.test/meta.json' }), /private address/);
  await refused(authorizeQuery({ redirect_uri: 'https://attacker.test/cb' }), /redirect URI is not one this client registered/);
  await refused(authorizeQuery({ client_id: 'not-a-client' }), /could not be identified/);

  const noPkce = await t.request(`/oauth/authorize?${authorizeQuery({ code_challenge_method: 'plain' })}`, { headers: { cookie: t.cookie } });
  assert.equal(noPkce.status, 302);
  assert.equal(new URL(noPkce.headers.get('location')!).searchParams.get('error'), 'invalid_request');
  const wrongResource = await t.request(`/oauth/authorize?${authorizeQuery({ resource: 'https://other.test/mcp' })}`, { headers: { cookie: t.cookie } });
  assert.equal(new URL(wrongResource.headers.get('location')!).searchParams.get('error'), 'invalid_target');

  await t.request(`/oauth/authorize?${authorizeQuery()}`, { headers: { cookie: t.cookie } });
  assert.equal(t.fetched.filter((u) => u === CLIENT).length, 1, 'the document is cached');
});

test('dynamic registration hands out a signed client id that works without storage', async () => {
  const t = setup();
  const register = (body: unknown) => t.request('/oauth/register', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  assert.equal((await register({ redirect_uris: ['http://example.test/cb'] })).status, 400, 'plain http is loopback only');
  assert.equal((await register({ client_name: 'x' })).status, 400);
  const created = await register({ client_name: 'Registered', redirect_uris: ['http://localhost/callback'] });
  assert.equal(created.status, 201);
  const { client_id, token_endpoint_auth_method } = await created.json();
  assert.equal(token_endpoint_auth_method, 'none');

  const query = authorizeQuery({ client_id, redirect_uri: 'http://localhost:5555/callback' });
  const page = await t.request(`/oauth/authorize?${query}`, { headers: { cookie: t.cookie } });
  assert.match(await page.text(), /Allow Registered\?/);
  const forged = `${client_id.slice(0, -2)}xx`;
  assert.equal((await t.request(`/oauth/authorize?${authorizeQuery({ client_id: forged })}`, { headers: { cookie: t.cookie } })).status, 400);
});

test('signing in keeps the authorization request, and denying answers access_denied', async () => {
  const t = setup({ [CLIENT]: metadata });
  const anonymous = await t.request(`/oauth/authorize?${authorizeQuery()}`);
  assert.equal(anonymous.status, 302);
  const login = new URL(anonymous.headers.get('location')!, PUBLIC);
  assert.equal(login.pathname, '/auth/login');
  assert.equal(login.searchParams.get('return'), `/oauth/authorize?${authorizeQuery()}`);

  const body = await (await t.request(`/oauth/authorize?${authorizeQuery()}`, { headers: { cookie: t.cookie } })).text();
  const sealed = body.match(/name="request" value="([^"]+)"/)![1]!;
  const denied = await t.form('/oauth/authorize', { request: sealed, decision: 'deny' }, { cookie: t.cookie, origin: PUBLIC });
  assert.equal(new URL(denied.headers.get('location')!).searchParams.get('error'), 'access_denied');
  assert.equal((await t.form('/oauth/authorize', { request: 'forged', decision: 'allow', name: 'x' }, { cookie: t.cookie, origin: PUBLIC })).status, 400);
});

test('loopback redirect URIs match on any port, others exactly', () => {
  assert.ok(redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:8123/callback'));
  assert.ok(redirectMatches('http://localhost:3000/cb', 'http://localhost:4000/cb'));
  assert.ok(!redirectMatches('http://localhost/cb', 'http://localhost:4000/other'));
  assert.ok(!redirectMatches('https://app.test/cb', 'https://app.test:8443/cb'));
  assert.ok(redirectMatches('https://app.test/cb', 'https://app.test/cb'));
});
