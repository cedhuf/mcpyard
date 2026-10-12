---
title: Admin endpoint
---

# Admin endpoint

`/admin/mcp` is a second MCP endpoint, separate from `/mcp`, for agents that watch and nurse the hub.
Only admin keys reach it, and admin keys reach nothing else.

## Connect

Create a key of kind **admin** in the web UI, then:

```bash
claude mcp add --transport http mcpyard-admin https://mcpyard.example.lan/admin/mcp \
  --header "Authorization: Bearer yard_..."
```

## Tools

| Tool | Does |
| --- | --- |
| `list_servers` | State, last error, tool count and package versions of every server. |
| `get_server` | One server in detail, with each tool and whether the configuration exposes it. |
| `restart_server` | Restarts a server, waits up to 30 seconds for it to settle, returns its status. |
| `update_server` | Updates a hub-owned package to a version, or the latest; pass the previous version to roll back. |
| `reload_config` | Re-reads the server file and applies it; returns the added, removed and restarted servers. |

A `list_servers` entry looks like this:

```json
{
  "name": "time",
  "source": { "pypi": "mcp-server-time" },
  "enabled": true,
  "state": "ready",
  "tools": 2,
  "package": { "pinned": false, "installed": "2026.8.18", "latest": { "version": "2026.10.10", "checkedAt": "2026-10-12T09:00:00.000Z" }, "updating": false }
}
```

States are `installing`, `starting`, `ready`, `degraded` (was ready, reconnecting), `failed` (never got
ready, retrying) and `stopped`.

## Updates from an agent

`update_server` runs the same flow as the **Update** button: the new version installs into its own
directory, starts next to the running one, and takes over only once it answers. The call returns when
the switch is done, which can take a few minutes for a first install. If anything fails, the running
version keeps serving and the tool returns the error. Pinned servers refuse updates: change their
version in the file and reload instead.

## Scoping an admin key

The same scope rules apply as for client keys:

- `scope.servers` limits the servers the key sees and restarts.
- `scope.tools` filters the tool names. `{ "allow": ["list_servers", "get_server"] }` gives a
  read-only key, handy for monitoring.
- `reload_config` is offered only to keys that manage every server, since a reload can touch any of
  them.

Calls appear in the audit log with the tool prefixed by `admin:`.
