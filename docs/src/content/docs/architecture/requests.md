---
title: Requests and keys
description: The /mcp endpoint, routing, audit events, key scopes and the admin tools.
sidebar:
  order: 4
---

`/mcp` serves Streamable HTTP through the official SDK. Every request carries a bearer key; the
hub builds an MCP server view for that key.

**Names.** A tool is exposed as `<server>-<tool>`. Routing goes through a table from exposed name
to `(server, tool)`, never by splitting the name, so hyphens inside names are safe. When two pairs
produce the same exposed name, the first wins and the hub logs a warning. Claude Code rejects tool
names over 64 characters once it adds its `mcp__<client name>__` prefix, so the hub warns about
any name that would cross that line.

**Listing and calling.** `tools/list` returns the routed tools the key may see, plus the `yard-*`
tools it may use. `tools/call` checks the same rule again, so a call to a tool the key cannot see
is refused as unknown. The upstream result is returned unchanged; an upstream error becomes an
`isError` result rather than a protocol error.

**Audit.** Every call emits a `tool_call` event: key name, server, tool, success, duration and the
start of the error text, never the arguments.

## Keys and scopes

Keys live in `keys.json`, written with mode `0600`. A token looks like `yard_<id>_<secret>`. The id
selects the key; only the SHA-256 of the whole token is stored, and the comparison is
constant-time. The token is shown once, at creation.

A key's scope has two parts:

- `servers`: names, or `*` for every server. The hub's own tools form a server named `yard`, which
  `*` never includes: administration is always an explicit grant.
- `tools`: `allow` and `deny` globs on exposed names (`mail-*`, `*-delete_*`).

The server file's own `tools` filter applies to every key first; a key can only narrow it.
`lastUsed` is written at most once an hour per key, so a busy client does not rewrite the file on
every call.

## Admin tools

The `yard-*` tools let an agent supervise the hub: read state, versions, logs and the dashboard
figures, run a health check, restart or switch a server, update hub-owned packages, set a display
title, reload the server file.

They stop short of how a server is launched: package, command, URL, environment, headers and tool
filters change only in the server file or the web UI. Those fields decide what code runs on the
host and with which secrets; a prompt injection that reached a tool able to change them would be a
host compromise.

A key that manages only some servers sees only those servers in every admin tool, including the
logs and the dashboard figures. Keys, the security check and the hub's own log lines are for keys
that manage every server. A setting can remove the admin tools from every key at once.
