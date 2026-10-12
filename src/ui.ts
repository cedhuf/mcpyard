import { Hono, type Context, type Next } from 'hono';
import { randomBytes } from 'node:crypto';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html, raw } from 'hono/html';
import type { ServerConfig } from './config.ts';
import type { Hub } from './front.ts';
import { allowed, loadKeys, newKey, saveKeys, type Key } from './keys.ts';
import type { Oidc, Signer, User } from './oidc.ts';

export type UiAuth = { kind: 'none' } | { kind: 'oidc'; oidc: Oidc; signer: Signer };

export type UiOptions = { keysPath: string; auth: UiAuth; publicUrl?: string };

type Env = { Variables: { user?: User; nonce: string } };
type Fragment = ReturnType<typeof html>;

const SESSION = 'mcpyard_session';
const LOGIN = 'mcpyard_login';
const SESSION_HOURS = 12;

export function ui(hub: Hub, options: UiOptions): Hono<Env> {
  const app = new Hono<Env>();
  const { auth, keysPath } = options;
  const secure = (c: Context) => new URL(options.publicUrl ?? c.req.url).protocol === 'https:';
  const base = (c: Context) => (options.publicUrl ?? new URL(c.req.url).origin).replace(/\/$/, '');

  const guard = async (c: Context<Env>, next: Next) => {
    if (c.req.method === 'POST') {
      if (!sameOrigin(c.req.header('origin'), base(c))) return c.text('Forbidden: cross-origin request', 403);
    }
    if (auth.kind === 'oidc') {
      const user = auth.signer.open<User>(getCookie(c, SESSION));
      if (!user) {
        if (c.req.method !== 'GET') return c.text('Unauthorized', 401);
        return c.redirect(`/auth/login?return=${encodeURIComponent(c.req.path)}`);
      }
      c.set('user', user);
    }
    const nonce = randomBytes(16).toString('base64');
    c.set('nonce', nonce);
    c.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'`);
    c.header('Referrer-Policy', 'same-origin');
    await next();
  };

  if (auth.kind === 'oidc') {
    app.get('/auth/login', async (c) => {
      const returnTo = c.req.query('return') ?? '/';
      const { url, pending } = await auth.oidc.begin(/^\/(?!\/)/.test(returnTo) ? returnTo : '/');
      setCookie(c, LOGIN, auth.signer.sign(pending, 600), { path: '/auth', httpOnly: true, sameSite: 'Lax', secure: secure(c) });
      return c.redirect(url);
    });

    app.get('/auth/callback', async (c) => {
      const pending = auth.signer.open<Parameters<Oidc['finish']>[1]>(getCookie(c, LOGIN));
      deleteCookie(c, LOGIN, { path: '/auth' });
      try {
        const user = await auth.oidc.finish(new URL(c.req.url).searchParams, pending);
        setCookie(c, SESSION, auth.signer.sign(user, SESSION_HOURS * 3600), { path: '/', httpOnly: true, sameSite: 'Lax', secure: secure(c) });
        return c.redirect(pending!.returnTo);
      } catch (e) {
        console.error(`login failed: ${(e as Error).message}`);
        return c.html(page(c, 'Sign-in failed', signedOut(`Sign-in failed: ${(e as Error).message}`)), 403);
      }
    });

    app.post('/auth/logout', guard, (c) => {
      deleteCookie(c, SESSION, { path: '/' });
      return c.html(page(c, 'Signed out', signedOut('You are signed out.')));
    });
  }

  app.get('/', guard, (c) => c.html(page(c, 'Servers', serversView(hub))));

  app.post('/servers/:name/update', guard, async (c) => {
    const name = c.req.param('name') ?? '';
    const { version } = await c.req.parseBody();
    if (!hub.upstreams.has(name)) return c.text('Not found', 404);
    // Installing can take minutes: the page polls and shows progress or the error.
    hub.update(name, typeof version === 'string' && version ? version : undefined).catch((e: Error) => console.error(`[${name}] update failed: ${e.message}`));
    return c.redirect('/', 303);
  });

  app.post('/servers/:name/restart', guard, async (c) => {
    const name = c.req.param('name') ?? '';
    if (!hub.upstreams.has(name)) return c.text('Not found', 404);
    void hub.restart(name);
    return c.redirect('/', 303);
  });

  app.get('/keys', guard, (c) => c.html(page(c, 'Keys', keysView(hub, loadKeys(keysPath)))));

  app.post('/keys', guard, async (c) => {
    const form = await c.req.parseBody({ all: true });
    const name = String(form.name ?? '').trim();
    if (!name || name.length > 64) return c.text('Bad request: name is required, 64 characters at most', 400);
    const { token, key } = newKey(name, form.kind === 'admin' ? 'admin' : 'client');
    const servers = ([] as unknown[]).concat(form.servers ?? []).map(String);
    key.scope.servers = servers.length === 0 || servers.includes('*') ? ['*'] : servers;
    const allow = globs(form.allow);
    const deny = globs(form.deny);
    key.scope.tools = { ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}) };
    const keys = loadKeys(keysPath);
    saveKeys(keysPath, [...keys, key]);
    console.log(JSON.stringify({ event: 'key_created', time: new Date().toISOString(), key: key.name, by: c.get('user')?.name ?? null }));
    return c.html(page(c, 'Keys', html`${created(key, token, base(c))}${keysView(hub, [...keys, key])}`));
  });

  for (const action of ['enable', 'disable', 'delete'] as const) {
    app.post(`/keys/:id/${action}`, guard, (c) => {
      const id = c.req.param('id') ?? '';
      const keys = loadKeys(keysPath);
      const key = keys.find((k) => k.id === id);
      if (!key) return c.text('Not found', 404);
      if (action === 'delete') keys.splice(keys.indexOf(key), 1);
      else key.enabled = action === 'enable';
      saveKeys(keysPath, keys);
      console.log(JSON.stringify({ event: `key_${action}`, time: new Date().toISOString(), key: key.name, by: c.get('user')?.name ?? null }));
      return c.redirect('/keys', 303);
    });
  }

  return app;
}

function sameOrigin(origin: string | undefined, base: string): boolean {
  try {
    return !!origin && new URL(origin).host === new URL(base).host;
  } catch {
    return false;
  }
}

function globs(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

function source(config: ServerConfig): string {
  if (config.package) return config.package.npm ? `npm ${config.package.npm}` : `pypi ${config.package.pypi}`;
  if (config.url) return config.url;
  return [config.command, ...config.args].join(' ');
}

function serversView(hub: Hub): Fragment {
  const packages = hub.packageStatus();
  const rows = [...hub.upstreams].map(([name, upstream]) => {
    const config = hub.configs[name]!;
    const pkg = packages[name];
    const state = config.enabled ? upstream.state : 'disabled';
    const error = upstream.lastError ?? pkg?.updateError;
    const visible = upstream.tools.filter((t) => allowed(t.name, config.tools));
    return html`<tr>
        <td><strong>${name}</strong><div class="muted mono">${source(config)}</div></td>
        <td><span class="badge ${state}">${pkg?.updating ? 'updating' : state}</span></td>
        <td>${pkg ? versionCell(name, pkg) : html`<span class="muted">n/a</span>`}</td>
        <td>
          ${upstream.tools.length
            ? html`<details data-id="${name}">
                <summary>${visible.length} tool${visible.length === 1 ? '' : 's'}${visible.length < upstream.tools.length ? html` <span class="muted">(${upstream.tools.length - visible.length} hidden)</span>` : ''}</summary>
                <ul class="tools">
                  ${upstream.tools.map((t) => html`<li class="${allowed(t.name, config.tools) ? '' : 'hidden'}" title="${t.description ?? ''}"><span class="mono">${name}-${t.name}</span></li>`)}
                </ul>
              </details>`
            : html`<span class="muted">none</span>`}
        </td>
        <td class="actions">
          ${config.enabled ? html`<form method="post" action="/servers/${name}/restart"><button>Restart</button></form>` : ''}
        </td>
      </tr>
      ${error ? html`<tr class="error"><td colspan="5">${pkg?.updateError && !upstream.lastError ? 'Update failed: ' : ''}${error}</td></tr>` : ''}`;
  });
  return html`<section id="servers">
      <h1>Servers</h1>
      ${rows.length
        ? html`<table>
            <thead><tr><th>Server</th><th>State</th><th>Version</th><th>Tools</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
        : html`<p class="muted">No servers in the configuration file.</p>`}
    </section>`;
}

function versionCell(name: string, pkg: NonNullable<ReturnType<Hub['packageStatus']>[string]>): Fragment {
  const latest = pkg.latest?.version;
  const newer = latest && pkg.installed && latest !== pkg.installed;
  return html`<span class="mono">${pkg.installed ?? '...'}</span>
    ${pkg.pinned ? html`<span class="tag" title="Pinned in the configuration file">pinned</span>` : ''}
    ${newer ? html`<div class="muted">latest ${latest}</div>` : ''}
    ${pkg.latest?.error ? html`<div class="muted" title="${pkg.latest.error}">registry check failed</div>` : ''}
    ${!pkg.pinned && !pkg.updating && newer
      ? html`<form method="post" action="/servers/${name}/update"><input type="hidden" name="version" value="${latest}" /><button class="primary">Update to ${latest}</button></form>`
      : ''}
    ${!pkg.pinned && !pkg.updating && pkg.previous
      ? html`<form method="post" action="/servers/${name}/update"><input type="hidden" name="version" value="${pkg.previous}" /><button>Roll back to ${pkg.previous}</button></form>`
      : ''}`;
}

function keysView(hub: Hub, keys: Key[]): Fragment {
  const servers = [...hub.upstreams.keys()];
  const filter = (k: Key) =>
    [k.scope.tools.allow?.length ? `allow ${k.scope.tools.allow.join(', ')}` : '', k.scope.tools.deny?.length ? `deny ${k.scope.tools.deny.join(', ')}` : '']
      .filter(Boolean)
      .join('; ') || 'all tools';
  return html`<section>
      <h1>Keys</h1>
      ${keys.length
        ? html`<table>
            <thead><tr><th>Name</th><th>Kind</th><th>Servers</th><th>Tools</th><th>Created</th><th></th></tr></thead>
            <tbody>
              ${keys.map(
                (k) => html`<tr class="${k.enabled ? '' : 'disabled'}">
                  <td><strong>${k.name}</strong><div class="muted mono">${k.prefix}</div></td>
                  <td>${k.kind}${k.enabled ? '' : html` <span class="tag">disabled</span>`}</td>
                  <td>${k.scope.servers.includes('*') ? 'all' : k.scope.servers.join(', ')}</td>
                  <td class="mono">${filter(k)}</td>
                  <td>${k.created.slice(0, 10)}</td>
                  <td class="actions">
                    <form method="post" action="/keys/${k.id}/${k.enabled ? 'disable' : 'enable'}"><button>${k.enabled ? 'Disable' : 'Enable'}</button></form>
                    <form method="post" action="/keys/${k.id}/delete" data-confirm="Delete key ${k.name}? Clients using it lose access."><button class="danger">Delete</button></form>
                  </td>
                </tr>`,
              )}
            </tbody>
          </table>`
        : html`<p class="muted">No keys yet. Create one for each client.</p>`}
    </section>
    <section>
      <h2>New key</h2>
      <form method="post" action="/keys" class="card">
        <label>Name <input name="name" required maxlength="64" placeholder="laptop-claude-code" /></label>
        <label>Kind
          <select name="kind"><option value="client">client: uses /mcp</option><option value="admin">admin: management endpoint</option></select>
        </label>
        <fieldset>
          <legend>Servers</legend>
          <label class="check"><input type="checkbox" name="servers" value="*" checked /> All, including future ones</label>
          ${servers.map((s) => html`<label class="check"><input type="checkbox" name="servers" value="${s}" /> ${s}</label>`)}
        </fieldset>
        <label>Allow tools <input name="allow" placeholder="mail-*, calendar-list_*" /><span class="muted">Globs on exposed names, empty for all.</span></label>
        <label>Deny tools <input name="deny" placeholder="*-delete_*" /></label>
        <button class="primary">Create key</button>
      </form>
    </section>`;
}

function created(key: Key, token: string, base: string): Fragment {
  return html`<section class="card notice">
    <h2>Key ${key.name} created</h2>
    <p>Copy the token now: it is shown once and only its hash is stored.</p>
    <pre class="mono">${token}</pre>
    ${key.kind === 'client'
      ? html`<p>Claude Code:</p>
          <pre class="mono">claude mcp add --transport http mcpyard ${base}/mcp --header "Authorization: Bearer ${token}"</pre>`
      : ''}
  </section>`;
}

function signedOut(message: string): Fragment {
  return html`<section class="card"><p>${message}</p><a class="button primary" href="/auth/login">Sign in</a></section>`;
}

function page(c: Context<Env>, title: string, body: Fragment): Fragment {
  const user = c.get('user');
  const nonce = c.get('nonce');
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · mcpyard</title>
        <style>
          ${raw(CSS)}
        </style>
      </head>
      <body>
        <header>
          <a class="brand" href="/">mcpyard</a>
          <nav><a href="/">Servers</a><a href="/keys">Keys</a></nav>
          ${user ? html`<form method="post" action="/auth/logout" class="user"><span>${user.name}</span><button>Sign out</button></form>` : ''}
        </header>
        <main>${body}</main>
        ${nonce ? html`<script nonce="${nonce}">${raw(SCRIPT)}</script>` : ''}
      </body>
    </html>`;
}

const SCRIPT = `
document.addEventListener('submit', (e) => {
  const message = e.target.dataset.confirm;
  if (message && !confirm(message)) e.preventDefault();
});
if (document.getElementById('servers')) setInterval(async () => {
  if (document.hidden) return;
  const current = document.getElementById('servers');
  const open = [...current.querySelectorAll('details[open]')].map((d) => d.dataset.id);
  const res = await fetch(location.href).catch(() => null);
  if (!res || !res.ok || res.redirected) return;
  const next = new DOMParser().parseFromString(await res.text(), 'text/html').getElementById('servers');
  if (!next) return;
  for (const id of open) next.querySelector('details[data-id="' + CSS.escape(id) + '"]')?.setAttribute('open', '');
  current.replaceWith(next);
}, 4000);`;

const CSS = `
:root { --bg: #f7f7f5; --fg: #1d1d1b; --muted: #6b6b66; --line: #e2e2dc; --card: #fff; --accent: #2f5bd3; --ok: #1f8a4c; --warn: #b7791f; --bad: #c53030; --info: #2b6cb0; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --fg: #ecece8; --muted: #9a9a93; --line: #2c2c2a; --card: #1d1d1c; --accent: #7aa2ff; --ok: #48bb78; --warn: #ecc94b; --bad: #fc8181; --info: #63b3ed; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; align-items: center; gap: 24px; padding: 12px 24px; border-bottom: 1px solid var(--line); background: var(--card); flex-wrap: wrap; }
.brand { font-weight: 700; font-size: 17px; color: var(--fg); text-decoration: none; letter-spacing: -0.01em; }
nav { display: flex; gap: 16px; flex: 1; }
nav a { color: var(--muted); text-decoration: none; }
nav a:hover { color: var(--fg); }
.user { display: flex; align-items: center; gap: 10px; color: var(--muted); }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 8px 0 16px; }
h2 { font-size: 17px; margin: 32px 0 12px; }
section.card h2, .notice h2 { margin-top: 0; }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
tr.error td { color: var(--bad); font-size: 13px; padding-top: 0; white-space: pre-wrap; word-break: break-word; }
tr.disabled td { opacity: 0.55; }
.muted { color: var(--muted); font-size: 13px; }
.mono, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
td .mono { word-break: break-all; }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid currentColor; }
.badge.ready { color: var(--ok); } .badge.degraded { color: var(--warn); } .badge.failed { color: var(--bad); }
.badge.installing, .badge.starting, .badge.updating { color: var(--info); } .badge.stopped, .badge.disabled { color: var(--muted); }
.tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; margin-left: 4px; }
details summary { cursor: pointer; }
ul.tools { margin: 6px 0 0; padding-left: 18px; }
ul.tools li.hidden { color: var(--muted); text-decoration: line-through; }
.actions { white-space: nowrap; text-align: right; }
.actions form, td form { display: inline-block; margin: 4px 4px 0 0; }
button, .button { font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; text-decoration: none; display: inline-block; }
button:hover, .button:hover { border-color: var(--muted); }
button.primary, .button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { color: var(--bad); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px 20px; }
.notice { border-color: var(--accent); margin-bottom: 24px; }
form.card { display: grid; gap: 14px; max-width: 560px; }
form.card label { display: grid; gap: 4px; font-weight: 600; font-size: 14px; }
form.card label.check { display: flex; gap: 8px; font-weight: 400; align-items: center; }
form.card button { justify-self: start; }
input, select { font: inherit; font-weight: 400; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
fieldset { border: 1px solid var(--line); border-radius: 6px; display: grid; gap: 6px; padding: 10px 14px; }
legend { font-weight: 600; font-size: 14px; padding: 0 4px; }
@media (max-width: 700px) { thead { display: none; } table, tbody, tr, td { display: block; width: 100%; } td { border-bottom: 0; padding: 4px 12px; } tr { border-bottom: 1px solid var(--line); padding: 8px 0; } .actions { text-align: left; } }
`;
