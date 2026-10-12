# Deployment

Images are published to `ghcr.io/cedhuf/mcpyard` for `linux/amd64` and `linux/arm64`, tagged with
the release version and `latest`.

```yaml
# compose.yaml
services:
  mcpyard:
    image: ghcr.io/cedhuf/mcpyard:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    env_file: .env
    volumes:
      - ./mcpyard.yaml:/config/mcpyard.yaml:ro
      - mcpyard-data:/data

volumes:
  mcpyard-data:
```

The image runs as the `node` user and ships Node and `uv`. Everything that changes lives in
`/data`: keys, installed packages, package caches and the Python interpreters `uv` downloads on the
first PyPI install. Keep it on a volume so upgrades do not reinstall every server.

`/healthz` answers `ok` once the HTTP server is up; the image's health check uses it.

Put mcpyard behind a reverse proxy that terminates TLS. Long-lived `/mcp` streams need response
buffering off and generous read timeouts.
