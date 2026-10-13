import type { Tool } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { newerVersion, type Hub } from './front.ts';
import { overview } from './insights.ts';
import { allowed, isAdmin, keySees, loadKeys, type Key } from './keys.ts';
import { logs, type LogEntry } from './logs.ts';

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

function managesAll(hub: Hub, key: Key): boolean {
  return [...hub.upstreams.keys()].every((s) => manages(hub, key, s));
}

function status(hub: Hub, key: Key, server: string, withTools: boolean) {
  if (!manages(hub, key, server)) throw new Error(`unknown server ${server}`);
  const upstream = hub.upstreams.get(server)!;
  const config = hub.configs[server]!;
  return {
    name: server,
    ...(config.title ? { title: config.title } : {}),
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
  define(
    'set_title',
    'Set the title the web UI shows for a server, or remove it with an empty title. Tool names keep the server name. Writes the server file.',
    z.object({ name: z.string().describe('Server name'), title: z.string().describe('Title to show; empty to remove it') }),
    false,
    async (hub, key, { name, title }) => {
      if (!manages(hub, key, name!)) throw new Error(`unknown server ${name}`);
      const file = hub.configFile;
      const reason = file ? file.readOnlyReason() : 'there is no server file';
      if (reason) throw new Error(`cannot edit the server file: ${reason}`);
      const { title: _, ...rest } = file!.raw(name!)!;
      file!.save(name!, title!.trim() ? { title: title!.trim(), ...rest } : rest);
      await hub.reload();
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
  define('health_check', 'Ping every running server the key manages over MCP; returns who answers, in how many milliseconds, or the error.', z.object({}), true, async (hub, key) => {
    const all = managesAll(hub, key);
    const report = await hub.healthCheck(all ? undefined : (s) => manages(hub, key, s));
    return report.results;
  }),
  define('check_updates', 'Ask the package registries now for the latest version of every package server, instead of waiting for the periodic check; returns the servers with an update ready.', z.object({}), true, async (hub, key) => {
    await hub.checkUpdates();
    return Object.entries(hub.packageStatus())
      .filter(([name, pkg]) => manages(hub, key, name) && newerVersion(pkg))
      .map(([name, pkg]) => ({ name, installed: pkg.installed, latest: pkg.latest?.version }));
  }),
  define(
    'update_all',
    'Update every hub-owned package the key manages that has a newer version. Each new version starts next to the running one and takes over once it answers. Returns the servers being updated; follow them with list_servers.',
    z.object({}),
    false,
    (hub, key) => ({ updating: hub.updateAll((s) => manages(hub, key, s)) }),
  ),
  define(
    'overview',
    "The dashboard in one call: servers healthy, needing care or switched off, tools exposed, MCP calls of the last 24 hours, updates ready and the last health check. Keys that manage every server also get the keys (never their tokens) and the security check.",
    z.object({}),
    true,
    (hub, key) => {
      const all = managesAll(hub, key);
      const keys = hub.keysPath ? loadKeys(hub.keysPath) : [];
      return {
        ...overview(hub, keys, (s) => manages(hub, key, s)),
        ...(all
          ? {
              keyList: keys.map((k) => ({ name: k.name, prefix: k.prefix, enabled: k.enabled, admin: isAdmin(k), servers: k.scope.servers.filter((s) => s !== YARD), tools: k.scope.tools, created: k.created, lastUsed: k.lastUsed })),
              security: hub.security?.() ?? null,
            }
          : {}),
      };
    },
  ),
  define(
    'read_logs',
    'Read the hub logs, newest first: MCP calls (key, tool, duration, error), actions from the web UI, servers output and errors. Filter by kind, server and text. Keys that manage only some servers see only their lines.',
    z.object({
      kind: z.enum(['all', 'calls', 'actions', 'output', 'errors']).optional().describe('Which lines; all by default'),
      server: z.string().optional().describe('Only the lines of this server'),
      contains: z.string().optional().describe('Only lines whose tool, key, server or message contains this text'),
      limit: z.number().int().min(1).max(500).optional().describe('How many lines, 50 by default'),
    }),
    true,
    (hub, key, args) => {
      const { kind = 'all', server, contains, limit = 50 } = args as unknown as { kind?: string; server?: string; contains?: string; limit?: number };
      const all = managesAll(hub, key);
      const needle = contains?.toLowerCase();
      const match: Record<string, (e: LogEntry) => boolean> = {
        all: () => true,
        calls: (e) => e.kind === 'call',
        actions: (e) => e.kind === 'action',
        output: (e) => e.kind === 'server' || e.kind === 'hub',
        errors: (e) => e.error,
      };
      return logs
        .list()
        .filter((e) => (e.server ? manages(hub, key, e.server) || (all && !hub.upstreams.has(e.server)) : all))
        .filter((e) => match[kind]!(e) && (!server || e.server === server))
        .filter((e) => !needle || [e.text, e.server, ...Object.values(e.fields ?? {}).map(String)].some((v) => v?.toLowerCase().includes(needle)))
        .slice(0, limit)
        .map(({ time, kind: k, error, server: s, text, fields }) => ({ time, kind: k, error, server: s, text, ...(fields ? { fields } : {}) }));
    },
  ),
  define('reload_config', 'Re-read the server file: start new servers, stop removed ones, restart changed ones. Lists what changed.', z.object({}), false, (hub, key) => {
    if (!key.scope.servers.every((s) => s === YARD || s === '*')) throw new Error('reload_config needs a key that manages every server');
    return hub.reload();
  }),
];
