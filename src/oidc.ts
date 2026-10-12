import { constants, createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify, type webcrypto } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `picture` is the provider's avatar URL, kept only when it is http(s). */
export type User = { sub: string; name: string; picture?: string };

export type OidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** Base URL the browser reaches the hub at; the callback is `<publicUrl>/auth/callback`. */
  publicUrl: string;
  /** When set, the `groups` claim must contain one of these. */
  allowedGroups?: string[];
};

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
};

type Pending = { state: string; nonce: string; verifier: string; returnTo: string };

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const random = () => randomBytes(32).toString('base64url');

/** HMAC-signed, expiring JSON values for cookies. The key is generated once and kept in the data directory. */
export class Signer {
  private readonly key: Buffer;

  constructor(dataDir: string) {
    const path = join(dataDir, 'session.key');
    if (!existsSync(path)) {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    chmodSync(path, 0o600);
    this.key = Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
  }

  sign(value: unknown, ttlSeconds: number): string {
    const body = b64url(JSON.stringify({ v: value, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
    return `${body}.${this.mac(body)}`;
  }

  open<T>(cookie: string | undefined): T | undefined {
    const [body, mac] = cookie?.split('.') ?? [];
    if (!body || !mac) return undefined;
    const expected = Buffer.from(this.mac(body));
    const actual = Buffer.from(mac);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
    const { v, exp } = JSON.parse(Buffer.from(body, 'base64url').toString()) as { v: T; exp: number };
    return exp > Date.now() / 1000 ? v : undefined;
  }

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}

export class Oidc {
  readonly config: OidcConfig;
  private discovery?: Promise<Discovery>;

  constructor(config: OidcConfig) {
    this.config = { ...config, issuer: config.issuer.replace(/\/$/, ''), publicUrl: config.publicUrl.replace(/\/$/, '') };
  }

  get redirectUri(): string {
    return `${this.config.publicUrl}/auth/callback`;
  }

  /** The authorization URL to send the browser to, and what the callback must find again. */
  async begin(returnTo: string): Promise<{ url: string; pending: Pending }> {
    const d = await this.discover();
    const pending: Pending = { state: random(), nonce: random(), verifier: random(), returnTo };
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri,
      scope: this.config.allowedGroups ? 'openid profile email groups' : 'openid profile email',
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: b64url(createHash('sha256').update(pending.verifier).digest()),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), pending };
  }

  async finish(params: URLSearchParams, pending: Pending | undefined): Promise<User> {
    if (params.get('error')) throw new Error(`identity provider: ${params.get('error_description') ?? params.get('error')}`);
    if (!pending || params.get('state') !== pending.state) throw new Error('login expired or state mismatch, try again');
    const d = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.get('code') ?? '',
      redirect_uri: this.redirectUri,
      code_verifier: pending.verifier,
    });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const { clientId, clientSecret } = this.config;
    const methods = d.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    if (clientSecret && methods.includes('client_secret_basic')) {
      headers.authorization = `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`;
    } else {
      body.set('client_id', clientId);
      if (clientSecret) body.set('client_secret', clientSecret);
    }
    const res = await fetch(d.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`token endpoint: HTTP ${res.status} ${await res.text()}`);
    const { id_token } = (await res.json()) as { id_token?: string };
    if (!id_token) throw new Error('token endpoint returned no id_token');
    const claims = await this.verifyIdToken(id_token, d);
    if (claims.nonce !== pending.nonce) throw new Error('id_token nonce mismatch');
    const groups = Array.isArray(claims.groups) ? (claims.groups as string[]) : [];
    if (this.config.allowedGroups && !this.config.allowedGroups.some((g) => groups.includes(g))) {
      throw new Error(`${String(claims.preferred_username ?? claims.sub)} is not in an allowed group`);
    }
    const name = claims.preferred_username ?? claims.name ?? claims.email ?? claims.sub;
    const picture = typeof claims.picture === 'string' && /^https?:\/\//.test(claims.picture) ? claims.picture : undefined;
    return { sub: String(claims.sub), name: String(name), ...(picture ? { picture } : {}) };
  }

  private async verifyIdToken(token: string, d: Discovery): Promise<Record<string, unknown>> {
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) throw new Error('malformed id_token');
    const { alg, kid } = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg: string; kid?: string };
    const res = await fetch(d.jwks_uri, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`jwks: HTTP ${res.status}`);
    const { keys } = (await res.json()) as { keys: (webcrypto.JsonWebKey & { kid?: string; use?: string })[] };
    const jwk = keys.find((k) => (kid ? k.kid === kid : k.use !== 'enc'));
    if (!jwk) throw new Error(`no signing key ${kid ?? ''} in jwks`);
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const data = Buffer.from(`${header}.${payload}`);
    const sig = Buffer.from(signature, 'base64url');
    const hash = { 256: 'sha256', 384: 'sha384', 512: 'sha512' }[alg.slice(2)];
    let ok: boolean;
    if (alg === 'EdDSA') ok = verify(null, data, key, sig);
    else if (alg.startsWith('RS') && hash) ok = verify(hash, data, key, sig);
    else if (alg.startsWith('PS') && hash) ok = verify(hash, data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: Number(alg.slice(2)) / 8 }, sig);
    else if (alg.startsWith('ES') && hash) ok = verify(hash, data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    else throw new Error(`unsupported id_token alg ${alg}`);
    if (!ok) throw new Error('id_token signature is invalid');

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== d.issuer) throw new Error(`id_token issuer ${String(claims.iss)} is not ${d.issuer}`);
    if (!aud.includes(this.config.clientId)) throw new Error('id_token audience does not include this client');
    if (typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000 - 60) throw new Error('id_token expired');
    return claims;
  }

  private discover(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const url = `${this.config.issuer}/.well-known/openid-configuration`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const discovery = (await res.json()) as Discovery;
      if (discovery.issuer.replace(/\/$/, '') !== this.config.issuer) {
        throw new Error(`${url} announces issuer ${discovery.issuer}, expected ${this.config.issuer}`);
      }
      return discovery;
    })();
    this.discovery.catch(() => (this.discovery = undefined));
    return this.discovery;
  }
}
