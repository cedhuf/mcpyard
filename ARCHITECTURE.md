# Architecture

How MCP Yard is built and why. The [docs](https://cedhuf.github.io/mcpyard/) say how to use it;
this file is for anyone reading or changing the code.

## Overview

One Node process, one HTTP port:

```
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
| `keys.ts` | Keys: token format, hashing, lookup, scopes and tool filters. |
| `yard.ts` | The `yard-*` admin tools. |
| `settings.ts` | Runtime settings: environment, then `settings.json`, then defaults. |
| `logs.ts` | The log book behind the Logs page, and structured events on stdout. |
| `insights.ts` | Figures shared by the dashboard and `yard-overview`. |
| `release.ts` | The running version and the check for a newer MCP Yard release. |
| `oidc.ts` | OIDC authorization code flow with PKCE, and signed cookies. |
| `ui*.ts` | The web UI: routes (`ui.ts`), layout and stylesheet (`ui-layout.ts`), components (`ui-kit.ts`), one file per page. |

## Configuration

Two sources with a hard split:

- **Environment variables** for the runtime: paths, port, sign-in, check periods, theme.
- **One YAML file** for the servers. It holds `${VAR}` references, never secret values, so it can
  be committed.

Some runtime settings can also be changed from the Settings page. `Settings.get` resolves each one
in a fixed order: the environment wins and locks the setting in the UI, then the value saved in
`settings.json`, then the default. A saved choice that no longer exists falls back to the default,
so an upgrade that drops an option cannot stop the hub.

The server file is validated as a whole before anything is applied. `Hub.reload()` diffs the new
configuration against the running one: new servers start, removed ones stop, changed ones restart,
untouched ones keep running. A field that only affects display, such as `title`, does not count as
a change. A file that does not parse changes nothing.

When the UI or `yard-set_title` edits the file, `ConfigFile` goes through the YAML document model,
so comments, key order and `${VAR}` references survive, and the whole file must still parse before
it is written. The write happens in place because the file is often a single-file bind mount,
which cannot be replaced by a rename.

## Upstreams

### Kinds

Each server is exactly one of:

- `package`: an npm or PyPI package the hub installs, then runs over stdio;
- `command`: an executable already on the host, over stdio;
- `url`: a remote server over Streamable HTTP, or legacy SSE.

### Lifecycle

States: `installing`, `starting`, `ready`, `degraded` (was ready, reconnecting), `failed` (never got
ready, retrying), `stopped`.

A server is `ready` once `initialize` and `tools/list` succeed. A lost connection or a crashed
child schedules a retry with exponential backoff, from 1 second up to 5 minutes. A server that is
not ready exposes no tools, and every change to an upstream's tools rebuilds the routing table and
sends `tools/list_changed` to connected clients. Servers start in parallel and fail independently.

Servers can also be switched off from the UI or over MCP without touching the file. That state is
kept in `state.json`, on top of what the file says, so it works with a read-only server file.

### Isolation

A stdio child is spawned without a shell, with its arguments as an array. Its environment is a
minimal base (`PATH`, `HOME` and the like) plus the `env` its entry declares, and nothing else: the
hub's own secrets and other servers' tokens never reach it. Install commands get the same scrubbed
environment, plus the proxy and registry variables they need.

## Packages and versions

Packages are installed by the hub, never fetched on the fly:

```
$MCPYARD_DATA_DIR/packages/<server>/<version>/
```

- npm: `npm install --ignore-scripts --prefix <dir> <pkg>@<version>`, then the bin is run from
  `<dir>/node_modules/.bin/`.
- PyPI: `uv venv <dir>`, then `uv pip install --no-build --python <dir> <pkg>==<version>`, run
  from `<dir>/bin/`.

A marker file written after a successful install tells a complete directory from an interrupted
one. Install-time code is off by default (no npm lifecycle scripts, wheels only); `allowScripts`
turns it on per server.

Each server has one version source:

- **Pinned**: `version` is in the file. That version runs; only an edit changes it.
- **Hub-owned**: `version` is omitted. The first start installs the latest and records it in
  `versions.json`; later starts reuse the recorded version, so a restart never upgrades anything.

Registries are asked for the latest version on a period, one request per package, with the
result cached for that period. An update of a hub-owned package runs side by side:

1. install the new version into its own directory;
2. start it next to the running one;
3. wait for `initialize` and `tools/list`;
4. switch traffic to it, then stop the old process;
5. record the new version and keep the previous one for rollback; delete older directories.

If any step fails, the old version keeps serving and the error is kept on the server. Updates are
triggered by a person (UI, `yard-update_*`) or, when switched on, by the nightly schedule.

Node's timers top out at about 24.8 days (`MAX_TIMER`): longer periods are clamped to it.

## The MCP front

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

## Web UI

Server-rendered HTML from `hono/html` templates, with Tailwind CSS 4 and daisyUI 5. The stylesheet
is compiled by the hub at startup from the classes in its own source files, so there is no build
step and no node_modules in the browser. Only the daisyUI modules listed in `DAISY` and the two
halves of the current theme are compiled. The result is served gzipped, with its hash in the URL
and an immutable cache header, and rebuilt when the theme changes.

Themes come in pairs, a light and a dark daisyUI theme (`THEMES` in `settings.ts`). The mode
follows the device with `prefers-color-scheme`, or forces one half with `data-theme`.

Interaction is HTML first: forms that post, links, the popover API for menus, `<dialog>` for
modals, `<details>` for folding. One small inline script, behind a CSP nonce, handles what HTML
cannot: auto refresh, live search, settings autosave, the clock, copy buttons and the confirm
modal.

Every UI response carries a strict Content-Security-Policy (`default-src 'none'`, nonce-only
scripts, `frame-ancestors 'none'`). Every POST is checked against the hub's own origin. The page
font is served by the hub, so the UI makes no external request.

### Sign-in

OIDC authorization code flow with PKCE, implemented on `node:crypto` against the provider's
discovery document. The ID token is verified against the provider's JWKS. When
`OIDC_ALLOWED_GROUPS` is set, the `groups` claim must contain one of them. The session is a signed,
expiring, `HttpOnly`, `SameSite=Lax` cookie; the signing key is generated once and kept in the data
directory. `MCPYARD_UI_AUTH=none` turns sign-in off for a hub that already sits behind an
authenticating proxy; it never affects `/mcp`, which always needs a key.

## Logs and events

`logs.ts` keeps the last 2000 entries in memory for the Logs page and the admin tools: MCP calls,
actions from the UI, servers' standard error and the hub's own notes. Calls and actions are also
saved to `activity.json` a few seconds after they happen and on shutdown, so history survives a
restart; server output stays in memory.

Everything also goes to the process output: structured events as JSON lines on stdout for log
collectors, plain lines on stderr. Long-term retention is the collector's job.

## Data directory

| Path | Content |
| --- | --- |
| `keys.json` | Keys, with token hashes only. |
| `settings.json` | Settings saved from the UI. |
| `state.json` | Servers switched off from the UI. |
| `versions.json` | Recorded and previous versions of hub-owned packages. |
| `activity.json` | Saved MCP calls and UI actions. |
| `session.key` | Key that signs the UI cookies. |
| `packages/<server>/<version>/` | Installed packages. |
| `cache/`, `python/` | npm and uv caches, uv-managed Python. |

Files are written to a temporary name, then renamed, so a crash never leaves half a file. The
server file is the exception explained above.

## Security model

Threats, most likely first:

1. **Prompt injection through upstream content**: a crafted message read by an agent tries to
   make it call a tool that writes. The hub cannot detect it, so it limits what any one key can
   reach: per-key scopes, server-wide tool filters, administration as a separate grant, and admin
   tools that never change what runs.
2. **A leaked key**: revocable per client, bounded by its scope, visible through `lastUsed` and the
   audit events.
3. **Network access to the hub**: meant to sit behind a TLS reverse proxy. The UI needs a session,
   `/mcp` a key; only `/healthz` and static assets are anonymous.
4. **A compromised upstream package**: versions are installed and recorded, so nothing changes
   silently; install scripts are off by default; each child sees only its own environment.

The container runs as the unprivileged `node` user; only `/data` needs to be writable.

## Packaging and CI

The image is `node:26-slim` with the static `uv` binary, the production dependencies and the
sources. Its version is stamped at build time in `MCPYARD_VERSION`; a local run reports `dev`.

- `test.yml` runs the type check and the tests on every push and pull request.
- `release.yml`, started by hand, runs semantic-release on the commit messages (`feat` gives a
  minor version, `fix` and `refactor` a patch), builds the multi-arch image for GHCR, and deploys
  the docs site.

## Tests

`node:test`, no framework. Tests start real hubs and real stdio servers (`test/fixture-server.ts`)
and talk to them through the official MCP client, so the routing, scope and lifecycle paths are
exercised end to end. Registries and installers are injected, so package tests never reach the
network.

```
npx tsc -p .
node --test test/*.test.ts
```

## Decisions

- **TypeScript on Node, not Go.** The image ships Node and Python anyway to run the servers, so a
  static binary saves little. The TypeScript SDK is the reference implementation and gets protocol
  changes first, and most MCP servers are npm packages.
- **No database.** A few JSON files cover the state of a single-instance hub, back up with a copy,
  and remove a service to run.
- **No front-end build.** Server-rendered pages and a stylesheet compiled at startup keep the
  repository a plain Node project that runs from its sources.
- **Merged endpoint.** One `/mcp` for every server, so each client declares one MCP server
  instead of one per upstream.
- **Out of scope**: a marketplace, smart routing between servers, multi-tenancy.
