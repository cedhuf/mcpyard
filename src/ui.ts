import { Hono, type Context, type Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { randomBytes } from 'node:crypto';
import type { ConfigFile, ServerConfig } from './config.ts';
import type { Hub, PackageStatus } from './front.ts';
import { allowed } from './keys.ts';
import type { Oidc, Signer, User } from './oidc.ts';
import type { Settings } from './settings.ts';
import type { Upstream } from './upstream.ts';
import { configRoutes, type EnvRow } from './ui-config.ts';
import { keyRoutes } from './ui-keys.ts';
import { actions, alert, badge, empty, linkButton, pageHead, panel, postButton } from './ui-kit.ts';
import { icon, log, page, stylesheet, toast, type Env, type Fragment } from './ui-layout.ts';

export type { EnvRow };

export type UiAuth = { kind: 'none' } | { kind: 'oidc'; oidc: Oidc; signer: Signer };

export type UiOptions = { keysPath: string; auth: UiAuth; publicUrl?: string; settings?: Settings; configFile?: ConfigFile; environment?: EnvRow[] };

const SESSION = 'mcpyard_session';
const LOGIN = 'mcpyard_login';
const VIEW = 'mcpyard_view';
const SESSION_HOURS = 12;

type View = 'cards' | 'list';

export function ui(hub: Hub, options: UiOptions): Hono<Env> {
  const app = new Hono<Env>();
  const { auth, keysPath } = options;
  const secure = (c: Context) => new URL(options.publicUrl ?? c.req.url).protocol === 'https:';
  const base = (c: Context) => (options.publicUrl ?? new URL(c.req.url).origin).replace(/\/$/, '');
  const editable = () => !!options.configFile && !options.configFile.readOnlyReason();

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
    const avatar = c.get('user')?.picture;
    const imgSrc = ['\'self\'', 'data:', ...(avatar ? [new URL(avatar).origin] : [])].join(' ');
    c.header('Content-Security-Policy', `default-src 'none'; style-src 'self' 'unsafe-inline'; img-src ${imgSrc}; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'`);
    c.header('Referrer-Policy', 'same-origin');
    await next();
  };

  app.get('/assets/ui.css', (c) => {
    const gzip = /\bgzip\b/.test(c.req.header('accept-encoding') ?? '');
    c.header('Content-Type', 'text/css; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Vary', 'Accept-Encoding');
    if (gzip) c.header('Content-Encoding', 'gzip');
    const sheet = stylesheet();
    return c.body(new Uint8Array(gzip ? sheet.gzip : sheet.body));
  });

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
        return c.html(page(c, 'Sign-in failed', signedOut(`Sign-in failed: ${(e as Error).message}`, true), { bare: true }), 403);
      }
    });

    app.post('/auth/logout', guard, (c) => {
      deleteCookie(c, SESSION, { path: '/' });
      return c.html(page(c, 'Signed out', signedOut('You are signed out.'), { bare: true }));
    });
  }

  const view = (c: Context<Env>): View => {
    const asked = c.req.query('view');
    if (asked === 'cards' || asked === 'list') {
      setCookie(c, VIEW, asked, { path: '/', httpOnly: true, sameSite: 'Lax', secure: secure(c), maxAge: 365 * 86400 });
      return asked;
    }
    return getCookie(c, VIEW) === 'list' ? 'list' : 'cards';
  };

  app.get('/', guard, (c) => {
    const saved = c.req.query('saved');
    const notice = saved ? toast(html`Saved <strong>${saved}</strong>; it is restarting with its new settings.`) : '';
    return c.html(page(c, 'Servers', html`${serversView(hub, editable(), view(c))}${notice}`));
  });

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
      const parts = [
        ['added', added],
        ['removed', removed],
        ['restarted', changed],
      ]
        .filter(([, names]) => names!.length)
        .map(([verb, names]) => `${verb} ${(names as string[]).join(', ')}`);
      notice = toast(`Configuration reloaded: ${parts.length ? parts.join('; ') : 'no changes'}.`);
      log(c, 'config_reloaded');
    } catch (e) {
      notice = alert(html`<div class="font-medium">Configuration not reloaded, the running servers are unchanged:</div><pre class="mono">${(e as Error).message}</pre>`, 'error');
    }
    return c.html(page(c, 'Servers', html`${notice}${serversView(hub, editable(), view(c))}`));
  });

  configRoutes(app, hub, guard, { keysPath, settings: options.settings, configFile: options.configFile, environment: options.environment, base });
  keyRoutes(app, hub, guard, { keysPath, base });

  return app;
}

function sameOrigin(origin: string | undefined, base: string): boolean {
  try {
    return !!origin && new URL(origin).host === new URL(base).host;
  } catch {
    return false;
  }
}

function signedOut(message: string, failed = false): Fragment {
  return panel(html`${alert(message, failed ? 'error' : 'info')}<a class="btn btn-primary w-full" href="/auth/login">Sign in</a>`);
}

type Row = { name: string; config: ServerConfig; upstream: Upstream; pkg?: PackageStatus };

const STATE_TONE: Record<string, 'success' | 'warning' | 'error' | 'info' | 'neutral'> = {
  ready: 'success',
  degraded: 'warning',
  failed: 'error',
  installing: 'info',
  starting: 'info',
  updating: 'info',
  stopped: 'neutral',
  disabled: 'neutral',
};
const BUSY = ['installing', 'starting', 'updating', 'degraded'];

function source(config: ServerConfig): string {
  if (config.package) return config.package.npm ? `npm · ${config.package.npm}` : `pypi · ${config.package.pypi}`;
  if (config.url) return config.url;
  return [config.command, ...config.args].join(' ');
}

function kindIcon(config: ServerConfig): Fragment {
  return html`<div class="kind-icon" title="${config.package ? 'Package' : config.url ? 'Remote URL' : 'Command'}">${icon(config.package ? 'package' : config.url ? 'globe' : 'terminal')}</div>`;
}

function stateOf(row: Row): string {
  return row.pkg?.updating ? 'updating' : row.config.enabled ? row.upstream.state : 'disabled';
}

function stateBadge(state: string, label: string = state): Fragment {
  const tone = STATE_TONE[state] ?? 'neutral';
  return badge(html`<span class="status status-${tone} ${BUSY.includes(state) ? 'pulse' : ''}"></span>${label}`, { tone, soft: true, className: 'gap-2' });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function newerVersion(pkg: PackageStatus | undefined): string | undefined {
  const latest = pkg?.latest?.version;
  return pkg && !pkg.pinned && latest && pkg.installed && latest !== pkg.installed ? latest : undefined;
}

function toolsSummary(row: Row): Fragment {
  const { upstream, config } = row;
  if (!upstream.tools.length) return html`<span class="muted">none yet</span>`;
  const hidden = upstream.tools.filter((t) => !allowed(t.name, config.tools)).length;
  return html`${plural(upstream.tools.length - hidden, 'tool')}${hidden ? html` <span class="muted">· ${hidden} hidden</span>` : ''}`;
}

function toolsList(row: Row): Fragment {
  return html`<div class="tools-list">${row.upstream.tools.map((t) =>
    badge(`${row.name}-${t.name}`, { mono: true, title: t.description, className: allowed(t.name, row.config.tools) ? '' : 'off' }),
  )}</div>`;
}

function version(pkg: PackageStatus | undefined): Fragment {
  if (!pkg) return html`<span class="muted">not a package</span>`;
  return html`<span class="mono">${pkg.installed ?? '...'}</span>${pkg.pinned ? badge('pinned', { icon: 'pin', small: true, title: 'Pinned in the server file' }) : ''}`;
}

/** The update and rollback offers of a hub-owned package; nothing for pinned ones. */
function versionActions(row: Row): Fragment {
  const pkg = row.pkg;
  if (!pkg || pkg.pinned || pkg.updating) return html``;
  const newer = newerVersion(pkg);
  return html`${newer
    ? html`<div class="callout update">${icon('up', 'sm')}<span class="grow"><strong>${newer}</strong> available</span>
        ${postButton(`/servers/${row.name}/update`, 'Update', { tone: 'soft', size: 'sm', fields: { version: newer } })}</div>`
    : ''}
  ${pkg.previous && pkg.previous !== newer ? postButton(`/servers/${row.name}/update`, `Roll back to ${pkg.previous}`, { size: 'xs', icon: 'undo', fields: { version: pkg.previous } }) : ''}`;
}

function errorOf(row: Row): Fragment {
  const error = row.upstream.lastError ?? row.pkg?.updateError;
  if (!error) return html``;
  const prefix = row.pkg?.updateError && !row.upstream.lastError ? 'Update failed: ' : '';
  return html`<div class="callout error">${icon('alert', 'sm')}<span class="grow">${prefix}${error}</span></div>`;
}

function rowActions(row: Row, editable: boolean): Fragment {
  return actions(html`${linkButton(`/servers/${row.name}/edit`, editable ? 'Edit' : 'View', { size: 'sm', icon: 'pencil' })}
    ${row.config.enabled ? postButton(`/servers/${row.name}/restart`, 'Restart', { size: 'sm', icon: 'rotate' }) : ''}`);
}

function card(row: Row, editable: boolean): Fragment {
  return html`<article class="card card-border srv">
    <div class="card-body">
      <div class="srv-top">
        ${kindIcon(row.config)}
        <div class="srv-title"><h3><strong>${row.name}</strong></h3><p class="mono muted truncate" title="${source(row.config)}">${source(row.config)}</p></div>
        ${stateBadge(stateOf(row))}
      </div>
      <dl>
        <div><dt>Version</dt><dd>${version(row.pkg)}</dd></div>
        <div><dt>Tools</dt><dd>${row.upstream.tools.length
          ? html`<div class="tools"><label class="tools-toggle"><input type="checkbox" class="hidden-radio" data-id="card-${row.name}" />${toolsSummary(row)}</label><div class="tools-wrap"><div>${toolsList(row)}</div></div></div>`
          : toolsSummary(row)}</dd></div>
      </dl>
      ${versionActions(row)}${errorOf(row)}
      ${rowActions(row, editable)}
    </div>
  </article>`;
}

function listRow(row: Row, editable: boolean): Fragment {
  const newer = newerVersion(row.pkg);
  return html`<div class="acc">
    <label class="acc-title">
      <input type="checkbox" class="hidden-radio" data-id="row-${row.name}" aria-label="Details of ${row.name}" />
      ${kindIcon(row.config)}
      <span class="min-w-0"><strong>${row.name}</strong><span class="mono muted truncate block">${source(row.config)}</span></span>
      <span>${stateBadge(stateOf(row))}</span>
      <span class="row-wrap hide-sm">${version(row.pkg)}${newer ? badge(newer, { tone: 'primary', soft: true, small: true, icon: 'up' }) : ''}</span>
      <span class="hide-sm">${toolsSummary(row)}</span>
      <span class="chevron" aria-hidden="true"></span>
    </label>
    <div class="acc-wrap"><div><div class="acc-body">
      ${errorOf(row)}
      ${row.upstream.tools.length ? toolsList(row) : ''}
      ${versionActions(row)}
      ${rowActions(row, editable)}
    </div></div></div>
  </div>`;
}

function serversView(hub: Hub, editable: boolean, view: View): Fragment {
  const packages = hub.packageStatus();
  const rows: Row[] = [...hub.upstreams].map(([name, upstream]) => ({ name, upstream, config: hub.configs[name]!, pkg: packages[name] }));
  const count = (state: string) => rows.filter((r) => stateOf(r) === state).length;
  const updates = rows.filter((r) => newerVersion(r.pkg)).length;
  const summary = ['ready', 'starting', 'installing', 'updating', 'degraded', 'failed', 'disabled'].filter((s) => count(s)).map((s) => stateBadge(s, `${count(s)} ${s}`));
  const layout = html`<div class="join" role="group" aria-label="Layout">
    <a class="btn btn-sm join-item ${view === 'cards' ? 'btn-active' : 'btn-ghost'}" href="/?view=cards" title="Cards" aria-label="Cards">${icon('grid', 'sm')}</a>
    <a class="btn btn-sm join-item ${view === 'list' ? 'btn-active' : 'btn-ghost'}" href="/?view=list" title="List" aria-label="List">${icon('list', 'sm')}</a>
  </div>`;
  return html`<section id="servers">
    ${pageHead('Servers', {
      below: html`${summary}${updates ? badge(plural(updates, 'update'), { tone: 'primary', soft: true, icon: 'up' }) : ''}`,
      actions: html`${layout}
        ${postButton('/reload', 'Reload configuration', { size: 'sm', icon: 'refresh', title: 'Re-read the server file and apply the changes' })}
        ${editable ? linkButton('/servers/new', 'Add server', { tone: 'primary', size: 'sm', icon: 'plus' }) : ''}`,
    })}
    ${!rows.length
      ? empty(editable ? html`No servers yet. <a class="link link-primary" href="/servers/new">Add the first one</a>.` : 'No servers yet. Declare them in the server file and reload.')
      : view === 'list'
        ? html`<div class="list">${rows.map((r) => listRow(r, editable))}</div>`
        : html`<div class="cards">${rows.map((r) => card(r, editable))}</div>`}
  </section>`;
}
