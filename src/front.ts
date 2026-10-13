import { Server, createMcpHandler, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import type { ServerConfig } from './config.ts';
import { allowed, findKey, keySees, loadKeys, saveKeys, type Key } from './keys.ts';
import { event, note } from './logs.ts';
import { YARD, YARD_TOOLS } from './yard.ts';
import type { LatestStatus, Packages } from './packages.ts';
import { Upstream } from './upstream.ts';
import { VERSION } from './release.ts';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const CLIENT_PREFIX = 'mcp__mcpyard__';
const MAX_TOOL_NAME = 64;

type Route = { server: string; tool: Tool };

export type PackageStatus = {
  pinned: boolean;
  installed?: string;
  previous?: string;
  latest?: LatestStatus;
  updating: boolean;
  updateError?: string;
};

export type ReloadResult = { added: string[]; removed: string[]; changed: string[] };

export class Hub {
  readonly upstreams = new Map<string, Upstream>();
  private routes = new Map<string, Route>();
  private warned = new Set<string>();
  configs: Record<string, ServerConfig>;
  private readonly packages?: Packages;
  private readonly load?: () => Record<string, ServerConfig>;
  readonly handler = createMcpHandler(({ authInfo }) => this.mcpServer(authInfo?.extra?.key as Key));
  /** Whether the hub's own `yard-*` tools are offered at all; keys must still list `yard`. */
  yardEnabled: () => boolean = () => true;

  /** `load` re-reads the server file for `reload()`. */
  constructor(configs: Record<string, ServerConfig>, packages?: Packages, load?: () => Record<string, ServerConfig>) {
    this.configs = configs;
    this.packages = packages;
    this.load = load;
    for (const [name, config] of Object.entries(configs)) this.upstreams.set(name, this.newUpstream(name, config));
  }

  start(): void {
    this.watchPackages();
    for (const upstream of this.upstreams.values()) upstream.start();
  }

  /**
   * Re-reads the server file and applies the difference: new servers start, removed ones stop, changed ones restart
   * with their new settings. Untouched servers keep running. A file that does not parse changes nothing.
   */
  async reload(): Promise<ReloadResult> {
    if (!this.load) throw new Error('no configuration file to reload');
    const next = this.load();
    const removed = Object.keys(this.configs).filter((name) => !next[name]);
    const added = Object.keys(next).filter((name) => !this.configs[name]);
    const changed = Object.keys(next).filter((name) => this.configs[name] && JSON.stringify(this.configs[name]) !== JSON.stringify(next[name]));
    const stopping = [...removed, ...changed].map((name) => this.upstreams.get(name)!);
    for (const name of removed) this.upstreams.delete(name);
    this.configs = next;
    for (const name of [...changed, ...added]) this.upstreams.set(name, this.newUpstream(name, next[name]!));
    await Promise.all(stopping.map((u) => u.stop()));
    for (const name of [...changed, ...added]) this.upstreams.get(name)!.start();
    this.packages?.unwatch();
    this.watchPackages();
    this.rebuild();
    return { added, removed, changed };
  }

  private newUpstream(name: string, config: ServerConfig): Upstream {
    const enabled = config.enabled && !this.disabled.has(name);
    return new Upstream(name, { ...config, enabled }, () => this.rebuild(), this.packages);
  }

  /** Servers switched off from the UI: state kept in the data directory, on top of what the server file says. */
  private disabled = new Set<string>();
  private statePath?: string;

  useState(path: string): void {
    this.statePath = path;
    try {
      this.disabled = new Set((JSON.parse(readFileSync(path, 'utf8')) as { disabled?: string[] }).disabled ?? []);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    // Called before start(): replacing the upstreams of disabled servers is enough.
    for (const name of this.upstreams.keys()) if (this.disabled.has(name)) this.upstreams.set(name, this.newUpstream(name, this.configs[name]!));
  }

  isDisabled(name: string): boolean {
    return this.disabled.has(name);
  }

  /** Switches a server on or off without touching the server file, and restarts or stops it at once. */
  async setDisabled(name: string, disabled: boolean): Promise<void> {
    const config = this.configs[name];
    if (!config) throw new Error(`unknown server ${name}`);
    if (disabled === this.disabled.has(name)) return;
    if (disabled) this.disabled.add(name);
    else this.disabled.delete(name);
    if (this.statePath) {
      writeFileSync(`${this.statePath}.tmp`, `${JSON.stringify({ disabled: [...this.disabled].sort() }, null, 2)}\n`);
      renameSync(`${this.statePath}.tmp`, this.statePath);
    }
    const old = this.upstreams.get(name)!;
    this.upstreams.set(name, this.newUpstream(name, config));
    await old.stop();
    this.upstreams.get(name)!.start();
    this.rebuild();
  }

  /** Tells connected clients to list their tools again, after something outside the upstreams changed them. */
  notifyToolsChanged(): void {
    this.handler.notify.toolsChanged();
  }

  /** Applies a new check period without a restart. */
  restartVersionChecks(): void {
    this.packages?.unwatch();
    this.watchPackages();
  }

  private watchPackages(): void {
    this.packages?.watch(Object.values(this.configs).flatMap((c) => (c.enabled && c.package ? [c.package] : [])));
  }

  /** Installed and latest version of every package server, for the UI. */
  packageStatus(): Record<string, PackageStatus> {
    const status: Record<string, PackageStatus> = {};
    for (const [name, config] of Object.entries(this.configs)) {
      if (!config.package) continue;
      const upstream = this.upstreams.get(name)!;
      status[name] = {
        pinned: !!config.package.version,
        installed: upstream.version,
        previous: config.package.version ? undefined : this.packages?.recorded(name)?.previous,
        latest: this.packages?.latestStatus(config.package),
        updating: upstream.updating,
        updateError: upstream.updateError,
      };
    }
    return status;
  }

  async update(server: string, version?: string): Promise<void> {
    return this.upstream(server).update(version);
  }

  async restart(server: string): Promise<void> {
    return this.upstream(server).restart();
  }

  private upstream(server: string): Upstream {
    const upstream = this.upstreams.get(server);
    if (!upstream) throw new Error(`unknown server ${server}`);
    return upstream;
  }

  async stop(): Promise<void> {
    this.packages?.unwatch();
    await Promise.all([...this.upstreams.values()].map((u) => u.stop()));
    await this.handler.close();
  }

  /** Exposed name to (server, tool). Routing goes through this table and never splits a name. */
  private rebuild(): void {
    const routes = new Map<string, Route>();
    for (const [server, upstream] of this.upstreams) {
      for (const tool of upstream.tools) {
        if (!allowed(tool.name, this.configs[server]!.tools)) continue;
        const exposed = `${server}-${tool.name}`;
        const clash = routes.get(exposed);
        if (clash) {
          this.warnOnce(`clash:${exposed}`, `tool ${exposed} from ${server} clashes with ${clash.server}-${clash.tool.name}, ignored`);
          continue;
        }
        if (CLIENT_PREFIX.length + exposed.length > MAX_TOOL_NAME) {
          this.warnOnce(`long:${exposed}`, `tool ${exposed} exceeds ${MAX_TOOL_NAME} characters once prefixed, Claude Code will reject it`);
        }
        routes.set(exposed, { server, tool });
      }
    }
    this.routes = routes;
    this.handler.notify.toolsChanged();
  }

  private warnOnce(id: string, message: string): void {
    if (this.warned.has(id)) return;
    this.warned.add(id);
    note(message, { error: true });
  }

  private mcpServer(key: Key): Server {
    const server = new Server({ name: 'mcpyard', version: VERSION }, { capabilities: { tools: { listChanged: true } } });

    const yardTools = () => (this.yardEnabled() ? YARD_TOOLS.filter((t) => keySees(key, YARD, `${YARD}-${t.tool.name}`)) : []);

    server.setRequestHandler('tools/list', () => ({
      tools: [
        ...[...this.routes].filter(([exposed, route]) => keySees(key, route.server, exposed)).map(([exposed, route]) => ({ ...route.tool, name: exposed })),
        ...yardTools().map((t) => ({ ...t.tool, name: `${YARD}-${t.tool.name}` })),
      ],
    }));

    server.setRequestHandler('tools/call', async (request) => {
      const exposed = request.params.name;
      const yard = yardTools().find((t) => `${YARD}-${t.tool.name}` === exposed);
      if (yard) {
        const started = Date.now();
        let result: CallToolResult;
        try {
          const args = yard.schema.parse(request.params.arguments ?? {}) as Record<string, string>;
          result = { content: [{ type: 'text', text: JSON.stringify(await yard.run(this, key, args), null, 2) }] };
        } catch (e) {
          result = { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
        }
        audit(key, YARD, exposed, result, Date.now() - started);
        return result;
      }
      const route = this.routes.get(exposed);
      if (!route || !keySees(key, route.server, exposed)) throw new Error(`unknown tool ${exposed}`);
      const started = Date.now();
      let result: CallToolResult;
      try {
        result = (await this.upstreams.get(route.server)!.callTool(route.tool.name, request.params.arguments)) as CallToolResult;
      } catch (e) {
        result = { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
      }
      audit(key, route.server, exposed, result, Date.now() - started);
      return result;
    });

    return server;
  }
}

function audit(key: Key, server: string, tool: string, result: CallToolResult, ms: number): void {
  const text = result.isError ? result.content.find((c) => c.type === 'text')?.text : undefined;
  event('tool_call', { key: key.name, server, tool, ok: !result.isError, ms, error: text?.slice(0, 300) });
}

const TOUCH_EVERY_MS = 3_600_000;

/** Records `lastUsed`, at most once an hour per key so a busy client does not rewrite the file on every call. */
function touch(keysPath: string, key: Key): void {
  if (key.lastUsed && Date.now() - Date.parse(key.lastUsed) < TOUCH_EVERY_MS) return;
  const keys = loadKeys(keysPath);
  const stored = keys.find((k) => k.id === key.id);
  if (!stored) return;
  stored.lastUsed = new Date().toISOString();
  saveKeys(keysPath, keys);
}

export function app(hub: Hub, keysPath: string, webUi?: Hono<any>): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.text('ok'));
  app.all('/mcp', async (c) => {
    const token = c.req.header('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    const key = findKey(loadKeys(keysPath), token);
    if (!key) return c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Bearer' });
    touch(keysPath, key);
    return hub.handler.fetch(c.req.raw, { authInfo: { token: token!, clientId: key.id, scopes: [], extra: { key } } });
  });
  if (webUi) app.route('/', webUi);
  return app;
}
