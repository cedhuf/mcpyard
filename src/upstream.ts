import { Client, SSEClientTransport, StreamableHTTPClientTransport, UnauthorizedError, type Tool } from '@modelcontextprotocol/client';
import { SkillsClient, type Skill } from '@modelcontextprotocol/client/ext/skills';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import type { ServerConfig } from './config.ts';
import type { UpstreamAuth } from './oauth.ts';
import type { Launch, Packages } from './packages.ts';
import { note } from './logs.ts';
import { VERSION } from './release.ts';

/** `degraded`: was ready, lost its connection, reconnecting. `failed`: never got ready, retrying. */
export type State = 'installing' | 'starting' | 'ready' | 'degraded' | 'stopped' | 'failed';

const MIN_BACKOFF = 1_000;
const MAX_BACKOFF = 5 * 60_000;

export class Upstream {
  state: State = 'stopped';
  tools: Tool[] = [];
  /** Skills the server serves, as it addresses them. */
  skills: Skill[] = [];
  lastError?: string;
  /** Installed package version, once known. */
  version?: string;
  updateError?: string;
  updating = false;
  private client?: Client;
  private launch?: Launch;
  private stopped = true;
  private wasReady = false;
  private backoff = MIN_BACKOFF;
  private retry?: NodeJS.Timeout;
  private readonly name: string;
  private readonly config: ServerConfig;
  private readonly onChange: () => void;
  private readonly packages?: Packages;
  readonly auth?: UpstreamAuth;

  constructor(name: string, config: ServerConfig, onChange: () => void, packages?: Packages, auth?: UpstreamAuth) {
    this.name = name;
    this.config = config;
    this.onChange = onChange;
    this.packages = packages;
    this.auth = auth;
  }

  start(): void {
    if (!this.config.enabled) return;
    this.stopped = false;
    this.backoff = MIN_BACKOFF;
    void this.run();
  }

  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    const client = this.client;
    this.client = undefined;
    this.set('stopped');
    await client?.close();
  }

  /** Round trip of an MCP ping, in milliseconds. */
  async ping(timeoutMs = 5000): Promise<number> {
    if (!this.client || this.state !== 'ready') throw new Error(this.lastError ?? `not ready (${this.state})`);
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs)));
    try {
      await Promise.race([this.client.ping(), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return Date.now() - started;
  }

  async callTool(name: string, args: Record<string, unknown> | undefined) {
    if (!this.client || this.state !== 'ready') throw new Error(`server ${this.name} is not ready`);
    try {
      return await this.client.callTool({ name, arguments: args });
    } catch (e) {
      if (e instanceof UnauthorizedError && this.auth?.signInUrl) this.needsSignIn();
      throw e;
    }
  }

  /** One file of a skill this server serves, by its own URI. */
  async readSkillFile(uri: string): Promise<{ text: string; mimeType?: string } | { bytes: Uint8Array; mimeType?: string }> {
    if (!this.client || this.state !== 'ready') throw new Error(`server ${this.name} is not ready`);
    const file = (await this.client.readResource({ uri })).contents[0];
    if (!file) throw new Error(`server ${this.name} returned nothing for ${uri}`);
    return 'text' in file ? { text: file.text, mimeType: file.mimeType } : { bytes: Buffer.from(file.blob, 'base64'), mimeType: file.mimeType };
  }

  /** Completes a browser sign-in with the callback's query string, then connects with the new tokens. */
  async finishAuth(params: URLSearchParams): Promise<void> {
    if (!this.auth) throw new Error(`server ${this.name} does not use OAuth`);
    this.auth.checkState(params.get('state'));
    await (this.transport() as SSEClientTransport | StreamableHTTPClientTransport).finishAuth(params);
    this.auth.signInUrl = undefined;
    await this.restart();
  }

  /**
   * Installs `version` (default: the cached registry latest) next to the running one, starts it alongside and switches
   * traffic once it lists its tools. On failure the running version stays and the error is kept in `updateError`.
   */
  async update(version?: string): Promise<void> {
    const spec = this.config.package;
    if (!spec || spec.version) throw new Error(`server ${this.name} is not an unpinned package`);
    if (!this.packages) throw new Error('no package manager configured');
    if (this.updating) throw new Error(`server ${this.name} is already updating`);
    this.updating = true;
    this.updateError = undefined;
    this.onChange();
    try {
      const target = version ?? (await this.packages.latest(spec));
      if (target === this.version) return;
      const launch = await this.packages.prepare(this.name, spec, target, this.config.allowScripts);
      const { client, tools, skills } = await this.open(launch);
      if (this.stopped) return void (await client.close());
      const old = this.client;
      const previous = this.version;
      clearTimeout(this.retry);
      this.backoff = MIN_BACKOFF;
      this.launch = launch;
      this.version = target;
      this.client = client;
      this.tools = tools;
      this.skills = skills;
      this.updateError = undefined;
      this.ready();
      await old?.close().catch(() => {});
      this.packages.record(this.name, target, previous);
      this.packages.prune(this.name, [target, previous]);
    } catch (e) {
      this.updateError = (e as Error).message;
      this.onChange();
      throw e;
    } finally {
      this.updating = false;
      this.onChange();
    }
  }

  private async run(): Promise<void> {
    try {
      if (this.config.package && !this.launch) await this.install();
      if (this.stopped) return;
      this.set('starting');
      const { client, tools, skills } = await this.open(this.launch);
      if (this.stopped || this.client) return void (await client.close());
      this.client = client;
      this.tools = tools;
      this.skills = skills;
      this.backoff = MIN_BACKOFF;
      this.ready();
    } catch (e) {
      if (this.stopped || this.client) return;
      // Retrying cannot help until someone signs in from the web UI.
      if (e instanceof UnauthorizedError && this.auth?.signInUrl) this.needsSignIn();
      else this.scheduleRetry((e as Error).message);
    }
  }

  private async install(): Promise<void> {
    const spec = this.config.package!;
    if (!this.packages) throw new Error('no package manager configured');
    this.set('installing');
    const recorded = spec.version ? undefined : this.packages.recorded(this.name);
    const version = spec.version ?? recorded?.version ?? (await this.packages.latest(spec));
    this.launch = await this.packages.prepare(this.name, spec, version, this.config.allowScripts);
    this.version = version;
    // A pinned server never rolls back, so versions pinned earlier are dead weight.
    if (spec.version) this.packages.prune(this.name, [version]);
    if (!spec.version && !recorded) this.packages.record(this.name, version);
  }

  private async open(launch?: Launch): Promise<{ client: Client; tools: Tool[]; skills: Skill[] }> {
    const client = new Client(
      { name: 'mcpyard', version: VERSION },
      {
        listChanged: {
          tools: { onChanged: (error, tools) => this.client === client && this.toolsChanged(error, tools) },
          resources: { autoRefresh: false, onChanged: () => this.client === client && void this.skillsChanged(client) },
        },
      },
    );
    client.onclose = () => {
      if (this.client === client) this.scheduleRetry('connection closed');
    };
    try {
      await client.connect(this.transport(launch));
      return { client, tools: (await client.listTools()).tools, skills: await this.listSkills(client) };
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
  }

  private transport(launch?: Launch) {
    const c = this.config;
    if (c.url) {
      const url = new URL(c.url);
      if (c.oauth && !this.auth) throw new Error('no OAuth store configured');
      const options = { requestInit: { headers: c.headers }, authProvider: this.auth };
      return c.transport === 'sse' ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
    }
    const transport = new StdioClientTransport({
      command: launch?.command ?? c.command!,
      args: c.args,
      cwd: c.cwd,
      // Only PATH, HOME and the like, plus what the file declares: never the hub's own secrets.
      env: { ...getDefaultEnvironment(), ...c.env },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line.trim()) note(line, { server: this.name });
    });
    return transport;
  }

  private toolsChanged(error: Error | null, tools: Tool[] | null): void {
    if (error) return note(`tools refresh failed: ${error.message}`, { server: this.name, error: true });
    this.tools = tools ?? [];
    this.onChange();
  }

  /** A server whose skills cannot be listed still serves its tools. */
  private async listSkills(client: Client): Promise<Skill[]> {
    const skills = new SkillsClient(client, { skipInvalid: true });
    if (!skills.supported) return [];
    try {
      const listing = await skills.list();
      for (const bad of listing.invalid) note(`skill ${bad.uri ?? `#${bad.index}`} ignored: ${bad.reason}`, { server: this.name, error: true });
      return listing.skills;
    } catch (e) {
      note(`skills not listed: ${(e as Error).message}`, { server: this.name, error: true });
      return [];
    }
  }

  private async skillsChanged(client: Client): Promise<void> {
    const skills = await this.listSkills(client);
    if (this.client !== client) return;
    this.skills = skills;
    this.onChange();
  }

  private scheduleRetry(reason: string): void {
    this.client = undefined;
    this.set(this.wasReady ? 'degraded' : 'failed', reason);
    note(`${reason}, retrying in ${this.backoff / 1000}s`, { server: this.name, error: true });
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.run(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
  }

  private needsSignIn(): void {
    const client = this.client;
    this.client = undefined;
    clearTimeout(this.retry);
    note('sign-in required: open the server in the web UI', { server: this.name, error: true });
    this.set('failed', 'sign-in required');
    void client?.close().catch(() => {});
  }

  private ready(): void {
    this.wasReady = true;
    this.set('ready');
  }

  private set(state: State, error?: string): void {
    if (state !== this.state && !error) note(state, { server: this.name });
    this.state = state;
    this.lastError = error;
    if (state !== 'ready') {
      this.tools = [];
      this.skills = [];
    }
    this.onChange();
  }
}
