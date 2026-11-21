---
title: Keys and scopes
---

Every client gets its own bearer key. A key decides which servers and which tools the client sees,
and the hub refuses calls to anything else.

## Creating keys

In the web UI, open **Access**, name the key after the client (`laptop-claude-code`, `home-agent`), pick
its servers and tool filters, and create it. The token is displayed once; only its SHA-256 hash is
stored, in `$MCPYARD_DATA_DIR/keys.json`.

<img src="assets/keys-light.png" alt="The keys page, each key with its access, servers and switch" class="dark:sl-hidden">
<img src="assets/keys-dark.png" alt="The keys page, each key with its access, servers and switch" class="light:sl-hidden">

Without the web UI, generate one from the container and add the printed entry to `keys.json`:

```bash
docker exec mcpyard node src/main.ts keygen laptop-claude-code   # add admin as a third argument for hub administration
```

**Edit** renames a key or changes its scope; its token stays the same. To rotate a token, create a
new key and delete the old one. Disabling, editing or deleting a key takes effect on the next request:
the file is read for every call.

The **Last used** column shows when each key last authenticated, recorded at most once an hour.

## Signing in with OAuth

Clients that support MCP authorization can sign in instead of carrying a pasted token. Add the hub
by URL alone:

```bash
claude mcp add --transport http mcpyard https://mcpyard.example.lan/mcp
```

**Connect** on the **Access** page shows that URL, the command, and a prompt to paste to an AI
assistant so it sets the server up itself.

On first use the client opens the browser. You sign in to the web UI, see the client's name and the
host it answers to, pick the servers, tool filters and hub administration exactly as for a key, and
allow it. The sign-in becomes a key, listed under **Signed-in clients** in **Access**, that you edit, disable
or revoke like any other.

Its access token lasts an hour and the client renews it with a refresh token, valid 90 days from the
last renewal and replaced at every use. A refresh token presented twice means it leaked: the key is
disabled.

It needs the web UI with OIDC and an `https` `MCPYARD_PUBLIC_URL` (or `http://localhost` for a local
trial). With `MCPYARD_UI_AUTH=none` it is off, since anyone could approve a sign-in.

Clients identify themselves with a Client ID Metadata Document, a URL the hub fetches, or with
Dynamic Client Registration. Redirects must go to `https` or to a loopback address; for a loopback
one the consent page warns that any program on that computer could be listening.

## Scopes

```json
"scope": {
  "servers": ["time", "mail"],
  "tools": { "deny": ["*-delete_*", "mail-send_*"] }
}
```

- `servers` lists the servers the key reaches; `*` means all, including servers added later.
- `tools` holds `allow` and `deny` globs on the **exposed** names (`<server>-<tool>`). A tool must match
  `allow` when it is set, and must not match `deny`.

Hidden tools are absent from `tools/list` and refused on `tools/call`, so a client cannot call what it
cannot see.

Server-level `tools` filters in the [server file](configuration.html) apply first, to every key.

## Hub administration

Switch on **Hub administration** on a key to give it MCP Yard's own `yard-*` tools as well, on the same
`/mcp` connection: listing, restarting and updating servers, reloading the server file. It sits apart
from the servers in the form on purpose, and no key gets it unless you switch it on. See
[Hub administration](admin.html).

## Audit log

Every tool call is written to standard output as one JSON line:

```json
{"event":"tool_call","time":"2026-10-12T09:14:03.120Z","key":"laptop-claude-code","tool":"time-get_current_time","ok":true,"ms":42}
```

Actions from the web UI are logged the same way, with the signed-in user in `by`:

| Event | When |
| --- | --- |
| `key_created`, `key_updated`, `key_enable`, `key_disable`, `key_delete` | A key changes. |
| `oauth_approved`, `oauth_key_created`, `oauth_refresh_reused` | A client sign-in is allowed, turns into a key, or replays a refresh token. |
| `server_added`, `server_updated`, `server_deleted` | A server form is saved, or a server removed. |
| `server_enabled`, `server_disabled` | A server is switched on or off. |
| `server_restarted`, `package_update` | A server is restarted or a package updated. |
| `config_reloaded`, `settings_saved` | The server file is reloaded, or the settings saved. |
| `security_reviewed`, `security_review_undone` | A security choice is marked reviewed, or shown again. |
| `health_check`, `updates_checked`, `update_all` | The dashboard runs a health check, asks the registries, or updates everything. |
| `server_answering`, `server_not_answering` | The periodic health check sees a server stop or start answering again. |

Ship the container logs wherever you keep logs. The web UI's [Logs](web-ui.html#logs) page shows the
recent ones, with a tab for MCP calls.
