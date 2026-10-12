# mcpyard

A small, self-hosted MCP hub. One endpoint, every MCP server behind it, one key per client.

Clients (Claude Code, any MCP-capable agent) connect to a single `/mcp` endpoint. mcpyard starts and
keeps the upstream MCP servers running, merges their tools under `<server>-<tool>`, and only lets
each client reach what its key allows.

- [Configuration](configuration.md): the server file, environment variables, keys.
- [Deployment](deployment.md): the Docker image.

## What it does

- **One merged endpoint.** `/mcp` serves the tools of every server the key may see.
- **Known versions.** Package servers run a version installed by the hub, never `npx -y` or `uvx`.
  Pin a version in the file to freeze it, or let the hub own it and update on demand, with the old
  version kept running if the new one fails to start.
- **Keys with scopes.** One bearer key per client, each limited to a set of servers and tools.
- **Upstreams never see the hub's secrets.** They get a minimal environment plus what the file
  declares for them.

Source and issues: [github.com/cedhuf/mcpyard](https://github.com/cedhuf/mcpyard). MIT licensed.
