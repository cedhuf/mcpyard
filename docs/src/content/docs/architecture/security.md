---
title: Security model
description: The threats, most likely first, and what limits each one.
sidebar:
  order: 7
---

Threats, most likely first:

1. **Prompt injection through upstream content**: a crafted message read by an agent tries to
   make it call a tool that writes. The hub cannot detect it, so it limits what any one key can
   reach: per-key scopes, server-wide tool filters, administration as a separate grant, and admin
   tools that never change what runs.
2. **A leaked key**: revocable per client, bounded by its scope, visible through `lastUsed` and the
   audit events.
3. **Network access to the hub**: meant to sit behind a TLS reverse proxy. The UI needs a session,
   `/mcp` a key; only `/healthz` and static assets are anonymous.
4. **A compromised upstream package**: versions are installed and recorded, so nothing changes
   silently; install scripts are off by default; each child sees only its own environment.

The container runs as the unprivileged `node` user; only `/data` needs to be writable.
