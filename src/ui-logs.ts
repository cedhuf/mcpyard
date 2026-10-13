import type { Context, Hono, MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import { logs, type LogEntry } from './logs.ts';
import { chips, empty, pageHead, search, stats, status, tag, toolbar } from './ui-kit.ts';
import { page, type Env, type Fragment } from './ui-layout.ts';

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

export function logsForServer(server: string): LogEntry[] {
  return logs.list().filter((e) => e.server === server);
}

function query(c: Context<Env>): Query {
  const kind = c.req.query('kind') ?? 'all';
  return { kind: kind in FILTERS ? (kind as FilterName) : 'all', server: c.req.query('server') ?? '', q: (c.req.query('q') ?? '').trim() };
}

function href(q: Query, change: Partial<Query>): string {
  const params = new URLSearchParams(Object.entries({ ...q, ...change }).filter(([k, v]) => v && !(k === 'kind' && v === 'all')));
  return params.size ? `/logs?${params}` : '/logs';
}

function matches(e: LogEntry, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [e.text, e.server, ...Object.values(e.fields ?? {}).map(String)].some((v) => v?.toLowerCase().includes(needle));
}

function time(iso: string): Fragment {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return html`<time class="font-mono text-xs text-base-content/50 tabular-nums" datetime="${iso}" title="${iso}">${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}</time>`;
}

const HIDDEN = new Set(['event', 'time', 'by', 'server']);

function message(e: LogEntry): Fragment {
  const f = e.fields ?? {};
  if (e.kind === 'call') {
    return html`<span class="font-mono">${f.tool}</span> <span class="text-base-content/50">by</span> ${f.key}${f.error ? html`<span class="block mt-0.5 font-mono text-xs text-error whitespace-pre-wrap">${f.error}</span>` : ''}`;
  }
  if (e.kind === 'action') {
    const details = Object.entries(f).filter(([k]) => !HIDDEN.has(k));
    return html`${e.text.replaceAll('_', ' ')}${details.map(([k, v]) => html` <span class="text-base-content/50">${k}</span> <span class="font-mono">${String(v)}</span>`)}${f.by ? html` <span class="text-base-content/50">by</span> ${f.by}` : ''}`;
  }
  return html`<span class="font-mono text-xs ${e.error ? 'text-error' : ''}">${e.text}</span>`;
}

function kindLabel(e: LogEntry): Fragment {
  if (e.kind === 'call') return status(e.error ? 'error' : 'success', e.error ? 'Failed' : 'Call');
  if (e.error) return status('error', 'Error');
  return status('neutral', { action: 'Action', server: 'Output', hub: 'Hub' }[e.kind]);
}

function logRow(e: LogEntry, link?: (server: string) => string): Fragment {
  const source = e.server ? (link ? html`<a class="link link-hover font-mono" href="${link(e.server)}" title="Only ${e.server}">${e.server}</a>` : html`<span class="font-mono">${e.server}</span>`) : html`<span class="text-base-content/40">hub</span>`;
  return html`<div class="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] md:grid-cols-[4.5rem_5rem_8rem_minmax(0,1fr)_4rem] items-baseline gap-x-3 gap-y-1 px-4 py-2 hover:bg-base-200/50">
    ${time(e.time)}
    <span class="text-xs">${kindLabel(e)}</span>
    <span class="text-xs truncate">${source}</span>
    <span class="text-right text-xs text-base-content/50 tabular-nums md:order-last">${e.kind === 'call' ? `${e.fields?.ms} ms` : ''}</span>
    <div class="col-span-full md:col-span-1 min-w-0 break-words text-[13px]">${message(e)}</div>
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
  return html`<div class="grid gap-3">
    ${stats([
      { label: 'Calls', value: String(calls.length) },
      { label: 'Failed', value: String(failed), tone: failed ? 'error' : undefined },
      { label: 'Median', value: `${percentile(ms, 50)} ms` },
      { label: '95th percentile', value: `${percentile(ms, 95)} ms` },
    ])}
    <div class="flex flex-wrap items-center gap-1.5 text-xs"><span class="text-base-content/50 mr-1">Most called</span>${top.map(([tool, n]) => tag(html`${tool} <b class="font-semibold">${n}</b>`, { mono: true }))}</div>
  </div>`;
}

/** A list of log lines, newest first, capped so the page stays light. */
export function logsBlock(entries: LogEntry[], link?: (server: string) => string): Fragment {
  if (!entries.length) return empty('Nothing logged yet.');
  return html`<div class="card card-border border-base-300 bg-base-100 overflow-hidden divide-y divide-base-300">${entries.slice(0, SHOWN).map((e) => logRow(e, link))}</div>
    ${entries.length > SHOWN ? html`<p class="mt-3 text-xs text-base-content/50">Showing the newest ${SHOWN} of ${entries.length}.</p>` : ''}`;
}

function logsView(q: Query): Fragment {
  const all = logs.list();
  const scoped = all.filter((e) => (!q.server || e.server === q.server) && matches(e, q.q));
  const shown = scoped.filter(FILTERS[q.kind].match);
  const keep: Record<string, string> = { ...(q.kind !== 'all' ? { kind: q.kind } : {}), ...(q.server ? { server: q.server } : {}) };
  return html`<div id="logs" data-refresh>
    ${pageHead('Logs', { sub: `The last ${all.length} lines since the hub started, newest first. The same lines go to the container's output.` })}
    ${toolbar(html`
      ${chips((Object.keys(FILTERS) as FilterName[]).map((k) => ({ href: href(q, { kind: k }), label: FILTERS[k].label, count: scoped.filter(FILTERS[k].match).length, active: q.kind === k })))}
      ${search('/logs', q.q, 'Search logs', keep)}
      ${q.server ? html`<a class="badge badge-primary badge-soft gap-1" href="${href(q, { server: '' })}" title="Show every server"><span class="font-mono">${q.server}</span>✕</a>` : ''}
    `)}
    <div class="grid gap-4">
      ${q.kind === 'calls' ? callStats(shown) : ''}
      ${shown.length ? logsBlock(shown, (server) => href(q, { server })) : empty(all.length ? 'Nothing matches this filter.' : 'Nothing logged yet.')}
    </div>
  </div>`;
}
