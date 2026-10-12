# mcpyard

A small, self-hosted MCP hub. One endpoint, every MCP server behind it, one key per client.

The name comes from a switchyard, where trains are sorted onto the right track and only cleared
ones get through. That is the whole job here. Clients (Claude Code, llooma, any MCP-capable agent)
connect to a single `/mcp` endpoint; mcpyard starts and keeps the upstream MCP servers running,
merges their tools, and only lets each client reach what its key allows.

> Status: early. The hub, keys, managed packages and the OIDC web UI work; the admin MCP endpoint is next.
> Documentation: [cedhuf.github.io/mcpyard](https://cedhuf.github.io/mcpyard/).

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
- **Manageable over MCP.** An optional, separately keyed admin endpoint lets an agent read status
  and versions and restart a server.
- **One small Docker image**, built and published by GitHub Actions.

## Non-goals

No marketplace, no smart routing or semantic tool search, no multi-tenant user management, no
database server. If a feature needs one of those, it belongs in MCPHub, not here.

## Quick look

Servers live in one file:

```yaml
# mcpyard.yaml
servers:
  mail:
    package: { npm: "@infomaniak/mcp-server-mail" }
    env:
      MAIL_TOKEN: ${MAIL_TOKEN}
  calendar:
    package: { npm: "@infomaniak/mcp-server-calendar", version: "1.3.0" }   # pinned
    env:
      CALENDAR_TOKEN: ${CALENDAR_TOKEN}
  home-assistant:
    url: http://homeassistant.example.lan:8123/mcp_server/sse
    headers:
      Authorization: Bearer ${HA_TOKEN}
```

Everything else is an environment variable:

```bash
MCPYARD_CONFIG=/config/mcpyard.yaml
MCPYARD_PUBLIC_URL=https://mcpyard.example.lan
OIDC_ISSUER=https://id.example.lan
OIDC_CLIENT_ID=mcpyard
OIDC_CLIENT_SECRET=...
```

Clients connect to `https://mcpyard.example.lan/mcp` with `Authorization: Bearer <key>`.

## License

[MIT](LICENSE)
