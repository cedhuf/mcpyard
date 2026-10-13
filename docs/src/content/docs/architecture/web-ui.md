---
title: Web UI
description: Server-rendered pages, a stylesheet compiled at startup, themes in pairs and OIDC sign-in.
sidebar:
  order: 5
---

Server-rendered HTML from `hono/html` templates, with Tailwind CSS 4 and daisyUI 5. The stylesheet
is compiled by the hub at startup from the classes in its own source files, so there is no build
step and no node_modules in the browser. Only the daisyUI modules listed in `DAISY` and the two
halves of the current theme are compiled. The result is served gzipped, with its hash in the URL
and an immutable cache header, and rebuilt when the theme changes.

Themes come in pairs, a light and a dark daisyUI theme (`THEMES` in `settings.ts`). The mode
follows the device with `prefers-color-scheme`, or forces one half with `data-theme`.

Interaction is HTML first: forms that post, links, the popover API for menus, `<dialog>` for
modals, `<details>` for folding. One small inline script, behind a CSP nonce, handles what HTML
cannot: auto refresh, live search, settings autosave, the clock, copy buttons and the confirm
modal.

Every UI response carries a strict Content-Security-Policy (`default-src 'none'`, nonce-only
scripts, `frame-ancestors 'none'`). Every POST is checked against the hub's own origin. The page
font is served by the hub, so the UI makes no external request.

## Sign-in

OIDC authorization code flow with PKCE, implemented on `node:crypto` against the provider's
discovery document. The ID token is verified against the provider's JWKS. When
`OIDC_ALLOWED_GROUPS` is set, the `groups` claim must contain one of them. The session is a signed,
expiring, `HttpOnly`, `SameSite=Lax` cookie; the signing key is generated once and kept in the data
directory. `MCPYARD_UI_AUTH=none` turns sign-in off for a hub that already sits behind an
authenticating proxy; it never affects `/mcp`, which always needs a key.
