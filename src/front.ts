import { Server, createMcpHandler, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import type { ServerConfig } from './config.ts';
import { allowed, findKey, keySees, loadKeys, type Key } from './keys.ts';
import type { LatestStatus, Packages } from './packages.ts';
import { Upstream } from './upstream.ts';

const CLIENT_PREFIX = 'mcp__mcpyard__';
const MAX_TOOL_NAME = 64;

type Route = { server: string; tool: Tool };

export type PackageStatus = { pinned: boolean; installed?: string; latest?: LatestStatus; updateError?: string };

export class Hub {
  readonly upstreams = new Map<string, Upstream>();
  private routes = new Map<string, Route>();
  private warned = new Set<string>();
  private readonly configs: Record<string, ServerConfig>;
  private readonly packages?: Packages;
  readonly handler = createMcpHandler(({ authInfo }) => this.mcpServer(authInfo?.extra?.key as Key));

  constructor(configs: Record<string, ServerConfig>, packages?: Packages) {
    this.configs = configs;
    this.packages = packages;
    for (const [name, config] of Object.entries(configs)) {
      this.upstreams.set(name, new Upstream(name, config, () => this.rebuild(), packages));
    }
  }

  start(): void {
    this.packages?.watch(Object.values(this.configs).flatMap((c) => (c.enabled && c.package ? [c.package] : [])));
    for (const upstream of this.upstreams.values()) upstream.start();
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
        latest: this.packages?.latestStatus(config.package),
        updateError: upstream.updateError,
      };
    }
    return status;
  }

  async update(server: string, version?: string): Promise<void> {
    const upstream = this.upstreams.get(server);
    if (!upstream) throw new Error(`unknown server ${server}`);
    return upstream.update(version);
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
    console.error(message);
  }

  private mcpServer(key: Key): Server {
    const server = new Server({ name: 'mcpyard', version: '0.0.0' }, { capabilities: { tools: { listChanged: true } } });

    server.setRequestHandler('tools/list', () => ({
      tools: [...this.routes]
        .filter(([exposed, route]) => keySees(key, route.server, exposed))
        .map(([exposed, route]) => ({ ...route.tool, name: exposed })),
    }));

    server.setRequestHandler('tools/call', async (request) => {
      const exposed = request.params.name;
      const route = this.routes.get(exposed);
      if (!route || !keySees(key, route.server, exposed)) throw new Error(`unknown tool ${exposed}`);
      const started = Date.now();
      let result: CallToolResult;
      try {
        result = (await this.upstreams.get(route.server)!.callTool(route.tool.name, request.params.arguments)) as CallToolResult;
      } catch (e) {
        result = { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
      }
      audit(key, exposed, !result.isError, Date.now() - started);
      return result;
    });

    return server;
  }
}

function audit(key: Key, tool: string, ok: boolean, ms: number): void {
  console.log(JSON.stringify({ event: 'tool_call', time: new Date().toISOString(), key: key.name, tool, ok, ms }));
}

export function app(hub: Hub, keysPath: string): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.text('ok'));
  app.all('/mcp', async (c) => {
    const token = c.req.header('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    const key = findKey(loadKeys(keysPath), token);
    if (!key || key.kind !== 'client') return c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Bearer' });
    return hub.handler.fetch(c.req.raw, { authInfo: { token: token!, clientId: key.id, scopes: [], extra: { key } } });
  });
  return app;
}
