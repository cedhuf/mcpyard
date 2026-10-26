---
title: Architecture
description: How MCP Yard is built and why, for anyone reading or changing the code.
sidebar:
  order: 1
  label: Overview
---

How MCP Yard is built and why. The rest of this site says how to use it; this section is for anyone reading or changing the code.

## Overview

One Node process, one HTTP port:

```text
 MCP clients --- /mcp (bearer key) ---+                 +--- stdio: npm package (installed by the hub)
                                      |    MCP Yard     +--- stdio: PyPI package (installed by the hub)
 browser ------- /  (OIDC session) ---+--- Hub ---------+--- stdio: any command
                                      |                 +--- HTTP:  remote MCP server
 container ----- /healthz ------------+
```

- An **upstream** per configured server: it installs, starts, watches and reconnects one MCP
  server, and holds its tool list.
- The **hub** merges the tools of every ready upstream into one table, serves them on `/mcp` to
  each key according to its scope, and routes calls back to the right upstream.
- The hub's own **`yard-*` tools** are served on the same endpoint, to keys that ask for them.
- A **web UI**, server-rendered, behind OIDC.

There is no database. State is a handful of JSON files in the data directory, and the list of
servers is one YAML file.

## Source map

All code is in `src/`, run directly by Node from its TypeScript sources: there is no build step.

| File | Role |
| --- | --- |
| `main.ts` | Wiring: reads the environment, builds the hub, the settings and the UI, handles signals. |
| `config.ts` | The server file: schema (zod), `${VAR}` interpolation, comment-preserving edits. |
| `front.ts` | `Hub` (upstreams, routing table, health checks, updates) and the HTTP app with `/mcp`. |
| `upstream.ts` | One upstream server: transport, lifecycle, reconnection, side-by-side update. |
| `packages.ts` | Installing npm and PyPI packages per version, registry checks, recorded versions. |
| `skills.ts` | Skills: the hub's catalog in the skills folder, the relayed upstream skills, the Skills extension per key. |
| `keys.ts` | Keys: token format, hashing, lookup, scopes and tool filters. |
| `yard.ts` | The `yard-*` admin tools. |
| `settings.ts` | Runtime settings: environment, then `settings.json`, then defaults. |
| `logs.ts` | The log book behind the Logs page, and structured events on stdout. |
| `insights.ts` | Figures shared by the dashboard and `yard-overview`. |
| `release.ts` | The running version and the check for a newer MCP Yard release. |
| `oidc.ts` | OIDC authorization code flow with PKCE, and signed cookies. |
| `ui*.ts` | The web UI: routes (`ui.ts`), layout and stylesheet (`ui-layout.ts`), components (`ui-kit.ts`), one file per page. |

## Where to read next

- [Configuration](/mcpyard/architecture/configuration.html): the environment, the server file and live reloads.
- [Upstreams and packages](/mcpyard/architecture/upstreams.html): how servers are started, isolated, installed and updated.
- [Requests and keys](/mcpyard/architecture/requests.html): the `/mcp` endpoint, scopes and the admin tools.
- [Web UI](/mcpyard/architecture/web-ui.html): rendering, themes and sign-in.
- [State and logs](/mcpyard/architecture/state.html): what the hub keeps, and where.
- [Security model](/mcpyard/architecture/security.html): the threats and what limits each one.
- [Building and decisions](/mcpyard/architecture/decisions.html): image, CI, tests, and the choices behind them.
