import { Client, SSEClientTransport, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import type { ServerConfig } from './config.ts';

export type State = 'starting' | 'ready' | 'failed' | 'stopped';

const MIN_BACKOFF = 1_000;
const MAX_BACKOFF = 5 * 60_000;

export class Upstream {
  state: State = 'stopped';
  tools: Tool[] = [];
  lastError?: string;
  private client?: Client;
  private backoff = MIN_BACKOFF;
  private retry?: NodeJS.Timeout;
  private readonly name: string;
  private readonly config: ServerConfig;
  private readonly onChange: () => void;

  constructor(name: string, config: ServerConfig, onChange: () => void) {
    this.name = name;
    this.config = config;
    this.onChange = onChange;
  }

  start(): void {
    if (!this.config.enabled) return;
    if (this.config.package) return this.set('failed', 'managed packages are not implemented yet');
    void this.connect();
  }

  async stop(): Promise<void> {
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

  private async connect(): Promise<void> {
    this.set('starting');
    const client = new Client(
      { name: 'mcpyard', version: '0.0.0' },
      { listChanged: { tools: { onChanged: (error, tools) => this.toolsChanged(error, tools) } } },
    );
    client.onclose = () => {
      if (this.client === client) this.scheduleRetry('connection closed');
    };
    this.client = client;
    try {
      await client.connect(this.transport());
      this.tools = (await client.listTools()).tools;
      this.backoff = MIN_BACKOFF;
      this.set('ready');
    } catch (e) {
      if (this.client === client) this.scheduleRetry((e as Error).message);
      await client.close().catch(() => {});
    }
  }

  private transport() {
    const c = this.config;
    if (c.url) {
      const url = new URL(c.url);
      const requestInit = { headers: c.headers };
      return c.transport === 'sse' ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit });
    }
    const transport = new StdioClientTransport({
      command: c.command!,
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
    this.set('failed', reason);
    console.error(`[${this.name}] ${reason}, retrying in ${this.backoff / 1000}s`);
    this.retry = setTimeout(() => void this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
  }

  private set(state: State, error?: string): void {
    this.state = state;
    this.lastError = error;
    if (state !== 'ready') this.tools = [];
    this.onChange();
  }
}
