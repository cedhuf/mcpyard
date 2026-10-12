---
title: Web UI and sign-in
---

# Web UI and sign-in

The web UI is served at the root of the hub. It shows each server's state, tools and versions,
restarts servers, updates and rolls back packages, reloads the server file, and creates, edits,
disables and deletes keys. It refreshes itself every few seconds.

<picture>
  <source srcset="assets/servers-dark.png" media="(prefers-color-scheme: dark)">
  <img src="assets/servers-light.png" alt="The servers page of the web UI">
</picture>

## Sign-in with OpenID Connect

There is no local password. The UI signs you in through your identity provider with the
authorization code flow and PKCE, and verifies the ID token's signature, issuer, audience, expiry and
nonce.

```bash
MCPYARD_PUBLIC_URL=https://mcpyard.example.lan
OIDC_ISSUER=https://id.example.lan
OIDC_CLIENT_ID=mcpyard
OIDC_CLIENT_SECRET=...
OIDC_ALLOWED_GROUPS=mcpyard-admins   # optional
```

In your provider, register a client with:

- **Redirect URI**: `<MCPYARD_PUBLIC_URL>/auth/callback`
- **Scopes**: `openid profile email`, plus `groups` when you use `OIDC_ALLOWED_GROUPS`
- **Client authentication**: client secret (basic or post), or a public client with no secret

Sessions last 12 hours in a signed, HTTP-only cookie. The signing key is generated in
`$MCPYARD_DATA_DIR/session.key`; delete it and restart to sign everyone out.

### Who may sign in

Anyone your provider lets through for this client. Restrict it in the provider, or set
`OIDC_ALLOWED_GROUPS`: the ID token's `groups` claim must then contain one of the listed groups.

## Provider examples

### PocketID

Under **OIDC Clients**, add a client named `mcpyard` with the callback URL above. Copy the client id
and secret into the environment. Use the client's allowed user groups to choose who may sign in.

### Authelia

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: mcpyard
        client_name: mcpyard
        client_secret: "$pbkdf2-sha512$..."   # authelia crypto hash generate pbkdf2
        authorization_policy: two_factor
        redirect_uris: [https://mcpyard.example.lan/auth/callback]
        scopes: [openid, profile, email, groups]
        token_endpoint_auth_method: client_secret_basic
        require_pkce: true
        pkce_challenge_method: S256
```

### Keycloak

Create an OpenID Connect client with **Client authentication** on and **Standard flow** enabled, and
set the valid redirect URI. The secret is on the **Credentials** tab. To use
`OIDC_ALLOWED_GROUPS`, add a **Group Membership** mapper with the claim name `groups` and
**Full group path** off to the client's dedicated scope.

## Without sign-in

Without the OIDC variables the UI is off: only `/mcp`, `/admin/mcp` and `/healthz` answer.

`MCPYARD_UI_AUTH=none` serves the UI to anyone who reaches the port. Use it for a local trial, on a
network you trust, or behind a proxy that already authenticates. The hub prints a warning at startup
as a reminder.

## Protections

- Forms are accepted only from the hub's own origin, and cookies are `SameSite=Lax`.
- A strict Content Security Policy allows no inline handlers and only the page's own script, through
  a per-request nonce.
- The UI never shows a token after creation.
