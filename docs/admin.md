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

## Scoping an admin key

The same scope rules apply as for client keys:

- `scope.servers` limits the servers the key sees and restarts.
- `scope.tools` filters the three tool names. `{ "deny": ["restart_server"] }` gives a read-only key,
  handy for monitoring.

Calls appear in the audit log with the tool prefixed by `admin:`.
