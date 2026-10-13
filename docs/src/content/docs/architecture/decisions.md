---
title: Building and decisions
description: The image, CI, tests, and the choices behind the design.
sidebar:
  order: 8
---

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
