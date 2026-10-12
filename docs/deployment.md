---
title: Deployment
---

# Deployment

mcpyard ships as one image, `ghcr.io/cedhuf/mcpyard`, for `linux/amd64` and `linux/arm64`. Tags are
the release version (`0.2.0`) and `latest`.

## Docker Compose

```yaml
# compose.yaml
services:
  mcpyard:
    image: ghcr.io/cedhuf/mcpyard:latest
    restart: unless-stopped
    ports: ["127.0.0.1:3000:3000"]
    env_file: .env
    volumes:
      - ./mcpyard.yaml:/config/mcpyard.yaml
      - mcpyard-data:/data

volumes:
  mcpyard-data:
```

```bash
# .env
MCPYARD_PUBLIC_URL=https://mcpyard.example.lan
OIDC_ISSUER=https://id.example.lan
OIDC_CLIENT_ID=mcpyard
OIDC_CLIENT_SECRET=...
# secrets referenced from mcpyard.yaml
SEARCH_TOKEN=...
```

## What lives where

| Path | Contents |
| --- | --- |
| `/config/mcpyard.yaml` | The server file. Writable by uid 1000 to edit servers from the UI; mount it `:ro` to forbid that. |
| `/data/keys.json` | Hashed keys and their scopes. |
| `/data/versions.json` | Hub-owned package versions. |
| `/data/packages/` | Installed packages, one directory per version. |
| `/data/python/`, `/data/cache/` | Python interpreters and package caches. |
| `/data/settings.json` | Settings saved from the UI's Settings page. |
| `/data/session.key` | Signs web UI sessions. |

Keep `/data` on a volume: upgrading the image then reuses every installed package. The image runs as
the unprivileged `node` user.

## Reverse proxy

Terminate TLS in front of mcpyard. MCP responses can be long-lived streams, so turn response
buffering off and allow long reads.

### Caddy

```
mcpyard.example.lan {
  reverse_proxy mcpyard:3000 {
    flush_interval -1
  }
}
```

### nginx

```nginx
location / {
  proxy_pass http://mcpyard:3000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_read_timeout 1h;
}
```

Keep the `Host` header: the web UI checks that forms come from the hub's own origin.

## Outbound proxy

The hub reaches npm, PyPI and GitHub to install packages and check versions. Behind an egress
proxy, set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` so Node uses it; `npm` and `uv` read
`HTTPS_PROXY` on their own.

## Health and logs

`/healthz` answers `ok` once the HTTP server is up; the image's health check uses it. Server output is
prefixed with the server name on standard error; tool calls and key changes are JSON lines on standard
output.

## Applying configuration changes

Edit `mcpyard.yaml`, then reload it from the web UI or with `docker kill -s HUP mcpyard`. Only the
servers you touched restart. See [Reloading](configuration.html#reloading).

## Upgrading

The sidebar shows the running version and tells you when a newer release exists. Pull the new image
and recreate the container. Releases follow semantic versioning; notes are on the
[releases page](https://github.com/cedhuf/mcpyard/releases).
