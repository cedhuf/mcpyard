import { Hono, type Context, type Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/** The logo files, public like the stylesheet: browsers fetch them before any sign-in. */
const STATIC_FILES = [
  ['/favicon.ico', 'image/x-icon'],
  ['/favicon-16x16.png', 'image/png'],
  ['/favicon-32x32.png', 'image/png'],
  ['/apple-touch-icon.png', 'image/png'],
] as const;

const SESSION = 'mcpyard_session';
const LOGIN = 'mcpyard_login';
const VIEW = 'mcpyard_view';
const SESSION_HOURS = 12;

type View = 'cards' | 'list';
const FILTERS = ['all', 'online', 'failed', 'disabled'] as const;
type FilterState = (typeof FILTERS)[number];
type Filter = { state: FilterState; q: string };

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

  for (const [path, type] of STATIC_FILES) {
    const body = readFileSync(fileURLToPath(new URL(`../static${path}`, import.meta.url)));
    app.get(path, (c) => {
      c.header('Content-Type', type);
      c.header('Cache-Control', 'public, max-age=604800');
      return c.body(new Uint8Array(body));
    });
  }

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

  /** Back to the servers page the action came from, keeping its filters. */
  const back = (c: Context<Env>) => c.redirect(c.req.header('referer')?.match(/^https?:\/\/[^/]+(\/(?:\?[^#]*)?)$/)?.[1] ?? '/', 303);

  const filter = (c: Context<Env>): Filter => {
    const state = c.req.query('state');
    return { state: FILTERS.includes(state as FilterState) ? (state as FilterState) : 'all', q: (c.req.query('q') ?? '').trim() };
  };

  app.get('/', guard, (c) => {
    const saved = c.req.query('saved');
    const notice = saved ? toast(html`Saved <strong>${saved}</strong>; it is restarting with its new settings.`) : '';
    return c.html(page(c, 'Servers', html`${serversView(hub, editable(), view(c), filter(c))}${notice}`));
  });

  for (const action of ['enable', 'disable'] as const) {
    app.post(`/servers/:name/${action}`, guard, async (c) => {
      const name = c.req.param('name') ?? '';
      if (!hub.configs[name]) return c.text('Not found', 404);
      await hub.setDisabled(name, action === 'disable');
      log(c, `server_${action}d`, { server: name });
      return back(c);
    });
  }

  app.post('/servers/:name/update', guard, async (c) => {
    const name = c.req.param('name') ?? '';
    const { version } = await c.req.parseBody();
    if (!hub.upstreams.has(name)) return c.text('Not found', 404);
    // Installing can take minutes: the page polls and shows progress or the error.
    const target = typeof version === 'string' && version ? version : undefined;
    hub.update(name, target).catch((e: Error) => console.error(`[${name}] update failed: ${e.message}`));
    log(c, 'package_update', { server: name, ...(target ? { version: target } : {}) });
    return back(c);
  });

  app.post('/servers/:name/restart', guard, async (c) => {
    const name = c.req.param('name') ?? '';
    if (!hub.upstreams.has(name)) return c.text('Not found', 404);
    void hub.restart(name);
    log(c, 'server_restarted', { server: name });
    return back(c);
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
    return c.html(page(c, 'Servers', html`${notice}${serversView(hub, editable(), view(c), { state: 'all', q: '' })}`));
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

type Row = { name: string; config: ServerConfig; upstream: Upstream; pkg?: PackageStatus; uiDisabled: boolean };

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
const GROUP: Record<FilterState, (state: string) => boolean> = {
  all: () => true,
  online: (s) => s === 'ready' || s === 'updating',
  failed: (s) => s === 'failed' || s === 'degraded',
  disabled: (s) => s === 'disabled',
};

function source(config: ServerConfig): string {
  if (config.package) return config.package.npm ?? config.package.pypi!;
  if (config.url) return config.url;
  return [config.command, ...config.args].join(' ');
}

function transport(config: ServerConfig): string {
  if (config.package) return config.package.npm ? 'npm' : 'PyPI';
  if (config.url) return config.transport === 'sse' ? 'SSE' : 'HTTP';
  return 'STDIO';
}

function stateOf(row: Row): string {
  return row.pkg?.updating ? 'updating' : !row.config.enabled || row.uiDisabled ? 'disabled' : row.upstream.state;
}

function stateBadge(state: string, label: string = state): Fragment {
  const tone = STATE_TONE[state] ?? 'neutral';
  return html`<span class="state state-${tone}"><span class="status status-${tone} ${BUSY.includes(state) ? 'pulse' : ''}"></span>${label}</span>`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function newerVersion(pkg: PackageStatus | undefined): string | undefined {
  const latest = pkg?.latest?.version;
  return pkg && !pkg.pinned && latest && pkg.installed && latest !== pkg.installed ? latest : undefined;
}

function toolCounts(row: Row): { visible: number; total: number } {
  const total = row.upstream.tools.length;
  return { visible: row.upstream.tools.filter((t) => allowed(t.name, row.config.tools)).length, total };
}

function toolsCell(row: Row): Fragment {
  const { visible, total } = toolCounts(row);
  return html`<span class="meta" title="${total ? `${visible} of ${total} tools exposed` : 'No tools yet'}">${icon('wrench', 'xs')}${total ? `${visible}/${total}` : '0'}</span>`;
}

/** On/off switch: a one-button form, so it works without any script. */
function enableSwitch(row: Row): Fragment {
  if (!row.config.enabled) {
    return html`<span class="switch locked" title="Disabled in the server file">${icon('lock', 'xs')}</span>`;
  }
  const on = !row.uiDisabled;
  return html`<form method="post" action="/servers/${row.name}/${on ? 'disable' : 'enable'}" class="inline-form">
    <button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}" title="${on ? 'Disable' : 'Enable'} ${row.name}" aria-label="${on ? 'Disable' : 'Enable'} ${row.name}"></button>
  </form>`;
}

/** The row's actions in a dropdown that needs no script: a details element. */
function actionsMenu(row: Row, editable: boolean): Fragment {
  const pkg = row.pkg;
  const newer = newerVersion(pkg);
  const item = (action: string, label: string, name: string, extra: { fields?: Record<string, string>; confirm?: string; danger?: boolean } = {}) =>
    html`<li><form method="post" action="${action}" ${extra.confirm ? html`data-confirm="${extra.confirm}"` : ''}>${Object.entries(extra.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}<button class="${extra.danger ? 'text-error' : ''}">${icon(name, 'sm')}${label}</button></form></li>`;
  return html`<details class="dropdown dropdown-end">
    <summary class="btn btn-ghost btn-sm btn-square" aria-label="Actions for ${row.name}">${icon('dots')}</summary>
    <ul class="dropdown-content menu srv-menu">
      <li><a href="/servers/${row.name}/edit">${icon('pencil', 'sm')}${editable ? 'Edit' : 'View settings'}</a></li>
      ${row.config.enabled && !row.uiDisabled ? item(`/servers/${row.name}/restart`, 'Restart', 'rotate') : ''}
      ${newer && !pkg!.updating ? item(`/servers/${row.name}/update`, `Update to ${newer}`, 'up', { fields: { version: newer } }) : ''}
      ${pkg && !pkg.pinned && !pkg.updating && pkg.previous && pkg.previous !== newer ? item(`/servers/${row.name}/update`, `Roll back to ${pkg.previous}`, 'undo', { fields: { version: pkg.previous } }) : ''}
      ${editable ? html`<li aria-hidden="true"><hr /></li>${item(`/servers/${row.name}/delete`, 'Remove', 'trash', { confirm: `Remove ${row.name} from the server file? It stops now.`, danger: true })}` : ''}
    </ul>
  </details>`;
}

function errorOf(row: Row): Fragment {
  const error = row.upstream.lastError ?? row.pkg?.updateError;
  if (!error || stateOf(row) === 'disabled') return html``;
  const prefix = row.pkg?.updateError && !row.upstream.lastError ? 'Update failed: ' : '';
  return html`<div class="callout error">${icon('alert', 'sm')}<span class="grow">${prefix}${error}</span></div>`;
}

function updateCallout(row: Row): Fragment {
  const newer = newerVersion(row.pkg);
  if (!newer || row.pkg!.updating) return html``;
  return html`<div class="callout update">${icon('up', 'sm')}<span class="grow"><strong>${newer}</strong> is available</span>
    ${postButton(`/servers/${row.name}/update`, 'Update', { tone: 'soft', size: 'sm', fields: { version: newer } })}</div>`;
}

function versionBadge(row: Row): Fragment {
  const pkg = row.pkg;
  if (!pkg?.installed) return html``;
  return badge(`v${pkg.installed}`, { mono: true, small: true, icon: pkg.pinned ? 'pin' : undefined, title: pkg.pinned ? 'Pinned in the server file' : 'Version owned by the hub' });
}

/** Tool names and descriptions, folded by default and scrollable once open: some servers have dozens. */
function toolsSection(row: Row): Fragment {
  const { visible, total } = toolCounts(row);
  if (!total) return html``;
  return html`<div class="fold">
    <label class="fold-toggle"><input type="checkbox" class="hidden-radio" data-id="tools-${row.name}" />${icon('wrench', 'xs')}<span>Show ${plural(total, 'tool')}${visible < total ? html` <span class="muted" title="Hidden by the server file">(${total - visible} hidden)</span>` : ''}</span><span class="chevron sm" aria-hidden="true"></span></label>
    <div class="acc-wrap"><div><div class="tools-scroll"><table class="tools-table">
      ${row.upstream.tools.map((t) => {
        const shown = allowed(t.name, row.config.tools);
        return html`<tr class="${shown ? '' : 'off'}"><td class="mono">${row.name}-${t.name}</td><td class="desc" title="${t.description ?? ''}">${t.description ?? ''}</td></tr>`;
      })}
    </table></div></div></div>
  </div>`;
}

function details(row: Row): Fragment {
  const pkg = row.pkg;
  const { visible, total } = toolCounts(row);
  return html`<div class="facts">
      <span>${icon('wrench', 'xs')}Tools <strong>${visible}/${total}</strong></span>
      <span>${icon(row.config.package ? 'package' : row.config.url ? 'globe' : 'terminal', 'xs')}<span class="mono truncate">${row.config.package ? `${transport(row.config)} · ` : ''}${source(row.config)}</span></span>
      ${pkg ? html`<span>${icon('pin', 'xs')}${pkg.pinned ? 'Pinned' : 'Hub-owned'}${pkg.latest?.version && !newerVersion(pkg) ? html` · <span class="muted">up to date</span>` : ''}</span>` : ''}
      ${row.uiDisabled ? html`<span>${icon('power', 'xs')}Switched off from the UI</span>` : ''}
    </div>
    ${errorOf(row)}${updateCallout(row)}${toolsSection(row)}`;
}

function listRow(row: Row, editable: boolean): Fragment {
  const newer = newerVersion(row.pkg);
  return html`<div class="acc srow ${stateOf(row) === 'disabled' ? 'is-off' : ''}">
    <div class="srow-head">
      <label class="srow-main">
        <input type="checkbox" class="hidden-radio" data-id="row-${row.name}" aria-label="Details of ${row.name}" />
        <span class="chevron side" aria-hidden="true"></span>
        <span class="srow-name"><strong class="mono">${row.name}</strong>${versionBadge(row)}</span>
        <span>${stateBadge(stateOf(row))}</span>
        <span class="hide-sm"><span class="kind-tag">${transport(row.config)}</span></span>
        <span class="hide-sm">${toolsCell(row)}</span>
        <span class="hide-sm">${newer ? badge(`${newer} available`, { tone: 'primary', soft: true, small: true, icon: 'up' }) : ''}</span>
      </label>
      <div class="srow-controls">${enableSwitch(row)}${actionsMenu(row, editable)}</div>
    </div>
    <div class="acc-wrap"><div><div class="srow-body">${details(row)}</div></div></div>
  </div>`;
}

function card(row: Row, editable: boolean): Fragment {
  return html`<article class="card card-border srv ${stateOf(row) === 'disabled' ? 'is-off' : ''}">
    <div class="card-body">
      <div class="srv-top">
        <div class="srv-title"><h3><strong class="mono">${row.name}</strong>${versionBadge(row)}</h3><p class="mono muted truncate" title="${source(row.config)}">${source(row.config)}</p></div>
        ${enableSwitch(row)}
      </div>
      <div class="row-wrap">${stateBadge(stateOf(row))}<span class="kind-tag">${transport(row.config)}</span>${toolsCell(row)}</div>
      ${errorOf(row)}${updateCallout(row)}
      <div class="card-foot">${toolsSection(row)}${actionsMenu(row, editable)}</div>
    </div>
  </article>`;
}

function serversView(hub: Hub, editable: boolean, view: View, filter: Filter): Fragment {
  const packages = hub.packageStatus();
  const all: Row[] = [...hub.upstreams].map(([name, upstream]) => ({ name, upstream, config: hub.configs[name]!, pkg: packages[name], uiDisabled: hub.isDisabled(name) }));
  const count = (f: FilterState) => all.filter((r) => GROUP[f](stateOf(r))).length;
  const q = filter.q.toLowerCase();
  const rows = all.filter((r) => GROUP[filter.state](stateOf(r)) && (!q || r.name.toLowerCase().includes(q) || source(r.config).toLowerCase().includes(q)));
  const updates = all.filter((r) => newerVersion(r.pkg)).length;
  const link = (state: FilterState) => `/?state=${state}${filter.q ? `&q=${encodeURIComponent(filter.q)}` : ''}`;
  const layout = html`<div class="join" role="group" aria-label="Layout">
    <a class="btn btn-sm join-item ${view === 'cards' ? 'btn-active' : 'btn-ghost'}" href="/?view=cards" title="Cards" aria-label="Cards">${icon('grid', 'sm')}</a>
    <a class="btn btn-sm join-item ${view === 'list' ? 'btn-active' : 'btn-ghost'}" href="/?view=list" title="List" aria-label="List">${icon('list', 'sm')}</a>
  </div>`;
  return html`<section id="servers">
    ${pageHead('Servers', {
      subtitle: html`${plural(all.length, 'server')} · ${count('online')} online · ${count('failed')} failing · ${count('disabled')} off${updates ? html` · <span class="text-primary">${plural(updates, 'update')}</span>` : ''}`,
      actions: html`${postButton('/reload', 'Reload', { size: 'sm', icon: 'refresh', title: 'Re-read the server file and apply the changes' })}
        ${editable ? linkButton('/servers/new', 'Add server', { tone: 'primary', size: 'sm', icon: 'plus' }) : ''}`,
    })}
    <div class="toolbar">
      <div role="tablist" class="tabs tabs-box tabs-sm">
        ${FILTERS.map((f) => html`<a role="tab" class="tab ${filter.state === f ? 'tab-active' : ''}" href="${link(f)}">${f[0]!.toUpperCase()}${f.slice(1)} <span class="tab-count">${count(f)}</span></a>`)}
      </div>
      <form method="get" action="/" class="search">
        ${filter.state !== 'all' ? html`<input type="hidden" name="state" value="${filter.state}" />` : ''}
        <label class="input input-sm">${icon('search', 'sm')}<input type="search" name="q" value="${filter.q}" placeholder="Search by name or package" /></label>
      </form>
      <div class="grow"></div>
      ${layout}
    </div>
    ${!all.length
      ? empty(editable ? html`No servers yet. <a class="link link-primary" href="/servers/new">Add the first one</a>.` : 'No servers yet. Declare them in the server file and reload.')
      : !rows.length
        ? empty('No server matches this filter.')
        : view === 'list'
          ? html`<div class="list">${rows.map((r) => listRow(r, editable))}</div>`
          : html`<div class="cards">${rows.map((r) => card(r, editable))}</div>`}
    ${rows.length && rows.length !== all.length ? html`<p class="muted text-sm mt-4">Showing ${rows.length} of ${all.length}.</p>` : ''}
  </section>`;
}
