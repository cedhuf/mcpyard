import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { app, Hub } from '../src/front.ts';
import { OAuthStore } from '../src/oauth.ts';
import { ui } from '../src/ui.ts';
import { Upstream } from '../src/upstream.ts';

const PUBLIC = 'http://yard.test';
const dataDir = () => mkdtempSync(join(tmpdir(), 'mcpyard-oauth-'));

test('oauth needs a url', () => {
  assert.throws(() => parseConfig('servers:\n  a: { command: x, oauth: true }'), /oauth needs a url/);
  assert.equal(parseConfig('servers:\n  a: { url: "https://x.test/mcp", oauth: true }').a!.oauth, true);
});

test('credentials survive a restart in a private file', () => {
  const dir = dataDir();
  const auth = new OAuthStore(dir, 'https://yard.test/').provider('sonos');
  assert.equal(auth.redirectUrl, 'https://yard.test/servers/sonos/oauth/callback');
  auth.saveClientInformation({ client_id: 'c1', redirect_uris: [auth.redirectUrl] });
  auth.saveTokens({ access_token: 'a', token_type: 'Bearer', refresh_token: 'r' });
  assert.equal(statSync(join(dir, 'oauth.json')).mode & 0o777, 0o600);
  const again = new OAuthStore(dir, 'https://yard.test').provider('sonos');
  assert.equal(again.clientInformation()?.client_id, 'c1');
  assert.equal(again.tokens()?.refresh_token, 'r');
  again.invalidateCredentials('tokens');
  assert.equal(new OAuthStore(dir, 'https://yard.test').provider('sonos').tokens(), undefined);
});

test('a client registered under another public URL registers again', () => {
  const dir = dataDir();
  new OAuthStore(dir, 'http://localhost:3000').provider('s').saveClientInformation({ client_id: 'old', redirect_uris: ['http://localhost:3000/servers/s/oauth/callback'] });
  assert.equal(new OAuthStore(dir, 'https://yard.test').provider('s').clientInformation(), undefined);
});

test('the callback state must match the sign-in in progress', () => {
  const auth = new OAuthStore(dataDir(), 'https://yard.test').provider('s');
  assert.throws(() => auth.checkState('x'), /state mismatch/);
  const state = auth.state();
  assert.throws(() => auth.checkState('other'), /state mismatch/);
  auth.checkState(state);
  assert.throws(() => auth.checkState(state), /state mismatch/);
});

async function fakeOAuthServer(t: TestContext): Promise<{ url: string; registrations: () => number }> {
  let registered = 0;
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.url === '/mcp') return res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }).end();
    if (req.url?.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (req.url === '/.well-known/oauth-authorization-server') {
      return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] });
    }
    if (req.url === '/register') {
      registered++;
      let body = '';
      req.on('data', (c: Buffer) => (body += c));
      return req.on('end', () => json({ ...JSON.parse(body), client_id: 'registered' }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, registrations: () => registered };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

test('a server that wants OAuth waits for a sign-in instead of retrying', async (t) => {
  const { url, registrations } = await fakeOAuthServer(t);
  const config = parseConfig(`servers:\n  s: { url: "${url}", oauth: true }`).s!;
  const upstream = new Upstream('s', config, () => {}, undefined, new OAuthStore(dataDir(), 'https://yard.test').provider('s'));
  upstream.start();
  await until(() => upstream.state === 'failed');
  await upstream.stop();
  assert.equal(registrations(), 1);
  const signIn = upstream.auth!.signInUrl!;
  assert.equal(signIn.searchParams.get('client_id'), 'registered');
  assert.equal(signIn.searchParams.get('redirect_uri'), 'https://yard.test/servers/s/oauth/callback');
  assert.ok(signIn.searchParams.get('state'));
});

test('the server page links to the sign-in and the callback refuses a foreign state', async (t) => {
  const { url } = await fakeOAuthServer(t);
  const dir = dataDir();
  const keysPath = join(dir, 'keys.json');
  const hub = new Hub(parseConfig(`servers:\n  s: { url: "${url}", oauth: true }`), undefined, undefined, new OAuthStore(dir, PUBLIC));
  t.after(() => hub.stop());
  hub.start();
  const upstream = hub.upstreams.get('s')!;
  await until(() => upstream.state === 'failed');
  const server = app(hub, keysPath, ui(hub, { keysPath, auth: { kind: 'none' }, publicUrl: PUBLIC }));
  const page = await (await server.request(`${PUBLIC}/servers/s`)).text();
  assert.match(page, /needs you to sign in/);
  assert.ok(page.includes(upstream.auth!.signInUrl!.href.replaceAll('&', '&amp;')));
  const res = await server.request(`${PUBLIC}/servers/s/oauth/callback?code=x&state=forged`);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /state mismatch/);
});
