<p align="center"><img src="docs/assets/logo.webp" alt="MCP Yard logo: a glass greenhouse behind a locked gate, with a golden key" width="200"></p>

# MCP Yard

A small, self-hosted MCP hub. One endpoint, every MCP server behind it, one key per client.

The name comes from a switchyard, where trains are sorted onto the right track and only cleared
ones get through. That is the whole job here. Clients (Claude Code, llooma, any MCP-capable agent)
connect to a single `/mcp` endpoint; MCP Yard starts and keeps the upstream MCP servers running,
merges their tools, and only lets each client reach what its key allows.

> Status: early, everything below works; expect rough edges before 1.0.
> **Documentation: [cedhuf.github.io/mcpyard](https://cedhuf.github.io/mcpyard/)**

## Why

MCPHub does the job but carries a lot: marketplace, smart routing, a database for OIDC, a large UI.
Lighter proxies (TBXark/mcp-proxy, sparfenyuk/mcp-proxy) expose one route per server instead of
one merged endpoint, so every client has to declare every server. 1MCP merges and can be driven
over MCP, but has no OIDC web UI and is still 0.x.

MCP Yard aims at the small intersection none of them covers:

- **One merged endpoint.** `/mcp` serves the tools of every server the key may see.
- **Known versions, one-click updates.** Each server runs a package version installed by the hub,
  not whatever `npx -y` has cached. The UI shows when a newer one exists and updates it in one
  click, with rollback if it fails to start. Pin a version in the file to freeze it.
- **Keys with scopes from day one.** One bearer key per client, each limited to a set of servers
  and tools.
- **OIDC first.** The web UI sits behind your identity provider (PocketID, Authelia, Keycloak...).
  No local password.
- **Configured by environment and one file.** Runtime settings in env vars, servers in a single
  YAML file you can version.
- **Manageable over MCP.** Keys you allow get the hub's own `yard-*` tools: read status and
  versions, restart or update a server, reload the configuration.
- **One small Docker image**, built and published by GitHub Actions.

## Non-goals

No marketplace, no smart routing or semantic tool search, no multi-tenant user management, no
database server. If a feature needs one of those, it belongs in MCPHub, not here.

## Quick start

A local trial, without sign-in and reachable only from your machine:

```yaml
# mcpyard.yaml
servers:
  time:
    package: { pypi: mcp-server-time }
  memory:
    package: { npm: "@modelcontextprotocol/server-memory", version: "2026.8.31" }   # pinned
```

```bash
docker run -d --name mcpyard -p 127.0.0.1:3000:3000 -e MCPYARD_UI_AUTH=none \
  -v ./mcpyard.yaml:/config/mcpyard.yaml -v mcpyard-data:/data \
  ghcr.io/cedhuf/mcpyard:latest
```

Open http://localhost:3000, create a key, then point your client at `/mcp`:

```bash
claude mcp add --transport http mcpyard http://localhost:3000/mcp --header "Authorization: Bearer yard_..."
```

![The servers page of the MCP Yard web UI](docs/assets/servers-light.png)

## Docker Compose or Podman

For a real deployment, with the web UI behind your identity provider:

```yaml
# compose.yaml
services:
  mcpyard:
    image: ghcr.io/cedhuf/mcpyard:latest
    restart: unless-stopped
    ports: ["127.0.0.1:3000:3000"]   # put a TLS reverse proxy in front
    env_file: .env
    volumes:
      - ./mcpyard.yaml:/config/mcpyard.yaml   # add :ro to forbid editing servers from the UI
      - mcpyard-data:/data

volumes:
  mcpyard-data:
```

```bash
# .env
# What browsers type; the OIDC redirect URI is <this>/auth/callback
MCPYARD_PUBLIC_URL=https://mcpyard.example.lan
OIDC_ISSUER=https://id.example.lan
OIDC_CLIENT_ID=mcpyard
OIDC_CLIENT_SECRET=change-me
# Optional: only these groups (from the groups claim) may sign in
# OIDC_ALLOWED_GROUPS=mcpyard-admins

# Every ${VAR} used in mcpyard.yaml must be defined here, or the hub refuses to start:
# SEARCH_TOKEN=...
```

Start it with `docker compose up -d`, or `podman compose up -d` (`podman-compose` works too). On
SELinux hosts such as Fedora or RHEL, label the bind mount: `./mcpyard.yaml:/config/mcpyard.yaml:Z`.

The container runs as uid 1000: for the web UI to add and edit servers, the file must be writable by
it (`chown 1000 mcpyard.yaml`). Settings that are not in the environment, such as turning the admin
endpoint off, live on the UI's **Settings** page.

After editing `mcpyard.yaml` by hand, apply it without a restart from the web UI, or with
`docker kill -s HUP mcpyard` (`podman kill -s HUP ...`): only the servers you changed restart.

Where to go next:

| To... | Read |
| --- | --- |
| register mcpyard with PocketID, Authelia or Keycloak | [Web UI and sign-in](https://cedhuf.github.io/mcpyard/web-ui.html) |
| set up Caddy or nginx in front, and know what `/data` holds | [Deployment](https://cedhuf.github.io/mcpyard/deployment.html) |
| declare packages, commands and remote servers | [Server file](https://cedhuf.github.io/mcpyard/configuration.html) |
| pin versions, update and roll back | [Packages and updates](https://cedhuf.github.io/mcpyard/packages.html) |
| give each client only the servers and tools it needs | [Keys and scopes](https://cedhuf.github.io/mcpyard/keys.html) |
| let an agent watch, restart and update servers | [Admin endpoint](https://cedhuf.github.io/mcpyard/admin.html) |
| see every environment variable | [Environment variables](https://cedhuf.github.io/mcpyard/configuration.html#environment-variables) |

## License

[MIT](LICENSE)
