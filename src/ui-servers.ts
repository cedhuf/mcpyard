import { html } from 'hono/html';
import type { ServerConfig } from './config.ts';
import { newerVersion, type Hub, type PackageStatus } from './front.ts';
import { allowed } from './keys.ts';
import type { Upstream } from './upstream.ts';
import { box, cell, chips, hero, ROW, ROW_ANCHOR, ROW_END, type Content, empty, linkButton, list, menu, type MenuEntry, note, onOff, pageHead, postButton, row as item, segLinks, status, tabs, tag, title, toolbar, type Tone } from './ui-kit.ts';
import { mascot, type Mood } from './ui-icons.ts';
import { icon, type Fragment } from './ui-layout.ts';

export type View = 'cards' | 'list';
export const FILTERS = ['all', 'online', 'failed', 'disabled'] as const;
export type FilterState = (typeof FILTERS)[number];
export type Filter = { state: FilterState; q: string };

export type Row = { name: string; config: ServerConfig; upstream: Upstream; pkg?: PackageStatus; uiDisabled: boolean };

const STATE_TONE: Record<string, Tone> = {
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
  return 'Command';
}

function stateOf(row: Row): string {
  return row.pkg?.updating ? 'updating' : !row.config.enabled || row.uiDisabled ? 'disabled' : row.upstream.state;
}

function stateLabel(row: Row): Fragment {
  const state = stateOf(row);
  return status(STATE_TONE[state] ?? 'neutral', state[0]!.toUpperCase() + state.slice(1), { busy: BUSY.includes(state) });
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}


function toolCounts(row: Row): { visible: number; total: number } {
  const total = row.upstream.tools.length;
  return { visible: row.upstream.tools.filter((t) => allowed(t.name, row.config.tools)).length, total };
}

function toolsText(row: Row): string {
  const { visible, total } = toolCounts(row);
  return !total ? 'no tools' : visible === total ? plural(total, 'tool') : `${visible} of ${plural(total, 'tool')}`;
}

function version(row: Row): string | undefined {
  return row.pkg?.installed ? `v${row.pkg.installed}` : undefined;
}

function enableSwitch(row: Row): Fragment {
  const on = !row.uiDisabled;
  return onOff(`/servers/${row.name}/${on ? 'disable' : 'enable'}`, on, `${on ? 'Switch off' : 'Switch on'} ${row.name}`, row.config.enabled ? undefined : 'Disabled in the server file');
}

function actions(row: Row, editable: boolean, options: { settings?: boolean } = {}): (MenuEntry | false)[] {
  const pkg = row.pkg;
  const newer = newerVersion(pkg);
  const base = `/servers/${row.name}`;
  return [
    options.settings !== false && { href: `${base}/edit`, label: editable ? 'Edit settings' : 'View settings', icon: 'pencil' },
    row.config.enabled && !row.uiDisabled && { post: `${base}/restart`, label: 'Restart', icon: 'rotate' },
    !!newer && !pkg!.updating && { post: `${base}/update`, value: ['version', newer], label: `Update to ${newer}`, icon: 'up' },
    !!pkg?.previous && !pkg.pinned && !pkg.updating && pkg.previous !== newer && { post: `${base}/update`, value: ['version', pkg.previous], label: `Roll back to ${pkg.previous}`, icon: 'undo' },
    editable && { post: `${base}/delete`, label: 'Remove', icon: 'trash', danger: true, confirm: `Remove ${row.name} from the server file? It stops now.` },
  ];
}

function controls(row: Row, editable: boolean, options: { settings?: boolean } = {}): Fragment {
  return html`${enableSwitch(row)}${menu(`server-${row.name}`, `Actions for ${row.name}`, actions(row, editable, options))}`;
}

function signInUrl(row: Row): URL | undefined {
  return row.upstream.state === 'failed' ? row.upstream.auth?.signInUrl : undefined;
}

/** The error or the available update, as one line each. */
function notes(row: Row): Fragment {
  const signIn = signInUrl(row);
  if (signIn) return note(html`<strong>${row.name}</strong> needs you to sign in with its provider. Its tokens are then kept and refreshed by the hub.`, 'warning', linkButton(signIn.href, 'Sign in', { tone: 'primary' }));
  const error = row.upstream.lastError ?? row.pkg?.updateError;
  const newer = newerVersion(row.pkg);
  return html`${error && stateOf(row) !== 'disabled' ? note(html`${row.pkg?.updateError && !row.upstream.lastError ? 'Update failed: ' : ''}<span class="font-mono">${error}</span>`, 'error') : ''}
    ${newer && !row.pkg!.updating ? note(html`Version <strong>${newer}</strong> is available.`, 'info', postButton(`/servers/${row.name}/update`, 'Update', { tone: 'primary', fields: { version: newer } })) : ''}`;
}

function listRow(row: Row, editable: boolean): Fragment {
  const newer = newerVersion(row.pkg);
  const meta = [transport(row.config), version(row), toolsText(row)].filter(Boolean).join(' · ');
  return item(
    html`${title(serverLabel(row.name, row.config), html`<span class="lg:hidden">${meta}</span><span class="max-lg:hidden font-mono">${source(row.config)}</span>`, { href: `/servers/${row.name}` })}
      ${cell(stateLabel(row))}
      ${cell(tag(transport(row.config)), { hide: true })}
      ${cell(version(row) ? html`<span class="inline-flex items-center gap-1 font-mono">${version(row)}${row.pkg?.pinned ? icon('pin', 'xs') : ''}</span>` : html`<span class="opacity-40">none</span>`, { hide: true })}
      ${cell(toolsText(row), { hide: true })}
      ${cell(newer ? tag(`${newer} available`, { tone: 'primary', icon: 'up' }) : '', { hide: true })}`,
    { end: controls(row, editable), off: stateOf(row) === 'disabled' },
  );
}

function tile(row: Row, editable: boolean): Fragment {
  const newer = newerVersion(row.pkg);
  const off = stateOf(row) === 'disabled';
  return html`<article class="${ROW} card card-border border-base-300 bg-base-100 hover:border-base-content/20 transition-colors">
    <div class="card-body p-4 gap-2">
      <div class="flex items-center gap-2">
        <a class="${ROW_ANCHOR} flex-1 min-w-0 truncate font-semibold ${off ? 'opacity-50' : ''}" href="/servers/${row.name}">${serverLabel(row.name, row.config)}</a>
        <div class="${ROW_END} flex items-center gap-1">${controls(row, editable)}</div>
      </div>
      <p class="font-mono text-xs text-base-content/50 truncate" title="${source(row.config)}">${source(row.config)}</p>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-base-content/70">
        ${stateLabel(row)}<span class="opacity-40">·</span>${transport(row.config)}
        ${version(row) ? html`<span class="opacity-40">·</span><span class="font-mono">${version(row)}</span>` : ''}
        <span class="opacity-40">·</span>${toolsText(row)}
      </div>
      ${newer ? html`<div>${tag(`${newer} available`, { tone: 'primary', icon: 'up' })}</div>` : ''}
      ${row.upstream.lastError && !off ? html`<p class="font-mono text-xs text-error truncate" title="${row.upstream.lastError}">${row.upstream.lastError}</p>` : ''}
    </div>
  </article>`;
}

export function serversView(hub: Hub, editable: boolean, view: View, filter: Filter): Fragment {
  const all = [...hub.upstreams.keys()].map((name) => rowOf(hub, name)!);
  const count = (f: FilterState) => all.filter((r) => GROUP[f](stateOf(r))).length;
  const q = filter.q.toLowerCase();
  const rows = all.filter((r) => GROUP[filter.state](stateOf(r)) && (!q || [r.name, r.config.title ?? '', source(r.config)].some((s) => s.toLowerCase().includes(q))));
  const updates = all.filter((r) => newerVersion(r.pkg)).length;
  const link = (state: FilterState) => `/servers?state=${state}${filter.q ? `&q=${encodeURIComponent(filter.q)}` : ''}`;
  return html`<div id="servers" data-refresh>
    ${pageHead('Servers', {
      sub: all.length
        ? html`${plural(all.length, 'server')} in the yard: ${count('online')} healthy${count('failed') ? html`, <span class="text-error">${count('failed')} ${count('failed') === 1 ? 'needs' : 'need'} care</span>` : ''}${updates ? html`, <span class="text-primary font-medium">${plural(updates, 'update')} ready</span>` : ''}`
        : 'Every MCP server you add here shows up behind one endpoint.',
      actions: html`${postButton('/reload', 'Reload', { icon: 'refresh', title: 'Re-read the server file and apply the changes' })}
        ${editable ? linkButton('/servers/new', 'Add server', { tone: 'primary', icon: 'sprout' }) : ''}`,
    })}
    ${toolbar(html`
      ${chips(FILTERS.map((f) => ({ href: link(f), label: `${f[0]!.toUpperCase()}${f.slice(1)}`, count: count(f), active: filter.state === f })))}
      ${filter.q ? html`<a class="badge badge-ghost gap-1" href="${filter.state === 'all' ? '/servers' : `/servers?state=${filter.state}`}" title="Clear the search">“${filter.q}” ✕</a>` : ''}
      <span class="flex-1"></span>
      ${segLinks('Layout', [
        { href: '/servers?view=list', icon: 'list', label: 'List', active: view === 'list' },
        { href: '/servers?view=cards', icon: 'grid', label: 'Cards', active: view === 'cards' },
      ])}
    `)}
    ${!all.length
      ? hero(
          'Your yard is empty',
          editable ? 'Plant a first MCP server: an npm or PyPI package, a command, or a remote URL. Its tools show up behind /mcp at once.' : 'Declare servers in the server file, then reload.',
          editable ? linkButton('/servers/new', 'Add a first server', { tone: 'primary', icon: 'sprout' }) : postButton('/reload', 'Reload', { icon: 'refresh' }),
          'hello',
        )
      : !rows.length
        ? empty(filter.q ? html`<p>No server matches <strong>${filter.q}</strong>. <a class="link link-primary" href="/servers">Show all</a></p>` : 'No server matches this filter.')
        : view === 'list'
          ? list(['Name', 'State', { label: 'Kind', hide: true }, { label: 'Version', hide: true }, { label: 'Tools', hide: true }, { label: '', hide: true }], rows.map((r) => listRow(r, editable)))
          : html`<div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))]">${rows.map((r) => tile(r, editable))}</div>`}
  </div>`;
}

/** The server's title when the file sets one, else its name in monospace. */
export const serverLabel = (name: string, config?: ServerConfig): Content => config?.title ?? html`<span class="font-mono">${name}</span>`;

export function rowOf(hub: Hub, name: string): Row | undefined {
  const upstream = hub.upstreams.get(name);
  if (!upstream) return undefined;
  return { name, upstream, config: hub.configs[name]!, pkg: hub.packageStatus()[name], uiDisabled: hub.isDisabled(name) };
}

export type ServerTab = 'overview' | 'settings' | 'logs';

/** The top of every page of one server: name, state, switch, actions and tabs. */
export function serverHead(row: Row, editable: boolean, active: ServerTab, logCount?: number): Fragment {
  return html`${pageHead(html`${serverLabel(row.name, row.config)}<span class="text-sm font-normal">${stateLabel(row)}</span>`, {
      crumbs: [{ label: 'Servers', href: '/servers' }, { label: row.config.title ?? row.name, href: active === 'overview' ? undefined : `/servers/${row.name}` }, ...(active === 'overview' ? [] : [{ label: active === 'logs' ? 'Logs' : 'Settings' }])],
      sub: html`<span class="font-mono text-xs break-all">${row.config.title ? `${row.name} · ` : ''}${source(row.config)}</span>`,
      actions: controls(row, editable, { settings: false }),
    })}
    ${tabs([
      { href: `/servers/${row.name}`, label: 'Overview', active: active === 'overview' },
      { href: `/servers/${row.name}/logs`, label: 'Logs', count: logCount, active: active === 'logs' },
      { href: `/servers/${row.name}/edit`, label: 'Settings', active: active === 'settings' },
    ])}`;
}

/** The mascot says how the server is doing when it is not simply running. */
function moodBanner(row: Row): Fragment {
  const state = stateOf(row);
  const [mood, text]: [Mood, string] | [] =
    state === 'disabled'
      ? ['sleeping', row.config.enabled ? 'Switched off from the UI: its tools are hidden from every key. The switch at the top wakes it up.' : 'Disabled in the server file: set enabled back to true and reload.']
      : signInUrl(row)
        ? ['sleeping', 'It waits for a sign-in before it can start.']
        : state === 'failed' || state === 'degraded'
        ? ['worried', state === 'failed' ? 'It never got ready and keeps retrying. The error below says why.' : 'It was ready, lost its connection and is reconnecting.']
        : ['installing', 'starting', 'updating'].includes(state)
          ? ['busy', state === 'updating' ? 'Updating: the new version starts next to the old one and takes over once it answers.' : `${state[0]!.toUpperCase()}${state.slice(1)}…`]
          : [];
  if (!mood) return html``;
  return html`<div class="card card-border border-base-300 bg-base-100"><div class="card-body flex-row items-center gap-4 p-4">${mascot('sm', mood)}<p class="text-base-content/80">${text}</p></div></div>`;
}

export function serverOverview(row: Row, editable: boolean, logCount: number): Fragment {
  const pkg = row.pkg;
  const { visible, total } = toolCounts(row);
  const fact = (label: string, value: Content) => html`<div><dt class="text-xs text-base-content/50">${label}</dt><dd class="mt-0.5">${value}</dd></div>`;
  return html`<div id="server" data-refresh>
    ${serverHead(row, editable, 'overview', logCount)}
    <div class="grid gap-4">
      ${moodBanner(row)}
      ${notes(row)}
      ${box(
        html`<dl class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-6 gap-y-4">
          ${fact('State', stateLabel(row))}
          ${fact('Kind', transport(row.config))}
          ${fact('Version', pkg?.installed ? html`<span class="font-mono">${pkg.installed}</span>` : html`<span class="opacity-40">n/a</span>`)}
          ${fact('Owned by', pkg ? (pkg.pinned ? 'the server file (pinned)' : 'the hub') : html`<span class="opacity-40">n/a</span>`)}
          ${fact('Latest', pkg?.latest?.version ? html`<span class="font-mono">${pkg.latest.version}</span>` : html`<span class="opacity-40">${pkg ? 'not checked yet' : 'n/a'}</span>`)}
          ${fact('Tools', total ? `${visible} of ${total} exposed` : 'none yet')}
        </dl>`,
        { pad: true },
      )}
      ${total
        ? box(
            html`<ul class="list">${row.upstream.tools.map((t) => {
              const shown = allowed(t.name, row.config.tools);
              return html`<li class="list-row ${shown ? '' : 'opacity-50'}">
                <div class="list-col-grow min-w-0">
                  <div class="font-mono font-medium flex flex-wrap items-center gap-2"><span class="${shown ? '' : 'line-through'}">${row.name}-${t.name}</span>${shown ? '' : tag('hidden by the server file')}</div>
                  ${t.description ? html`<p class="mt-0.5 text-[13px] text-base-content/60 break-words">${t.description}</p>` : ''}
                </div>
              </li>`;
            })}</ul>`,
            { title: html`Tools <span class="badge badge-sm badge-ghost">${total}</span>`, aside: visible < total ? html`<span class="text-xs text-base-content/50">${total - visible} hidden by the server file</span>` : '' },
          )
        : ''}
    </div>
  </div>`;
}
