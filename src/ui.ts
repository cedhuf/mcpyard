import { Hono, type Context, type Next } from 'hono';
import { randomBytes } from 'node:crypto';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html, raw } from 'hono/html';
import type { ServerConfig } from './config.ts';
import type { Hub } from './front.ts';
import { allowed, loadKeys, newKey, saveKeys, type Key } from './keys.ts';
import type { Oidc, Signer, User } from './oidc.ts';
import type { ConfigFile } from './config.ts';
import type { Settings } from './settings.ts';
import { configRoutes, type EnvRow } from './ui-config.ts';
import { log, page, type Env, type Fragment } from './ui-layout.ts';

export type { EnvRow };

export type UiAuth = { kind: 'none' } | { kind: 'oidc'; oidc: Oidc; signer: Signer };

export type UiOptions = { keysPath: string; auth: UiAuth; publicUrl?: string; settings?: Settings; configFile?: ConfigFile; environment?: EnvRow[] };


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

  app.get('/', guard, (c) => {
    const saved = c.req.query('saved');
    const editable = !!options.configFile && !options.configFile.readOnlyReason();
    return c.html(page(c, 'Servers', html`${saved ? html`<section class="card notice"><p>Saved <strong>${saved}</strong>; it is restarting with its new settings.</p></section>` : ''}${serversView(hub, editable)}`));
  });

  configRoutes(app, hub, guard, { keysPath, settings: options.settings, configFile: options.configFile, environment: options.environment, base });

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

  app.post('/reload', guard, async (c) => {
    let notice: Fragment;
    try {
      const { added, removed, changed } = await hub.reload();
      const parts = [['added', added], ['removed', removed], ['restarted', changed]].filter(([, names]) => names.length).map(([verb, names]) => `${verb} ${(names as string[]).join(', ')}`);
      notice = html`<section class="card notice"><p>Configuration reloaded: ${parts.length ? parts.join('; ') : 'no changes'}.</p></section>`;
      log(c, 'config_reloaded');
    } catch (e) {
      notice = html`<section class="card notice failed"><p>Configuration not reloaded, the running servers are unchanged:</p><pre class="mono">${(e as Error).message}</pre></section>`;
    }
    return c.html(page(c, 'Servers', html`${notice}${serversView(hub, !!options.configFile && !options.configFile.readOnlyReason())}`));
  });

  app.get('/keys', guard, (c) => c.html(page(c, 'Keys', keysView(hub, loadKeys(keysPath)))));

  app.post('/keys', guard, async (c) => {
    const form = await c.req.parseBody({ all: true });
    const name = String(form.name ?? '').trim();
    if (!name || name.length > 64) return c.text('Bad request: name is required, 64 characters at most', 400);
    const { token, key } = newKey(name, form.kind === 'admin' ? 'admin' : 'client');
    key.scope = scopeFrom(form);
    const keys = loadKeys(keysPath);
    saveKeys(keysPath, [...keys, key]);
    log(c, 'key_created', { key: key.name });
    return c.html(page(c, 'Keys', html`${created(key, token, base(c))}${keysView(hub, [...keys, key])}`));
  });

  app.get('/keys/:id/edit', guard, (c) => {
    const key = loadKeys(keysPath).find((k) => k.id === c.req.param('id'));
    if (!key) return c.text('Not found', 404);
    return c.html(page(c, 'Edit key', html`<section><h1>Edit key ${key.name}</h1>${keyForm(hub, key)}</section>`));
  });

  app.post('/keys/:id', guard, async (c) => {
    const form = await c.req.parseBody({ all: true });
    const name = String(form.name ?? '').trim();
    if (!name || name.length > 64) return c.text('Bad request: name is required, 64 characters at most', 400);
    const keys = loadKeys(keysPath);
    const key = keys.find((k) => k.id === c.req.param('id'));
    if (!key) return c.text('Not found', 404);
    key.name = name;
    key.scope = scopeFrom(form);
    saveKeys(keysPath, keys);
    log(c, 'key_updated', { key: key.name });
    return c.redirect('/keys', 303);
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
      log(c, `key_${action}`, { key: key.name });
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

function scopeFrom(form: Record<string, unknown>): Key['scope'] {
  const servers = ([] as unknown[]).concat(form.servers ?? []).map(String);
  const allow = globs(form.allow);
  const deny = globs(form.deny);
  return {
    servers: servers.length === 0 || servers.includes('*') ? ['*'] : servers,
    tools: { ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}) },
  };
}

/** "3 min ago" style, coarse on purpose: `lastUsed` is only written once an hour. */
function ago(iso: string | null): string {
  if (!iso) return 'never';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return 'within the hour';
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
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

function serversView(hub: Hub, editable: boolean): Fragment {
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
          <a class="button" href="/servers/${name}/edit">${editable ? 'Edit' : 'View'}</a>
          ${config.enabled ? html`<form method="post" action="/servers/${name}/restart"><button>Restart</button></form>` : ''}
        </td>
      </tr>
      ${error ? html`<tr class="error"><td colspan="5">${pkg?.updateError && !upstream.lastError ? 'Update failed: ' : ''}${error}</td></tr>` : ''}`;
  });
  return html`<section id="servers">
      <div class="heading">
        <h1>Servers</h1>
        <div class="buttons">
          ${editable ? html`<a class="button primary" href="/servers/new">Add server</a>` : ''}
          <form method="post" action="/reload"><button title="Re-read the server file and apply the changes">Reload configuration</button></form>
        </div>
      </div>
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
    ${!pkg.pinned && !pkg.updating && pkg.previous && !(newer && pkg.previous === latest)
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
            <thead><tr><th>Name</th><th>Kind</th><th>Servers</th><th>Tools</th><th>Last used</th><th></th></tr></thead>
            <tbody>
              ${keys.map(
                (k) => html`<tr class="${k.enabled ? '' : 'disabled'}">
                  <td><strong>${k.name}</strong><div class="muted mono">${k.prefix}</div></td>
                  <td>${k.kind}${k.enabled ? '' : html` <span class="tag">disabled</span>`}</td>
                  <td>${k.scope.servers.includes('*') ? 'all' : k.scope.servers.join(', ')}</td>
                  <td class="mono">${filter(k)}</td>
                  <td title="Created ${k.created.slice(0, 10)}">${ago(k.lastUsed)}</td>
                  <td class="actions">
                    <a class="button" href="/keys/${k.id}/edit">Edit</a>
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
      ${keyForm(hub)}
    </section>`;
}

function keyForm(hub: Hub, key?: Key): Fragment {
  const scope = key?.scope ?? { servers: ['*'], tools: {} };
  const all = scope.servers.includes('*');
  const servers = [...new Set([...hub.upstreams.keys(), ...scope.servers.filter((s) => s !== '*')])];
  return html`<form method="post" action="${key ? `/keys/${key.id}` : '/keys'}" class="card">
    <label>Name <input name="name" required maxlength="64" placeholder="laptop-claude-code" value="${key?.name ?? ''}" /></label>
    ${key
      ? html`<p class="muted">Kind: ${key.kind}. The token does not change; create a new key to rotate it.</p>`
      : html`<label>Kind
          <select name="kind"><option value="client">client: uses /mcp</option><option value="admin">admin: management endpoint</option></select>
        </label>`}
    <fieldset>
      <legend>Servers</legend>
      <label class="check"><input type="checkbox" name="servers" value="*" ${all ? 'checked' : ''} /> All, including future ones</label>
      ${servers.map((s) => html`<label class="check"><input type="checkbox" name="servers" value="${s}" ${!all && scope.servers.includes(s) ? 'checked' : ''} /> ${s}${hub.upstreams.has(s) ? '' : html` <span class="muted">(not in the configuration)</span>`}</label>`)}
    </fieldset>
    <label>Allow tools <input name="allow" placeholder="mail-*, calendar-list_*" value="${scope.tools.allow?.join(', ') ?? ''}" /><span class="muted">Globs on exposed names, empty for all.</span></label>
    <label>Deny tools <input name="deny" placeholder="*-delete_*" value="${scope.tools.deny?.join(', ') ?? ''}" /></label>
    <div class="buttons"><button class="primary">${key ? 'Save' : 'Create key'}</button>${key ? html`<a class="button" href="/keys">Cancel</a>` : ''}</div>
  </form>`;
}

function created(key: Key, token: string, base: string): Fragment {
  return html`<section class="card notice">
    <h2>Key ${key.name} created</h2>
    <p>Copy the token now: it is shown once and only its hash is stored.</p>
    <pre class="mono">${token}</pre>
    <p>Claude Code:</p>
    <pre class="mono">claude mcp add --transport http ${key.kind === 'admin' ? 'mcpyard-admin' : 'mcpyard'} ${base}${key.kind === 'admin' ? '/admin/mcp' : '/mcp'} --header "Authorization: Bearer ${token}"</pre>
  </section>`;
}

function signedOut(message: string): Fragment {
  return html`<section class="card"><p>${message}</p><a class="button primary" href="/auth/login">Sign in</a></section>`;
}
