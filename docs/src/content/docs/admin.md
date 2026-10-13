---
title: Hub administration
---

MCP Yard has tools of its own, to watch and nurse the hub from an agent. They are served in `/mcp`
like any server's tools, as the `yard` server, but only to keys that are explicitly allowed to
administer the hub.

## Allowing a key

Open the key in the web UI and switch on **Hub administration**. The key then sees the `yard-*` tools
next to its servers' tools, on the same connection. Behind the switch, the key's servers simply include
`yard`; the `*` of "all servers" never does, so no key administers the hub by accident.

| The key should... | Servers | Hub administration |
| --- | --- | --- |
| use tools only | its servers, or all | off |
| use tools and manage the hub | its servers, or all | on |
| only watch and manage the hub | none | on |

A key manages the servers it reaches. A key that reaches no server is a pure supervision key: it sees
no server tools and manages every server.

> An assistant that reads mail or web pages could be talked into calling tools it has. The yard tools
> can restart servers and install package versions, so allow administration only where it is needed.

## Tools

| Tool | Does |
| --- | --- |
| `yard-overview` | The dashboard in one call: servers healthy or needing care, tools, calls of the last 24 hours, updates ready, the last health check; plus the keys and the security check for a key that manages every server. |
| `yard-read_logs` | The logs, newest first: MCP calls, web UI actions, servers output and errors, filtered by kind, server and text. |
| `yard-list_servers` | State, last error, tool count and package versions of every managed server. |
| `yard-get_server` | One server in detail, with each tool and whether the configuration exposes it. |
| `yard-restart_server` | Restarts a server, waits up to 30 seconds for it to settle, returns its status. |
| `yard-disable_server` | Switches a server off, like the switch in the web UI: stopped, tools hidden, kept across restarts. |
| `yard-enable_server` | Switches it back on and waits up to 30 seconds for it to settle. |
| `yard-health_check` | Pings every managed server over MCP; returns who answers, how fast, or the error. |
| `yard-check_updates` | Asks the registries now; returns the managed servers with an update ready. |
| `yard-update_all` | Updates every managed hub-owned package that has a newer version. |
| `yard-update_server` | Updates a hub-owned package to a version, or the latest; pass the previous version to roll back. |
| `yard-set_title` | Sets or removes the title the web UI shows for a server, in the server file. Tool names do not change. |
| `yard-reload_config` | Re-reads the server file and applies it; returns the added, removed and restarted servers. |

A key that manages only some servers sees only their lines in `yard-read_logs` and their figures in
`yard-overview`; the keys, the security check and the hub's own lines are for keys that manage
every server. Keys are listed with their name, prefix, scope and last use, never their token or
hash.

A `yard-list_servers` entry looks like this:

```json
{
  "name": "time",
  "source": { "pypi": "mcp-server-time" },
  "enabled": true,
  "switchedOff": false,
  "state": "ready",
  "tools": 2,
  "package": { "pinned": false, "installed": "2026.8.18", "latest": { "version": "2026.10.10", "checkedAt": "2026-10-12T09:00:00.000Z" }, "updating": false }
}
```

States are `installing`, `starting`, `ready`, `degraded` (was ready, reconnecting), `failed` (never got
ready, retrying) and `stopped`. `enabled` is false when the server file disables the server or when it
is switched off; `switchedOff` tells the second case apart.

## Updates from an agent

`yard-update_server` runs the same flow as the **Update** button: the new version installs into its
own directory, starts next to the running one, and takes over only once it answers. The call returns
when the switch is done, which can take a few minutes for a first install. If anything fails, the
running version keeps serving and the tool returns the error. Pinned servers refuse updates: change
their version in the file and reload instead.

## Narrowing an admin key

The key's tool filter applies to the yard tools like to any other:

- `{ "allow": ["yard-list_*", "yard-get_*"] }` with no servers gives a read-only monitoring key.
- `{ "deny": ["yard-update_*"] }` keeps everything but package updates, one by one or all at once.
- `{ "deny": ["yard-enable_*", "yard-disable_*"] }` keeps the server switches in the web UI only.
- `yard-reload_config` works only for keys that manage every server, since a reload can touch any of
  them.

## Turning it off

**Settings → Hub administration**, or `MCPYARD_ADMIN_TOOLS=false`, removes the yard tools from every
key at once. Connected clients are told their tool list changed.

Calls appear in the audit log like any tool call, with their `yard-` name.
