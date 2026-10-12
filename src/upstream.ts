import { Client, SSEClientTransport, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import type { ServerConfig } from './config.ts';
import type { Launch, Packages } from './packages.ts';

/** `degraded`: was ready, lost its connection, reconnecting. `failed`: never got ready, retrying. */
export type State = 'installing' | 'starting' | 'ready' | 'degraded' | 'stopped' | 'failed';

const MIN_BACKOFF = 1_000;
const MAX_BACKOFF = 5 * 60_000;

export class Upstream {
  state: State = 'stopped';
  tools: Tool[] = [];
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

  constructor(name: string, config: ServerConfig, onChange: () => void, packages?: Packages) {
    this.name = name;
    this.config = config;
    this.onChange = onChange;
    this.packages = packages;
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

  callTool(name: string, args: Record<string, unknown> | undefined) {
    if (!this.client || this.state !== 'ready') throw new Error(`server ${this.name} is not ready`);
    return this.client.callTool({ name, arguments: args });
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
      const { client, tools } = await this.open(launch);
      if (this.stopped) return void (await client.close());
      const old = this.client;
      const previous = this.version;
      clearTimeout(this.retry);
      this.backoff = MIN_BACKOFF;
      this.launch = launch;
      this.version = target;
      this.client = client;
      this.tools = tools;
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
      const { client, tools } = await this.open(this.launch);
      if (this.stopped || this.client) return void (await client.close());
      this.client = client;
      this.tools = tools;
      this.backoff = MIN_BACKOFF;
      this.ready();
    } catch (e) {
      if (!this.stopped && !this.client) this.scheduleRetry((e as Error).message);
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
    if (!spec.version && !recorded) this.packages.record(this.name, version);
  }

  private async open(launch?: Launch): Promise<{ client: Client; tools: Tool[] }> {
    const client = new Client(
      { name: 'mcpyard', version: '0.0.0' },
      {
        listChanged: {
          tools: { onChanged: (error, tools) => this.client === client && this.toolsChanged(error, tools) },
        },
      },
    );
    client.onclose = () => {
      if (this.client === client) this.scheduleRetry('connection closed');
    };
    try {
      await client.connect(this.transport(launch));
      return { client, tools: (await client.listTools()).tools };
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
  }

  private transport(launch?: Launch) {
    const c = this.config;
    if (c.url) {
      const url = new URL(c.url);
      const requestInit = { headers: c.headers };
      return c.transport === 'sse' ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit });
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
      for (const line of chunk.toString().split('\n')) if (line) process.stderr.write(`[${this.name}] ${line}\n`);
    });
    return transport;
  }

  private toolsChanged(error: Error | null, tools: Tool[] | null): void {
    if (error) return console.error(`[${this.name}] tools refresh failed: ${error.message}`);
    this.tools = tools ?? [];
    this.onChange();
  }

  private scheduleRetry(reason: string): void {
    this.client = undefined;
    this.set(this.wasReady ? 'degraded' : 'failed', reason);
    console.error(`[${this.name}] ${reason}, retrying in ${this.backoff / 1000}s`);
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.run(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
  }

  private ready(): void {
    this.wasReady = true;
    this.set('ready');
  }

  private set(state: State, error?: string): void {
    this.state = state;
    this.lastError = error;
    if (state !== 'ready') this.tools = [];
    this.onChange();
  }
}
