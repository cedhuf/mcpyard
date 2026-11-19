import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { ACCESS_SECONDS, issueTokens, loadKeys, newKey, refreshKey, saveKeys, type Key } from './keys.ts';
import { event } from './logs.ts';
import type { Signer } from './oidc.ts';

/**
 * The hub as an OAuth 2.1 authorization server for its own `/mcp` endpoint (MCP authorization, revision 2026-07-28).
 * Clients identify with a Client ID Metadata Document URL, or with a stateless, signed Dynamic Client Registration id.
 * An approved sign-in becomes a key whose rights were picked on the consent page.
 */

export type OAuthClient = { id: string; name: string; redirectUris: string[] };

export type AuthRequest = { client: string; clientName: string; redirectUri: string; challenge: string; state?: string };

type Code = AuthRequest & { name: string; scope: Key['scope']; user: string; expires: number };

type Resolve = (host: string) => Promise<string[]>;

const CODE_MS = 60_000;
const REQUEST_SECONDS = 600;
const DCR_SECONDS = 10 * 365 * 86_400;
const CIMD_MAX_BYTES = 10_240;
const CIMD_DEFAULT_SECONDS = 300;
const CIMD_MAX_SECONDS = 86_400;
const NO_STORE = { 'Cache-Control': 'no-store' };
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const PRIVATE = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(net, prefix, 'ipv6');

function privateAddress(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return PRIVATE.check(mapped, 'ipv4');
  return PRIVATE.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

const resolveHost: Resolve = async (host) => {
  const bare = host.replace(/^\[|\]$/g, '');
  return isIP(bare) ? [bare] : (await lookup(bare, { all: true })).map((a) => a.address);
};

/** OAuth for clients needs a public origin the browser and the client agree on: https, or plain http on localhost. */
export function oauthAllowed(publicUrl: string | undefined): boolean {
  try {
    const url = new URL(publicUrl ?? '');
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  } catch {
    return false;
  }
}

/** Redirect URIs must be https or loopback http, without a fragment. */
export function redirectAllowed(uri: string): boolean {
  try {
    const url = new URL(uri);
    return !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)));
  } catch {
    return false;
  }
}

/** Exact match, except the port of a loopback URI, which native clients pick at run time. */
export function redirectMatches(registered: string, asked: string): boolean {
  if (registered === asked) return true;
  try {
    const a = new URL(registered);
    const b = new URL(asked);
    if (a.protocol !== 'http:' || !LOOPBACK.has(a.hostname)) return false;
    a.port = '';
    b.port = '';
    return a.href === b.href;
  } catch {
    return false;
  }
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

async function capped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error('client metadata is larger than 10 KB');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class AuthServer {
  readonly issuer: string;
  readonly resource: string;
  private readonly codes = new Map<string, Code>();
  private readonly cimd = new Map<string, { client: OAuthClient; until: number }>();

  private readonly signer: Signer;
  private readonly keysPath: string;
  private readonly fetcher: typeof fetch;
  private readonly resolve: Resolve;

  constructor(publicUrl: string, signer: Signer, keysPath: string, fetcher: typeof fetch = fetch, resolve: Resolve = resolveHost) {
    this.signer = signer;
    this.keysPath = keysPath;
    this.fetcher = fetcher;
    this.resolve = resolve;
    this.issuer = publicUrl.replace(/\/$/, '');
    this.resource = `${this.issuer}/mcp`;
  }

  get resourceMetadataUrl(): string {
    return `${this.issuer}/.well-known/oauth-protected-resource/mcp`;
  }

  /** The routes a client reaches without a browser session: discovery, registration and the token endpoint. */
  routes(app: Hono<any>): void {
    const resource = () => ({ resource: this.resource, authorization_servers: [this.issuer], bearer_methods_supported: ['header'], resource_name: 'mcpyard' });
    app.use('/.well-known/*', cors());
    app.use('/oauth/register', cors(), bodyLimit({ maxSize: 16_384 }));
    app.use('/oauth/token', cors(), bodyLimit({ maxSize: 16_384 }));
    app.get('/.well-known/oauth-protected-resource', (c) => c.json(resource()));
    app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(resource()));
    app.get('/.well-known/oauth-authorization-server', (c) =>
      c.json({
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/oauth/authorize`,
        token_endpoint: `${this.issuer}/oauth/token`,
        registration_endpoint: `${this.issuer}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      }),
    );
    app.post('/oauth/register', (c) => this.register(c));
    app.post('/oauth/token', (c) => this.token(c));
  }

  async client(id: string): Promise<OAuthClient> {
    if (id.startsWith('https://')) return this.metadataDocument(id);
    const dcr = this.signer.open<{ dcr?: { n: string; r: string[] } }>(id)?.dcr;
    if (!dcr) throw new Error('unknown client_id');
    return { id, name: dcr.n, redirectUris: dcr.r };
  }

  /** Checks an authorization request. `fail` is shown to the user, never sent to an unverified redirect URI. */
  async authorize(params: URLSearchParams): Promise<{ fail: string } | { redirect: string } | { client: OAuthClient; request: AuthRequest }> {
    let client: OAuthClient;
    try {
      client = await this.client(params.get('client_id') ?? '');
    } catch (e) {
      return { fail: `The client could not be identified: ${(e as Error).message}.` };
    }
    const asked = params.get('redirect_uri');
    const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !client.redirectUris.some((r) => redirectMatches(r, redirectUri))) return { fail: 'The redirect URI is not one this client registered.' };
    const state = params.get('state') ?? undefined;
    const refuse = (error: string, error_description: string) => ({ redirect: this.back(redirectUri, state, { error, error_description }) });
    if (params.get('response_type') !== 'code') return refuse('unsupported_response_type', 'only the code flow is supported');
    const challenge = params.get('code_challenge');
    if (!challenge || params.get('code_challenge_method') !== 'S256') return refuse('invalid_request', 'PKCE with S256 is required');
    const resource = params.get('resource');
    if (resource && !this.isResource(resource)) return refuse('invalid_target', `this server only issues tokens for ${this.resource}`);
    return { client, request: { client: client.id, clientName: client.name, redirectUri, challenge, ...(state ? { state } : {}) } };
  }

  /** The request, signed, so the consent form carries it without server state. */
  seal(request: AuthRequest): string {
    return this.signer.sign({ authorize: request }, REQUEST_SECONDS);
  }

  open(sealed: string | undefined): AuthRequest | undefined {
    return this.signer.open<{ authorize?: AuthRequest }>(sealed)?.authorize;
  }

  approve(request: AuthRequest, name: string, scope: Key['scope'], user: string): string {
    const now = Date.now();
    for (const [code, entry] of this.codes) if (entry.expires < now) this.codes.delete(code);
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, { ...request, name, scope, user, expires: now + CODE_MS });
    return this.back(request.redirectUri, request.state, { code });
  }

  deny(request: AuthRequest): string {
    return this.back(request.redirectUri, request.state, { error: 'access_denied', error_description: 'the user denied access' });
  }

  private back(redirectUri: string, state: string | undefined, params: Record<string, string>): string {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries({ ...params, ...(state ? { state } : {}), iss: this.issuer })) url.searchParams.set(k, v);
    return url.href;
  }

  private isResource(value: string): boolean {
    try {
      return new URL(value).href.replace(/\/$/, '') === this.resource;
    } catch {
      return false;
    }
  }

  private async metadataDocument(url: string): Promise<OAuthClient> {
    const cached = this.cimd.get(url);
    if (cached && cached.until > Date.now()) return cached.client;
    const parsed = new URL(url);
    if (parsed.pathname === '/' || parsed.hash || parsed.username || parsed.password) throw new Error('a URL client_id needs a path, and no fragment or credentials');
    const addresses = await this.resolve(parsed.hostname);
    if (!addresses.length || addresses.some(privateAddress)) throw new Error(`${parsed.hostname} resolves to a private address`);
    const res = await this.fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000), headers: { accept: 'application/json' } });
    if (res.status !== 200) throw new Error(`client metadata answered HTTP ${res.status}`);
    let doc: { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown };
    try {
      doc = JSON.parse(await capped(res, CIMD_MAX_BYTES)) as typeof doc;
    } catch (e) {
      throw new Error((e as Error).message.includes('10 KB') ? (e as Error).message : 'client metadata is not JSON');
    }
    if (doc.client_id !== url) throw new Error('client metadata names another client_id');
    if (typeof doc.client_name !== 'string' || !doc.client_name.trim()) throw new Error('client metadata has no client_name');
    const uris = doc.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === 'string' && redirectAllowed(u))) {
      throw new Error('client metadata needs redirect_uris, each https or loopback http');
    }
    const client: OAuthClient = { id: url, name: doc.client_name.trim().slice(0, 100), redirectUris: uris as string[] };
    const control = res.headers.get('cache-control') ?? '';
    const seconds = /no-store|no-cache/.test(control) ? 0 : Number(control.match(/max-age=(\d+)/)?.[1] ?? CIMD_DEFAULT_SECONDS);
    this.cimd.set(url, { client, until: Date.now() + Math.min(seconds, CIMD_MAX_SECONDS) * 1000 });
    return client;
  }

  /** Dynamic Client Registration, deprecated by MCP but still used: the client_id is the signed metadata, nothing is stored. */
  private async register(c: Context): Promise<Response> {
    let body: { client_name?: unknown; redirect_uris?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_client_metadata', error_description: 'the body must be JSON' }, 400);
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === 'string' && u.length <= 2000 && redirectAllowed(u))) {
      return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https, or http on a loopback host' }, 400);
    }
    const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : 'Unnamed client';
    const clientId = this.signer.sign({ dcr: { n: name, r: uris } }, DCR_SECONDS);
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
      NO_STORE,
    );
  }

  private async token(c: Context): Promise<Response> {
    const form = new URLSearchParams(await c.req.text());
    const fail = (error: string, error_description: string) => c.json({ error, error_description }, 400, NO_STORE);
    const client = form.get('client_id') ?? '';
    const keys = loadKeys(this.keysPath);

    if (form.get('grant_type') === 'authorization_code') {
      const id = form.get('code') ?? '';
      const code = this.codes.get(id);
      this.codes.delete(id);
      if (!code || code.expires < Date.now()) return fail('invalid_grant', 'unknown or expired code');
      if (code.client !== client) return fail('invalid_grant', 'the code was issued to another client');
      const redirect = form.get('redirect_uri');
      if (redirect !== null && redirect !== code.redirectUri) return fail('invalid_grant', 'redirect_uri differs from the authorization request');
      if (s256(form.get('code_verifier') ?? '') !== code.challenge) return fail('invalid_grant', 'PKCE verification failed');
      const resource = form.get('resource');
      if (resource && !this.isResource(resource)) return fail('invalid_target', `this server only issues tokens for ${this.resource}`);
      const { key } = newKey(code.name);
      key.scope = code.scope;
      const tokens = issueTokens(key, { client: code.client, clientName: code.clientName, redirectHost: new URL(code.redirectUri).host, user: code.user });
      saveKeys(this.keysPath, [...keys, key]);
      event('oauth_key_created', { key: key.name, client: code.clientName, by: code.user });
      return this.tokens(c, tokens);
    }

    if (form.get('grant_type') === 'refresh_token') {
      const found = refreshKey(keys, form.get('refresh_token') ?? '', client);
      if ('error' in found) {
        if (found.disabled) {
          saveKeys(this.keysPath, keys);
          event('oauth_refresh_reused', { key: found.disabled.name });
        }
        return fail('invalid_grant', found.error);
      }
      const tokens = issueTokens(found.key, found.key.oauth!);
      saveKeys(this.keysPath, keys);
      return this.tokens(c, tokens);
    }

    return fail('unsupported_grant_type', 'use authorization_code or refresh_token');
  }

  private tokens(c: Context, tokens: { access: string; refresh: string }): Response {
    return c.json({ access_token: tokens.access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: tokens.refresh }, 200, NO_STORE);
  }
}
