import type { Context, Hono, MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import { logs, type LogEntry } from './logs.ts';
import { badge, empty, pageHead, search, tabs } from './ui-kit.ts';
import { icon, page, type Env, type Fragment } from './ui-layout.ts';

const SHOWN = 300;

const FILTERS = {
  all: { label: 'All', match: () => true },
  calls: { label: 'MCP calls', match: (e: LogEntry) => e.kind === 'call' },
  actions: { label: 'Actions', match: (e: LogEntry) => e.kind === 'action' },
  output: { label: 'Output', match: (e: LogEntry) => e.kind === 'server' || e.kind === 'hub' },
  errors: { label: 'Errors', match: (e: LogEntry) => e.error },
} as const;
type FilterName = keyof typeof FILTERS;
type Query = { kind: FilterName; server: string; q: string };

export function logRoutes(app: Hono<Env>, guard: MiddlewareHandler<Env>): void {
  app.get('/logs', guard, (c) => c.html(page(c, 'Logs', logsView(query(c)))));
}

function query(c: Context<Env>): Query {
  const kind = c.req.query('kind') ?? 'all';
  return { kind: kind in FILTERS ? (kind as FilterName) : 'all', server: c.req.query('server') ?? '', q: (c.req.query('q') ?? '').trim() };
}

function href(q: Query, change: Partial<Query>): string {
  const next = { ...q, ...change };
  const params = new URLSearchParams(Object.entries(next).filter(([k, v]) => v && !(k === 'kind' && v === 'all')));
  const s = params.toString();
  return s ? `/logs?${s}` : '/logs';
}

function matches(e: LogEntry, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [e.text, e.server, ...Object.values(e.fields ?? {}).map(String)].some((v) => v?.toLowerCase().includes(needle));
}

function time(iso: string): Fragment {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return html`<time class="log-time" datetime="${iso}" title="${iso}">${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}</time>`;
}

function serverLink(q: Query, server?: string): Fragment {
  if (!server) return html`<span class="log-src muted">hub</span>`;
  return html`<a class="log-src mono" href="${href(q, { server })}" title="Only ${server}">${server}</a>`;
}

const HIDDEN = new Set(['event', 'time', 'by', 'server']);

function message(e: LogEntry): Fragment {
  const f = e.fields ?? {};
  if (e.kind === 'call') {
    return html`<div class="log-msg">
      <span class="mono">${f.tool}</span><span class="muted"> by </span><span class="font-medium">${f.key}</span>
      ${f.error ? html`<div class="log-error mono">${f.error}</div>` : ''}
    </div>`;
  }
  if (e.kind === 'action') {
    const details = Object.entries(f).filter(([k]) => !HIDDEN.has(k));
    return html`<div class="log-msg"><span class="font-medium">${e.text.replaceAll('_', ' ')}</span>
      ${details.map(([k, v]) => html` <span class="muted">${k}</span> <span class="mono">${String(v)}</span>`)}
      ${f.by ? html`<span class="muted"> by </span>${f.by}` : ''}</div>`;
  }
  return html`<div class="log-msg mono ${e.error ? 'log-error' : ''}">${e.text}</div>`;
}

function kindTag(e: LogEntry): Fragment {
  if (e.kind === 'call') return html`<span class="state ${e.error ? 'state-error' : 'state-success'}"><span class="status status-${e.error ? 'error' : 'success'}"></span>${e.error ? 'failed' : 'call'}</span>`;
  const label = { action: 'action', server: 'output', hub: 'hub' }[e.kind];
  return html`<span class="state ${e.error ? 'state-error' : 'state-neutral'}"><span class="status status-${e.error ? 'error' : 'neutral'}"></span>${e.error ? 'error' : label}</span>`;
}

function row(e: LogEntry, q: Query): Fragment {
  return html`<div class="log-row ${e.error ? 'is-error' : ''}">
    ${time(e.time)}${kindTag(e)}${serverLink(q, e.server)}${message(e)}
    <span class="log-ms">${e.kind === 'call' ? `${e.fields?.ms} ms` : ''}</span>
  </div>`;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;
}

/** For the MCP calls tab: how many, how many failed, how fast, and the busiest tools. */
function callStats(entries: LogEntry[]): Fragment {
  const calls = entries.filter((e) => e.kind === 'call');
  if (!calls.length) return html``;
  const ms = calls.map((e) => Number(e.fields?.ms ?? 0)).sort((a, b) => a - b);
  const failed = calls.filter((e) => e.error).length;
  const byTool = new Map<string, number>();
  for (const e of calls) byTool.set(e.text, (byTool.get(e.text) ?? 0) + 1);
  const top = [...byTool].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const stat = (label: string, value: string | number, tone = '') => html`<div class="stat-box"><div class="stat-label">${label}</div><div class="stat-num ${tone}">${value}</div></div>`;
  return html`<div class="stats-row">
    ${stat('Calls', calls.length)}
    ${stat('Failed', failed, failed ? 'text-error' : '')}
    ${stat('Median', `${percentile(ms, 50)} ms`)}
    ${stat('95th percentile', `${percentile(ms, 95)} ms`)}
    <div class="stat-box grow"><div class="stat-label">Most called</div><div class="row-wrap mt-1">${top.map(([tool, n]) => badge(html`${tool} <span class="muted">${n}</span>`, { mono: true, small: true }))}</div></div>
  </div>`;
}

function logsView(q: Query): Fragment {
  const all = logs.list();
  const scoped = all.filter((e) => (!q.server || e.server === q.server) && matches(e, q.q));
  const shown = scoped.filter(FILTERS[q.kind].match);
  const keep: Record<string, string> = { ...(q.kind !== 'all' ? { kind: q.kind } : {}), ...(q.server ? { server: q.server } : {}) };
  return html`<section id="logs" data-refresh>
    ${pageHead('Logs', { subtitle: html`The last ${all.length} lines since the hub started, newest first. Everything also goes to the container's output.` })}
    <div class="toolbar">
      ${tabs((Object.keys(FILTERS) as FilterName[]).map((k) => ({ href: href(q, { kind: k }), label: FILTERS[k].label, count: scoped.filter(FILTERS[k].match).length, active: q.kind === k })))}
      ${search('/logs', q.q, 'Search tools, keys, messages', keep)}
      ${q.server ? html`<a class="badge badge-primary badge-soft gap-1" href="${href(q, { server: '' })}" title="Show every server">${icon('server', 'xs')}${q.server} ✕</a>` : ''}
    </div>
    ${q.kind === 'calls' ? callStats(shown) : ''}
    ${shown.length
      ? html`<div class="log-list">${shown.slice(0, SHOWN).map((e) => row(e, q))}</div>
        ${shown.length > SHOWN ? html`<p class="muted text-sm mt-4">Showing the newest ${SHOWN} of ${shown.length}. Narrow the search to see older ones.</p>` : ''}`
      : empty(all.length ? 'Nothing matches this filter.' : 'Nothing logged yet.')}
  </section>`;
}
