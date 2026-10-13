import type { Tool } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Hub } from './front.ts';
import { allowed, keySees, type Key } from './keys.ts';

/** The hub's own tools, served in /mcp as the `yard` server to keys that list it explicitly. */
export const YARD = 'yard';

const SETTLE_MS = 30_000;

type YardTool = { tool: Tool; schema: z.ZodObject; run: (hub: Hub, key: Key, args: Record<string, string>) => Promise<unknown> | unknown };

const name = z.object({ name: z.string().describe('Server name, as in the configuration file') });

/** An admin key manages the servers it reaches, or every server when it reaches none: a pure supervision key. */
function manages(hub: Hub, key: Key, server: string): boolean {
  if (!hub.upstreams.has(server)) return false;
  return key.scope.servers.every((s) => s === YARD) || keySees(key, server);
}

function status(hub: Hub, key: Key, server: string, withTools: boolean) {
  if (!manages(hub, key, server)) throw new Error(`unknown server ${server}`);
  const upstream = hub.upstreams.get(server)!;
  const config = hub.configs[server]!;
  return {
    name: server,
    source: config.package ? { ...config.package } : config.url ? { url: config.url } : { command: config.command },
    enabled: config.enabled && !hub.isDisabled(server),
    switchedOff: hub.isDisabled(server),
    state: upstream.state,
    error: upstream.lastError,
    tools: withTools ? upstream.tools.map((t) => ({ name: `${server}-${t.name}`, exposed: allowed(t.name, config.tools) })) : upstream.tools.length,
    package: hub.packageStatus()[server],
  };
}

async function settle(hub: Hub, server: string): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  while (['installing', 'starting'].includes(hub.upstreams.get(server)!.state) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
}

function define(id: string, description: string, schema: z.ZodObject, readOnly: boolean, run: YardTool['run']): YardTool {
  const inputSchema = z.toJSONSchema(schema) as Tool['inputSchema'];
  return { tool: { name: id, description, inputSchema, annotations: { readOnlyHint: readOnly } }, schema, run };
}

export const YARD_TOOLS: YardTool[] = [
  define('list_servers', 'State, error, tool count and package versions of every server.', z.object({}), true, (hub, key) =>
    [...hub.upstreams.keys()].filter((s) => manages(hub, key, s)).map((s) => status(hub, key, s, false)),
  ),
  define('get_server', 'One server in detail, with its tool names and whether the configuration exposes them.', name, true, (hub, key, { name }) =>
    status(hub, key, name!, true),
  ),
  define('restart_server', 'Restart a server and wait up to 30 seconds for it to settle; returns its status.', name, false, async (hub, key, { name }) => {
    if (!manages(hub, key, name!)) throw new Error(`unknown server ${name}`);
    await hub.restart(name!);
    await settle(hub, name!);
    return status(hub, key, name!, false);
  }),
  define(
    'update_server',
    'Update a package server whose version the hub owns (not pinned) to `version`, or to the latest known version. ' +
      'The new version starts next to the running one and takes over only once it answers; on failure the old one keeps ' +
      'serving and the error is returned. Pass the previous version to roll back. Installing can take a few minutes.',
    z.object({ name: z.string().describe('Server name'), version: z.string().optional().describe('Version to install; omit for the latest') }),
    false,
    async (hub, key, { name, version }) => {
      if (!manages(hub, key, name!)) throw new Error(`unknown server ${name}`);
      await hub.update(name!, version);
      return status(hub, key, name!, false);
    },
  ),
  ...(['enable', 'disable'] as const).map((action) =>
    define(
      `${action}_server`,
      action === 'disable'
        ? 'Switch a server off: stop it and hide its tools from every key, without touching the server file. Kept across restarts.'
        : 'Switch a server back on after disable_server, and wait up to 30 seconds for it to settle; returns its status.',
      name,
      false,
      async (hub, key, { name }) => {
        if (!manages(hub, key, name!)) throw new Error(`unknown server ${name}`);
        if (action === 'enable' && !hub.configs[name!]!.enabled) throw new Error(`${name} has enabled: false in the server file`);
        await hub.setDisabled(name!, action === 'disable');
        await settle(hub, name!);
        return status(hub, key, name!, false);
      },
    ),
  ),
  define('reload_config', 'Re-read the server file: start new servers, stop removed ones, restart changed ones. Lists what changed.', z.object({}), false, (hub, key) => {
    if (!key.scope.servers.every((s) => s === YARD || s === '*')) throw new Error('reload_config needs a key that manages every server');
    return hub.reload();
  }),
];
