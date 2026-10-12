import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Hub } from './front.ts';
import { allowed, type Key } from './keys.ts';

const SETTLE_MS = 30_000;

/**
 * The management endpoint for admin keys. `scope.servers` limits which servers a key manages and `scope.tools`
 * filters these tool names, so `{ allow: ["list_servers", "get_server"] }` makes a read-only key. Only keys that
 * manage every server may reload the configuration, since a reload can touch any of them.
 */
export function adminServer(hub: Hub, key: Key, audit: (tool: string, ok: boolean, ms: number) => void): McpServer {
  const server = new McpServer({ name: 'mcpyard-admin', version: '0.0.0' });
  const manages = (name: string) => hub.upstreams.has(name) && (key.scope.servers.includes('*') || key.scope.servers.includes(name));
  const name = z.object({ name: z.string().describe('Server name, as in the configuration file') });

  const call =
    <A>(id: string, run: (args: A) => Promise<unknown> | unknown) =>
    async (args: A): Promise<CallToolResult> => {
      const started = Date.now();
      try {
        const result = await run(args);
        audit(id, true, Date.now() - started);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        audit(id, false, Date.now() - started);
        return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
      }
    };
  const exposed = (id: string) => allowed(id, key.scope.tools);

  const status = (server: string, withTools: boolean) => {
    if (!manages(server)) throw new Error(`unknown server ${server}`);
    const upstream = hub.upstreams.get(server)!;
    const config = hub.configs[server]!;
    return {
      name: server,
      source: config.package ? { ...config.package } : config.url ? { url: config.url } : { command: config.command },
      enabled: config.enabled,
      state: upstream.state,
      error: upstream.lastError,
      tools: withTools ? upstream.tools.map((t) => ({ name: `${server}-${t.name}`, exposed: allowed(t.name, config.tools) })) : upstream.tools.length,
      package: hub.packageStatus()[server],
    };
  };

  if (exposed('list_servers')) {
    server.registerTool(
      'list_servers',
      { description: 'State, error, tool count and package versions of every server.', annotations: { readOnlyHint: true } },
      call('list_servers', () => [...hub.upstreams.keys()].filter(manages).map((s) => status(s, false))),
    );
  }

  if (exposed('get_server')) {
    server.registerTool(
      'get_server',
      { description: 'One server in detail, with its tool names and whether the configuration exposes them.', inputSchema: name, annotations: { readOnlyHint: true } },
      call('get_server', ({ name }: { name: string }) => status(name, true)),
    );
  }

  if (exposed('restart_server')) {
    server.registerTool(
      'restart_server',
      { description: 'Restart a server and wait up to 30 seconds for it to settle; returns its status.', inputSchema: name, annotations: { readOnlyHint: false } },
      call('restart_server', async ({ name }: { name: string }) => {
        if (!manages(name)) throw new Error(`unknown server ${name}`);
        await hub.restart(name);
        const deadline = Date.now() + SETTLE_MS;
        while (['installing', 'starting'].includes(hub.upstreams.get(name)!.state) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
        return status(name, false);
      }),
    );
  }

  if (exposed('update_server')) {
    server.registerTool(
      'update_server',
      {
        description:
          'Update a package server whose version the hub owns (not pinned) to `version`, or to the latest known version. ' +
          'The new version starts next to the running one and takes over only once it answers; on failure the old one keeps ' +
          'serving and the error is returned. Pass the previous version to roll back. Installing can take a few minutes.',
        inputSchema: z.object({ name: z.string().describe('Server name'), version: z.string().optional().describe('Version to install; omit for the latest') }),
        annotations: { readOnlyHint: false },
      },
      call('update_server', async ({ name, version }: { name: string; version?: string }) => {
        if (!manages(name)) throw new Error(`unknown server ${name}`);
        await hub.update(name, version);
        return status(name, false);
      }),
    );
  }

  if (exposed('reload_config') && key.scope.servers.includes('*')) {
    server.registerTool(
      'reload_config',
      {
        description: 'Re-read the server file: start new servers, stop removed ones, restart changed ones. Lists what changed.',
        annotations: { readOnlyHint: false },
      },
      call('reload_config', () => hub.reload()),
    );
  }

  return server;
}
