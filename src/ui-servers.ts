import { html } from 'hono/html';
import type { ServerConfig } from './config.ts';
import type { Hub, PackageStatus } from './front.ts';
import { allowed } from './keys.ts';
import type { Upstream } from './upstream.ts';
import { badge, empty, linkButton, menu, menuDivider, menuItem, menuLink, onOff, pageHead, postButton, search, tabs } from './ui-kit.ts';
import { icon, type Fragment } from './ui-layout.ts';

export type View = 'cards' | 'list';
export const FILTERS = ['all', 'online', 'failed', 'disabled'] as const;
export type FilterState = (typeof FILTERS)[number];
export type Filter = { state: FilterState; q: string };

export type Row = { name: string; config: ServerConfig; upstream: Upstream; pkg?: PackageStatus; uiDisabled: boolean };

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

function enableSwitch(row: Row): Fragment {
  const on = !row.uiDisabled;
  return onOff(`/servers/${row.name}/${on ? 'disable' : 'enable'}`, on, `${on ? 'Switch off' : 'Switch on'} ${row.name}`, row.config.enabled ? undefined : 'Disabled in the server file');
}

export function actionItems(row: Row, editable: boolean, options: { edit?: boolean } = {}): Fragment[] {
  const pkg = row.pkg;
  const newer = newerVersion(pkg);
  return [
    options.edit === false ? '' : menuLink(`/servers/${row.name}/edit`, editable ? 'Edit' : 'View settings', 'pencil'),
    row.config.enabled && !row.uiDisabled ? menuItem(`/servers/${row.name}/restart`, 'Restart', 'rotate') : '',
    newer && !pkg!.updating ? menuItem(`/servers/${row.name}/update`, `Update to ${newer}`, 'up', { fields: { version: newer } }) : '',
    pkg && !pkg.pinned && !pkg.updating && pkg.previous && pkg.previous !== newer ? menuItem(`/servers/${row.name}/update`, `Roll back to ${pkg.previous}`, 'undo', { fields: { version: pkg.previous } }) : '',
    editable ? html`${menuDivider}${menuItem(`/servers/${row.name}/delete`, 'Remove', 'trash', { confirm: `Remove ${row.name} from the server file? It stops now.`, danger: true })}` : '',
  ].filter((x): x is Fragment => !!x);
}

function actionsMenu(row: Row, editable: boolean): Fragment {
  return menu(`Actions for ${row.name}`, actionItems(row, editable));
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

export function serversView(hub: Hub, editable: boolean, view: View, filter: Filter): Fragment {
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
  return html`<section id="servers" data-refresh>
    ${pageHead('Servers', {
      subtitle: html`${plural(all.length, 'server')} · ${count('online')} online · ${count('failed')} failing · ${count('disabled')} off${updates ? html` · <span class="text-primary">${plural(updates, 'update')}</span>` : ''}`,
      actions: html`${postButton('/reload', 'Reload', { size: 'sm', icon: 'refresh', title: 'Re-read the server file and apply the changes' })}
        ${editable ? linkButton('/servers/new', 'Add server', { tone: 'primary', size: 'sm', icon: 'plus' }) : ''}`,
    })}
    <div class="toolbar">
      ${tabs(FILTERS.map((f) => ({ href: link(f), label: `${f[0]!.toUpperCase()}${f.slice(1)}`, count: count(f), active: filter.state === f })))}
      ${search('/', filter.q, 'Search by name or package', filter.state !== 'all' ? { state: filter.state } : {})}
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

export function rowOf(hub: Hub, name: string): Row | undefined {
  const upstream = hub.upstreams.get(name);
  if (!upstream) return undefined;
  return { name, upstream, config: hub.configs[name]!, pkg: hub.packageStatus()[name], uiDisabled: hub.isDisabled(name) };
}

/** The top of a server's own page: what it is, how it runs, and the same switch and actions as its row. */
export function serverSummary(row: Row, editable: boolean): { controls: Fragment; summary: Fragment } {
  const { visible, total } = toolCounts(row);
  return {
    controls: html`<div class="srow-controls">${enableSwitch(row)}${menu(`Actions for ${row.name}`, actionItems(row, editable, { edit: false }))}</div>`,
    summary: html`<div class="summary">
        ${stateBadge(stateOf(row))}<span class="kind-tag">${transport(row.config)}</span>${versionBadge(row)}
        <span class="meta">${icon('wrench', 'xs')}${visible}/${total} tools</span>
        <span class="mono muted truncate grow" title="${source(row.config)}">${source(row.config)}</span>
      </div>
      ${errorOf(row)}${updateCallout(row)}`,
  };
}

export { toolsSection };
