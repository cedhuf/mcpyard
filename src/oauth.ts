import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OAuthClientMetadata, OAuthClientProvider, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client';

type Saved = { client?: StoredOAuthClientInformation; tokens?: StoredOAuthTokens };

/** Upstream OAuth credentials, one entry per server, in `<dataDir>/oauth.json`. Mode 600: it holds refresh tokens. */
export class OAuthStore {
  readonly publicUrl: string;
  private readonly path: string;
  private saved: Record<string, Saved> = {};

  constructor(dataDir: string, publicUrl: string) {
    this.path = join(dataDir, 'oauth.json');
    this.publicUrl = publicUrl.replace(/\/$/, '');
    try {
      this.saved = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, Saved>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  get(name: string): Saved {
    return this.saved[name] ?? {};
  }

  patch(name: string, change: Saved): void {
    this.saved[name] = { ...this.get(name), ...change };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  provider(name: string): UpstreamAuth {
    return new UpstreamAuth(this, name);
  }
}

/** The SDK's OAuth hooks for one server. The browser sign-in runs through the web UI, so the redirect is only recorded. */
export class UpstreamAuth implements OAuthClientProvider {
  /** Where the browser must go to sign in, once the server has asked for it. */
  signInUrl?: URL;
  private verifier?: string;
  private pendingState?: string;
  private readonly store: OAuthStore;
  private readonly name: string;

  constructor(store: OAuthStore, name: string) {
    this.store = store;
    this.name = name;
  }

  get redirectUrl(): string {
    return `${this.store.publicUrl}/servers/${this.name}/oauth/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'mcpyard',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    return (this.pendingState = randomBytes(16).toString('base64url'));
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    const client = this.store.get(this.name).client;
    // Registered under another public URL: register again rather than fail on a redirect mismatch.
    if (client && 'redirect_uris' in client && Array.isArray(client.redirect_uris) && !client.redirect_uris.includes(this.redirectUrl)) return undefined;
    return client;
  }

  saveClientInformation(client: StoredOAuthClientInformation): void {
    this.store.patch(this.name, { client });
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.store.get(this.name).tokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.store.patch(this.name, { tokens });
  }

  redirectToAuthorization(url: URL): void {
    this.signInUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('no sign-in in progress');
    return this.verifier;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') this.store.patch(this.name, { client: undefined });
    if (scope === 'all' || scope === 'tokens') this.store.patch(this.name, { tokens: undefined });
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
  }

  /** The SDK does not check the callback's state: it must match the sign-in this hub started. */
  checkState(state: string | null): void {
    if (!this.pendingState || state !== this.pendingState) throw new Error('sign-in expired or state mismatch, try again');
    this.pendingState = undefined;
  }
}
