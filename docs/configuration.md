# Configuration

Runtime settings come from environment variables, servers from one YAML file.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCPYARD_CONFIG` | `/config/mcpyard.yaml` | Server file. |
| `MCPYARD_DATA_DIR` | `/data` | Keys, installed packages, recorded versions. |
| `MCPYARD_PORT` | `3000` | HTTP port. |
| `MCPYARD_VERSION_CHECK_HOURS` | `6` | How often registries are asked for the latest version. |

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
hash of each token is stored. Until the web UI exists, create one with:

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
