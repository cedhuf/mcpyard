import type { Context, Hono, MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import type { ConfigFile } from './config.ts';
import { newerVersion, type Hub } from './front.ts';
import { isAdmin, loadKeys, type Key } from './keys.ts';
import { overview, type SecurityCheck } from './insights.ts';
import { logs, type LogEntry } from './logs.ts';
import { release } from './release.ts';
import type { Settings } from './settings.ts';
import { icon, mascot, type Mood } from './ui-icons.ts';
import { box, linkButton, pageHead, postButton, stats, status, tag } from './ui-kit.ts';
import { log, page, toast, type Env, type Fragment } from './ui-layout.ts';
import { plural, serverLabel } from './ui-servers.ts';

export type DashboardOptions = { keysPath: string; signIn: boolean; publicUrl?: string; settings?: Settings; configFile?: ConfigFile };

const DAY = 86_400_000;
const IDLE_DAYS = 30;
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function dashboardRoutes(app: Hono<Env>, hub: Hub, guard: MiddlewareHandler<Env>, options: DashboardOptions): void {
  hub.security = () => securityChecks(hub, loadKeys(options.keysPath), options);
  app.get('/', guard, (c) => c.html(page(c, 'Dashboard', html`${dashboard(c, hub, options)}${notice(c)}`)));

  app.post('/dashboard/health', guard, async (c) => {
    const report = await hub.healthCheck();
    log(c, 'health_check', { failed: String(report.results.filter((r) => !r.ok).length) });
    return c.redirect('/?done=health', 303);
  });

  app.post('/dashboard/check-updates', guard, async (c) => {
    await hub.checkUpdates();
    log(c, 'updates_checked');
    return c.redirect('/?done=check', 303);
  });

  app.post('/dashboard/reload', guard, async (c) => {
    try {
      const { added, removed, changed } = await hub.reload();
      log(c, 'config_reloaded');
      return c.redirect(`/?done=reload&added=${added.length}&removed=${removed.length}&changed=${changed.length}`, 303);
    } catch (e) {
      return c.html(page(c, 'Dashboard', html`${dashboard(c, hub, options)}${toast(`Server file not reloaded, nothing changed: ${(e as Error).message}`, 'error')}`), 400);
    }
  });

  app.post('/dashboard/update-all', guard, (c) => {
    const started = hub.updateAll();
    log(c, 'update_all', { servers: started.join(', ') });
    return c.redirect(`/?done=update&n=${started.length}`, 303);
  });
}

function notice(c: Context<Env>): Fragment | string {
  const done = c.req.query('done');
  if (done === 'health') return toast('Health check done.');
  if (done === 'reload') {
    const parts = [['added', 'added'], ['removed', 'removed'], ['changed', 'restarted']].map(([k, verb]) => [Number(c.req.query(k!) ?? 0), verb] as const).filter(([n]) => n);
    return toast(`Server file reloaded: ${parts.length ? parts.map(([n, verb]) => `${plural(n, 'server')} ${verb}`).join(', ') : 'no changes'}.`);
  }
  if (done === 'check') return toast('Registries checked.');
  if (done === 'update') return toast(`${plural(Number(c.req.query('n') ?? 0), 'update')} started; each server switches over once its new version answers.`);
  return '';
}

/** Hour, minute and second in the hub's time zone. */
function clockParts(at: Date): { hour: number; minute: number; second: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(at).map((p) => [p.type, Number(p.value)]));
  return { hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}

/** The hub's clock, as daisyUI countdown digits that a few lines of script keep ticking. */
function clock(): Fragment {
  const now = new Date();
  const { hour, minute, second } = clockParts(now);
  const digit = (unit: string, value: number) => html`<span data-unit="${unit}" style="--value:${value};--digits:2" aria-live="polite" aria-label="${value}">${value}</span>`;
  return html`<div id="hub-clock" data-keep class="card card-border border-base-300 bg-base-100">
    <div class="card-body gap-1 px-5 py-3">
      <span class="flex items-center gap-1.5 text-xs text-base-content/60">${icon('clock', 'xs')}Hub time · ${ZONE}</span>
      <span class="countdown font-mono text-3xl tabular-nums" data-clock data-now="${now.getTime()}" data-zone="${ZONE}">${digit('hour', hour)}:${digit('minute', minute)}:${digit('second', second)}</span>
    </div>
  </div>`;
}

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}



/** What a careful admin would look at: who can get in, over what, with which rights. */
function securityChecks(hub: Hub, keys: Key[], options: DashboardOptions): SecurityCheck[] {
  const enabled = keys.filter((k) => k.enabled);
  const admins = enabled.filter(isAdmin);
  const adminTools = options.settings?.value('adminTools') ?? true;
  const idle = enabled.filter((k) => Date.now() - Date.parse(k.lastUsed ?? k.created) > IDLE_DAYS * DAY);
  const wide = enabled.filter((k) => k.scope.servers.includes('*') && !k.scope.tools.allow?.length && !k.scope.tools.deny?.length);
  const scripts = Object.entries(hub.configs).filter(([, c]) => c.package && c.allowScripts).map(([name]) => name);
  const about = release.status();
  const readOnly = options.configFile?.readOnlyReason();
  const https = options.publicUrl?.startsWith('https://');
  return [
    { ok: options.signIn, title: 'Web UI sign-in', detail: options.signIn ? 'OpenID Connect guards every page.' : 'Sign-in is off: anyone reaching the port manages the hub.', label: options.signIn ? 'On' : 'Off' },
    { ok: !!https, title: 'HTTPS address', detail: options.publicUrl ? options.publicUrl : 'MCPYARD_PUBLIC_URL is not set.', label: https ? 'Yes' : 'No' },
    { ok: !adminTools || admins.length === 0, title: 'Hub administration', detail: !adminTools ? 'The yard-* tools are off for every key.' : admins.length ? `${plural(admins.length, 'key')} can restart, switch and update servers.` : 'No key can administer the hub.', label: !adminTools ? 'Off' : `${admins.length}` },
    { ok: idle.length === 0, title: 'Idle keys', detail: idle.length ? `${idle.map((k) => k.name).join(', ')}: unused for ${IDLE_DAYS} days or more.` : `Every key was used in the last ${IDLE_DAYS} days.`, label: `${idle.length}` },
    { ok: wide.length === 0, title: 'Keys without limits', detail: wide.length ? `${wide.map((k) => k.name).join(', ')}: every tool of every server.` : 'Every key is limited to some servers or tools.', label: `${wide.length}` },
    { ok: scripts.length === 0, title: 'Install scripts', detail: scripts.length ? `Allowed for ${scripts.join(', ')}.` : 'No package runs install scripts.', label: `${scripts.length}` },
    { ok: !about.newer, title: 'MCP Yard version', detail: about.newer && about.latest ? `v${about.latest.version} is out; you run v${about.current}.` : about.current === 'dev' ? 'Development build.' : `v${about.current}, the latest known.`, label: about.newer ? 'Behind' : 'Current' },
    { ok: !!readOnly, title: 'Server file', detail: readOnly ? 'Read-only: servers change only where you keep the file.' : 'Writable: servers can be edited from the UI.', label: readOnly ? 'Read-only' : 'Writable' },
  ];
}

function dashboard(c: Context<Env>, hub: Hub, options: DashboardOptions): Fragment {
  const user = c.get('user');
  const now = new Date();
  const { hour } = clockParts(now);
  const greeting = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const date = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'long', month: 'long', day: 'numeric' }).format(now);

  const packages = hub.packageStatus();
  const names = [...hub.upstreams.keys()];
  const off = (name: string) => !hub.configs[name]!.enabled || hub.isDisabled(name);
  const keys = loadKeys(options.keysPath);
  const ov = overview(hub, keys);
  const care = ov.servers.needCare;
  const updates = Object.entries(packages).filter(([, p]) => newerVersion(p));
  const upToDate = ov.updates.hubOwned ? Math.round((ov.updates.upToDate / ov.updates.hubOwned) * 100) : 100;
  const recent = logs.list().filter((e) => Date.now() - Date.parse(e.time) < DAY);
  const calls = ov.calls24h;
  const checks = securityChecks(hub, keys, options);
  const passed = checks.filter((k) => k.ok).length;
  const mood: Mood = Object.values(packages).some((p) => p.updating) ? 'busy' : care.length ? 'worried' : names.length && passed === checks.length ? 'celebrating' : 'yard';

  const summary = !names.length
    ? 'Your yard is empty: add a first server to get going.'
    : `${care.length ? `${plural(care.length, 'server')} ${care.length === 1 ? 'needs' : 'need'} care` : 'Every server is healthy'}${updates.length ? `, ${plural(updates.length, 'update')} ${updates.length === 1 ? 'is' : 'are'} ready` : ''} and ${passed} of ${checks.length} security checks pass.`;

  return html`<div id="dashboard" data-refresh>
    ${pageHead(`${greeting}${user ? `, ${user.name}` : ''}.`, {
      eyebrow: date,
      sub: summary,
      crumbs: [{ label: 'Dashboard' }],
      wideActions: true,
      center: mascot('md', mood),
      actions: html`<div class="flex w-full items-center gap-4">
        <div class="flex flex-1 justify-center lg:hidden">${mascot('md', mood)}</div>
        <div class="grid gap-2 max-sm:flex-1">
          ${clock()}
          <form method="post" action="/dashboard/reload" class="contents"><button class="btn btn-sm w-full" title="Re-read the server file and apply the changes">${icon('refresh', 'sm')}Reload server file</button></form>
        </div>
      </div>`,
    })}

    <div class="grid gap-4">
      ${stats(
        [
          { label: 'Healthy servers', value: `${ov.servers.healthy.length}/${ov.servers.running}`, desc: care.length ? html`<span class="text-error">${care.length} ${care.length === 1 ? 'needs' : 'need'} care</span>` : `${ov.servers.switchedOff.length} switched off`, icon: 'server', tint: 'text-primary' },
          { label: 'Tools exposed', value: String(ov.tools), desc: `across ${plural(ov.servers.running, 'running server')}`, icon: 'wrench', tint: 'text-accent' },
          { label: 'MCP calls, 24 h', value: String(calls.count), desc: calls.count ? html`${calls.failed ? html`<span class="text-error">${calls.failed} failed</span>` : 'none failed'} · median ${calls.medianMs} ms` : 'no calls yet', icon: 'pulse', tint: 'text-info' },
          { label: 'Active keys', value: String(ov.keys.active), desc: `${ov.keys.admin} with administration`, icon: 'key', tint: 'text-secondary' },
        ],
        { large: true },
      )}

      <div class="grid gap-4 lg:grid-cols-3">
        <div class="lg:col-span-2">${healthCard(hub, names, off)}</div>
        ${updatesCard(hub, updates, packages, upToDate, ov.updates.hubOwned)}
      </div>

      <div class="grid gap-4 lg:grid-cols-3">
        ${securityCard(checks, passed)}
        ${activityCard(recent)}
        ${toolsCard(calls.top)}
      </div>
    </div>
  </div>`;
}

function healthCard(hub: Hub, names: string[], off: (name: string) => boolean): Fragment {
  const report = hub.lastHealth;
  const result = (name: string) => report?.results.find((r) => r.server === name);
  const rows = names.map((name) => {
    const upstream = hub.upstreams.get(name)!;
    const r = result(name);
    const state = off(name) ? status('neutral', 'Switched off') : r ? (r.ok ? status('success', 'Answering') : status('error', 'No answer')) : status(upstream.state === 'ready' ? 'success' : upstream.state === 'failed' ? 'error' : 'info', upstream.state[0]!.toUpperCase() + upstream.state.slice(1));
    return html`<li class="list-row items-center">
      <div class="min-w-0 list-col-grow">
        <a class="font-semibold link link-hover" href="/servers/${name}">${serverLabel(name, hub.configs[name])}</a>
        ${r && !r.ok ? html`<p class="text-xs text-error truncate" title="${r.error}">${r.error}</p>` : ''}
      </div>
      <span class="text-sm">${state}</span>
      <span class="w-16 text-right font-mono text-xs text-base-content/60 tabular-nums">${r?.ms !== undefined ? `${r.ms} ms` : ''}</span>
    </li>`;
  });
  return box(
    names.length
      ? html`<ul class="list">${rows}</ul>`
      : html`<p class="p-5 text-base-content/60">No servers to check yet. <a class="link link-primary" href="/servers/new">Add one</a>.</p>`,
    {
      title: html`<span class="text-primary">${icon('pulse')}</span>Health check`,
      aside: html`<div class="flex items-center gap-3"><span class="text-xs text-base-content/50">${report ? `Last run ${ago(report.at)}` : 'Not run yet'} · ${hub.healthEveryMinutes ? `every ${hub.healthEveryMinutes} min` : html`<a class="link link-hover" href="/settings">automatic check off</a>`}</span>${postButton('/dashboard/health', 'Run now', { icon: 'refresh' })}</div>`,
    },
  );
}

function updatesCard(hub: Hub, updates: [string, ReturnType<Hub['packageStatus']>[string]][], packages: ReturnType<Hub['packageStatus']>, upToDate: number, owned: number): Fragment {
  const checked = Object.values(packages)
    .map((p) => p.latest?.checkedAt)
    .filter((t): t is string => !!t)
    .sort()
    .at(-1);
  return html`<section class="card bg-neutral text-neutral-content">
    <div class="card-body gap-4">
      <div class="flex items-start justify-between gap-3">
        <div><h2 class="card-title font-display text-lg font-medium">Updates</h2><p class="text-xs opacity-70">${checked ? `Registries checked ${ago(checked)}` : 'Registries not checked yet'}</p></div>
        <span class="text-secondary">${icon('up')}</span>
      </div>
      <div class="flex items-center gap-6">
        <div class="relative shrink-0">
          <div class="radial-progress absolute inset-0 text-neutral-content/15" style="--value:100;--size:6rem;--thickness:0.6rem" aria-hidden="true"></div>
          <div class="radial-progress text-primary" style="--value:${upToDate};--size:6rem;--thickness:0.6rem" aria-valuenow="${upToDate}" role="progressbar"><span class="font-display text-xl text-neutral-content">${upToDate}%</span></div>
        </div>
        <div class="grid gap-2">
          <div><span class="font-display text-2xl font-semibold">${owned - updates.length}</span> <span class="text-sm opacity-70">up to date</span></div>
          <div><span class="font-display text-2xl font-semibold ${updates.length ? 'text-secondary' : ''}">${updates.length}</span> <span class="text-sm opacity-70">${updates.length === 1 ? 'update ready' : 'updates ready'}</span></div>
        </div>
      </div>
      ${updates.length
        ? html`<ul class="grid gap-1.5 rounded-box bg-base-content/10 p-3 text-sm">${updates.map(([name, p]) => html`<li class="flex items-center justify-between gap-3"><a class="link link-hover" href="/servers/${name}">${serverLabel(name, hub.configs[name])}</a><span class="font-mono text-xs opacity-80">${p.installed} → <span class="text-secondary">${p.latest!.version}</span></span></li>`)}</ul>`
        : html`<p class="text-sm opacity-70">${owned ? 'Every hub-owned package runs its latest version.' : 'No hub-owned packages: pinned versions stay as written.'}</p>`}
      <div class="card-actions mt-auto grid grid-cols-2 gap-2">
        <form method="post" action="/dashboard/check-updates" class="contents"><button class="btn btn-sm">${icon('refresh', 'sm')}Check now</button></form>
        <form method="post" action="/dashboard/update-all" class="contents" data-confirm="Update ${plural(updates.length, 'server')} now? Each keeps serving until its new version answers."><button class="btn btn-sm btn-primary" ${updates.length ? '' : 'disabled'}>${icon('up', 'sm')}Update all</button></form>
      </div>
    </div>
  </section>`;
}

function securityCard(checks: SecurityCheck[], passed: number): Fragment {
  return box(
    html`<ul class="list">${checks.map(
      (k) => html`<li class="list-row items-center">
        <span class="grid size-8 place-items-center rounded-full ${k.ok ? 'bg-success/15 text-success' : 'bg-warning/20 text-warning'}">${icon(k.ok ? 'check' : 'alert', 'sm')}</span>
        <div class="min-w-0"><div class="font-medium">${k.title}</div><div class="text-xs text-base-content/60 break-words">${k.detail}</div></div>
        <span class="text-xs font-semibold ${k.ok ? 'text-base-content/60' : 'text-warning'}">${k.label}</span>
      </li>`,
    )}</ul>
    <div class="m-4 mt-1 rounded-box bg-base-200 p-4">
      <div class="mb-2 flex justify-between text-sm font-medium"><span>Checks passed</span><span>${passed} / ${checks.length}</span></div>
      <progress class="progress ${passed === checks.length ? 'progress-success' : 'progress-warning'} w-full" value="${passed}" max="${checks.length}"></progress>
    </div>`,
    { title: html`<span class="text-secondary">${icon('shield')}</span>Security check`, aside: passed === checks.length ? tag('all clear', { tone: 'success' }) : tag(`${checks.length - passed} to review`, { tone: 'warning' }) },
  );
}

const ACTION_LABEL: Record<string, string> = {
  key_created: 'Key created',
  key_updated: 'Key updated',
  key_enable: 'Key switched on',
  key_disable: 'Key switched off',
  key_delete: 'Key deleted',
  server_added: 'Server added',
  server_updated: 'Server settings saved',
  server_deleted: 'Server removed',
  server_enabled: 'Server switched on',
  server_disabled: 'Server switched off',
  server_restarted: 'Server restarted',
  package_update: 'Update started',
  update_all: 'All updates started',
  config_reloaded: 'Server file reloaded',
  settings_saved: 'Settings saved',
  health_check: 'Health check run',
  updates_checked: 'Registries checked',
};

function activityCard(recent: LogEntry[]): Fragment {
  const items = recent.filter((e) => e.kind === 'action' || e.error).slice(0, 6);
  const time = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  return box(
    items.length
      ? html`<ul class="list">${items.map((e) => {
          const subject = e.fields?.server ?? e.fields?.key ?? e.fields?.servers ?? e.server ?? '';
          const title = e.kind === 'action' ? (ACTION_LABEL[e.text] ?? e.text.replaceAll('_', ' ')) : e.kind === 'call' ? `${e.text} failed` : 'Error';
          const detail = e.kind === 'action' ? html`${subject ? html`<span class="font-mono">${subject}</span>` : ''}${e.fields?.by ? ` by ${e.fields.by}` : ''}` : html`<span class="font-mono">${e.server ?? ''}</span> ${e.fields?.error ?? e.text}`;
          return html`<li class="list-row items-start">
            <span class="grid size-8 place-items-center rounded-full ${e.error ? 'bg-error/15 text-error' : 'bg-primary/15 text-primary'}">${icon(e.error ? 'alert' : 'check', 'sm')}</span>
            <div class="min-w-0"><div class="font-medium">${title}</div><div class="text-xs text-base-content/60 line-clamp-2 break-words" title="${e.fields?.error ?? ''}">${detail}</div></div>
            <time class="font-mono text-xs text-base-content/50">${time(e.time)}</time>
          </li>`;
        })}</ul>`
      : html`<p class="p-5 text-base-content/60">Nothing happened in the last 24 hours.</p>`,
    { title: html`<span class="text-accent">${icon('logs')}</span>Recent activity`, aside: linkButton('/logs', 'All logs', { tone: 'ghost' }) },
  );
}

function toolsCard(top: { tool: string; count: number }[]): Fragment {
  const max = top[0]?.count ?? 1;
  return box(
    top.length
      ? html`<ul class="grid gap-3 px-5 py-4">${top.map(
          ({ tool, count: n }) => html`<li class="grid gap-1">
            <div class="flex justify-between gap-3 text-sm"><span class="font-mono truncate">${tool}</span><span class="font-semibold tabular-nums">${n}</span></div>
            <progress class="progress progress-primary w-full" value="${n}" max="${max}"></progress>
          </li>`,
        )}</ul>`
      : html`<p class="p-5 text-base-content/60">No MCP calls in the last 24 hours.</p>`,
    { title: html`<span class="text-info">${icon('wrench')}</span>Most used tools`, aside: html`<a class="link link-hover text-xs" href="/logs?kind=calls">Calls</a>` },
  );
}
