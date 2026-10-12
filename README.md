# mcpyard

A small, self-hosted MCP hub. One endpoint, every MCP server behind it, one key per client.

The name comes from a switchyard, where trains are sorted onto the right track and only cleared
ones get through. That is the whole job here. Clients (Claude Code, llooma, any MCP-capable agent)
connect to a single `/mcp` endpoint; mcpyard starts and keeps the upstream MCP servers running,
merges their tools, and only lets each client reach what its key allows.

> Status: early, everything below works; expect rough edges before 1.0.
> **Documentation: [cedhuf.github.io/mcpyard](https://cedhuf.github.io/mcpyard/)**

## Why

MCPHub does the job but carries a lot: marketplace, smart routing, a database for OIDC, a large UI.
Lighter proxies (TBXark/mcp-proxy, sparfenyuk/mcp-proxy) expose one route per server instead of
one merged endpoint, so every client has to declare every server. 1MCP merges and can be driven
over MCP, but has no OIDC web UI and is still 0.x.

mcpyard aims at the small intersection none of them covers:

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
- **Manageable over MCP.** A separately keyed admin endpoint lets an agent read status and
  versions, restart or update a server, and reload the configuration.
- **One small Docker image**, built and published by GitHub Actions.

## Non-goals

No marketplace, no smart routing or semantic tool search, no multi-tenant user management, no
database server. If a feature needs one of those, it belongs in MCPHub, not here.

## Quick start

```yaml
# mcpyard.yaml
servers:
  time:
    package: { pypi: mcp-server-time }
  memory:
    package: { npm: "@modelcontextprotocol/server-memory", version: "2026.8.31" }   # pinned
  search:
    url: https://search.example.lan/mcp
    headers:
      Authorization: Bearer ${SEARCH_TOKEN}
```

```bash
docker run -d --name mcpyard -p 127.0.0.1:3000:3000 -e MCPYARD_UI_AUTH=none \
  -v ./mcpyard.yaml:/config/mcpyard.yaml:ro -v mcpyard-data:/data \
  ghcr.io/cedhuf/mcpyard:latest
```

Open http://localhost:3000, create a key, then point your client at `/mcp`:

```bash
claude mcp add --transport http mcpyard http://localhost:3000/mcp --header "Authorization: Bearer yard_..."
```

![The servers page of the mcpyard web UI](docs/assets/servers-light.png)

For sign-in with your identity provider, reverse proxies, packages and scopes, read the
[documentation](https://cedhuf.github.io/mcpyard/).

## License

[MIT](LICENSE)
