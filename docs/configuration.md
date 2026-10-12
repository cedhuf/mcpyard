# Configuration

Runtime settings come from environment variables, servers from one YAML file.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCPYARD_CONFIG` | `/config/mcpyard.yaml` | Server file. |
| `MCPYARD_DATA_DIR` | `/data` | Keys, installed packages, recorded versions. |
| `MCPYARD_PORT` | `3000` | HTTP port. |
| `MCPYARD_VERSION_CHECK_HOURS` | `6` | How often registries are asked for the latest version. |
| `MCPYARD_PUBLIC_URL` | | Base URL browsers use, e.g. `https://mcpyard.example.lan`. Required with OIDC. |
| `OIDC_ISSUER` | | Issuer URL of your identity provider. |
| `OIDC_CLIENT_ID` | | Client id registered for mcpyard. |
| `OIDC_CLIENT_SECRET` | | Client secret; omit for a public client (PKCE is always used). |
| `OIDC_ALLOWED_GROUPS` | | Comma-separated groups; when set, the `groups` claim must contain one. |
| `MCPYARD_UI_AUTH` | `oidc` | `none` turns web UI authentication off. |

## Web UI

The UI is served at the root of the hub. It shows every server with its state, tools and versions,
restarts servers, updates or rolls back hub-owned packages, and creates, disables and deletes keys.

Sign-in uses OpenID Connect with the authorization code flow and PKCE. Register a client in your
identity provider (PocketID, Authelia, Keycloak...) with the redirect URI
`<MCPYARD_PUBLIC_URL>/auth/callback`, and restrict who may use it there or with
`OIDC_ALLOWED_GROUPS`. Sessions last 12 hours in a signed cookie; the signing key is generated in
`$MCPYARD_DATA_DIR/session.key`, delete it to sign everyone out.

Without the OIDC variables the UI is off and only `/mcp` and `/healthz` answer.
`MCPYARD_UI_AUTH=none` serves the UI to anyone who reaches the port: use it only on a trusted
network or behind a proxy that authenticates.

## Server file

```yaml
servers:
  mail:
    package: { npm: "@example/mcp-server-mail" }
    env:
      MAIL_TOKEN: ${MAIL_TOKEN}
  time:
    package: { pypi: mcp-server-time, version: "2026.10.10" }
  local:
    command: /usr/local/bin/my-server
    args: [--stdio]
  remote:
    url: https://mcp.example.com/mcp
    headers:
      Authorization: Bearer ${REMOTE_TOKEN}
    tools: { deny: ["delete_*"] }
```

Server names match `[A-Za-z0-9_-]+`. `${VAR}` is replaced from the hub's environment anywhere in the
file; a missing variable stops the hub at startup.

Each server has exactly one of:

- `package`: `{ npm: <name> }` or `{ pypi: <name> }`, plus optional `version` and `bin`.
- `command`: an executable spawned over stdio, with optional `args` and `cwd`.
- `url`: a remote server, with optional `headers` and `transport` (`streamable-http`, the default,
  or `sse`).

Common fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `env` | `{}` | Environment for the spawned process, on top of `PATH`, `HOME` and the like. |
| `tools` | `{}` | `allow` and `deny` glob lists on the upstream tool names. |
| `enabled` | `true` | `false` keeps the entry without starting it. |
| `allowScripts` | `false` | Let a package run install-time code (npm scripts, Python source builds). |

## Packages

Packages are installed into `$MCPYARD_DATA_DIR/packages/<server>/<version>/`, with
`npm install --ignore-scripts` or `uv pip install --no-build` into a dedicated virtualenv. A package
that needs install-time code fails with the installer's error until `allowScripts: true` is set.

The bin to run is `bin` when given, otherwise the package's only bin. A package with several bins
needs `bin`.

**Pinned** (`version` set): that version runs, the hub never changes it.

**Hub-owned** (`version` omitted): the first start installs the registry's latest version and
records it in `$MCPYARD_DATA_DIR/versions.json`; later starts reuse it. The hub checks registries
for newer versions but never updates on its own. An update installs the new version, starts it
next to the running one, switches traffic once it answers, and keeps the previous version for
rollback.

## Keys

Clients send `Authorization: Bearer <token>`. Keys live in `$MCPYARD_DATA_DIR/keys.json`; only a
hash of each token is stored. Create them in the web UI, or from a shell:

```bash
node src/main.ts keygen <name>
# or, with Docker:
docker exec mcpyard node src/main.ts keygen <name>
```

It prints the token once and the entry to add to `keys.json`. The file is re-read on every request.
Narrow a key with its `scope`:

```json
"scope": { "servers": ["mail", "time"], "tools": { "deny": ["*-delete_*"] } }
```

`servers` lists server names (`*` for all); `tools` filters the exposed `<server>-<tool>` names.

## Admin endpoint

`/admin/mcp` is a separate MCP endpoint that only admin keys reach, and admin keys reach nothing
else. It lets an agent watch and nurse the hub:

| Tool | Does |
| --- | --- |
| `list_servers` | State, last error, tool count and package versions of every server. |
| `get_server` | One server with its tool names and whether the configuration exposes them. |
| `restart_server` | Restarts a server, waits up to 30 seconds for it to settle, returns its status. |

An admin key's `scope.servers` limits the servers it sees and manages, and `scope.tools` filters
these three tool names: `{ "deny": ["restart_server"] }` makes a read-only key. Calls are logged
like client calls, with the tool name prefixed by `admin:`.
