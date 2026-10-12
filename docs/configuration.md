---
title: Server file
---

# Server file

Servers live in one YAML file; runtime settings come from environment variables.

## A complete example

```yaml
servers:
  time:
    package: { pypi: mcp-server-time }

  memory:
    package:
      npm: "@modelcontextprotocol/server-memory"
      version: "2026.8.31"          # pinned: the hub never changes it

  mail:
    package: { npm: "@example/mcp-mail", bin: mcp-mail }
    env:
      MAIL_TOKEN: ${MAIL_TOKEN}     # from the hub's environment
    tools:
      deny: ["delete_*"]

  local:
    command: /usr/local/bin/my-server
    args: [--stdio]
    cwd: /srv/my-server

  search:
    url: https://search.example.lan/mcp
    headers:
      Authorization: Bearer ${SEARCH_TOKEN}

  legacy:
    url: https://old.example.lan/sse
    transport: sse
    enabled: false
```

Server names use letters, digits, `_` and `-`. They prefix every tool the server exposes.

## Server kinds

Each server has **exactly one** of these:

| Key | The hub... | Extra fields |
| --- | --- | --- |
| `package` | installs it from npm or PyPI and runs it over stdio | `npm` or `pypi`, `version`, `bin`, `allowScripts` |
| `command` | spawns an executable over stdio | `args`, `cwd` |
| `url` | connects to a remote server | `headers`, `transport` (`streamable-http` or `sse`) |

Packages are covered in [Packages and updates](packages.html).

## Common fields

| Field | Default | Meaning |
| --- | --- | --- |
| `args` | `[]` | Arguments for a package bin or a command. |
| `env` | `{}` | Environment of the spawned process, on top of `PATH`, `HOME` and the like. |
| `tools` | `{}` | `allow` and `deny` globs on the server's own tool names. |
| `enabled` | `true` | `false` keeps the entry without starting it. |

## Secrets and environment

`${VAR}` is replaced from the hub's environment anywhere in the file, and a missing variable stops the
hub at startup rather than starting a server with an empty token.

Spawned servers **never inherit the hub's environment**. They get a minimal set (`PATH`, `HOME` and
the like) plus their own `env`, so a token meant for one server cannot leak to another.

## Tool names

Clients see `<server>-<tool>`: `time-get_current_time`, `mail-send_email`. Routing uses a lookup table,
so names are never split on `-`. If two names collide, the first wins and the hub logs a warning.

Claude Code prefixes tools with `mcp__<client name>__` and rejects names over 64 characters; the hub
warns at startup about any tool that would cross that line. Keep server names short.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCPYARD_CONFIG` | `/config/mcpyard.yaml` | The server file. |
| `MCPYARD_DATA_DIR` | `/data` | Keys, installed packages, recorded versions, session key. |
| `MCPYARD_PORT` | `3000` | HTTP port. |
| `MCPYARD_VERSION_CHECK_HOURS` | `6` | How often registries are asked for new versions. |
| `MCPYARD_PUBLIC_URL` | | Base URL browsers use. Required with OIDC. |
| `OIDC_ISSUER` | | Issuer URL of your identity provider. |
| `OIDC_CLIENT_ID` | | Client id registered for mcpyard. |
| `OIDC_CLIENT_SECRET` | | Client secret; omit for a public client. |
| `OIDC_ALLOWED_GROUPS` | | Comma-separated groups allowed to sign in. |
| `MCPYARD_UI_AUTH` | `oidc` | `none` turns web UI sign-in off. |

## Reloading

After editing the file, apply it without a restart: click **Reload configuration** in the web UI, call
`reload_config` on the [admin endpoint](admin.html), or send `SIGHUP`:

```bash
docker kill -s HUP mcpyard
```

New servers start, removed ones stop, and servers whose settings changed restart with them; the others
keep running untouched. A file that does not parse changes nothing and the error is reported.
Environment variables are read once at startup, so a new `${VAR}` still needs a container restart.
