import type { Context, Hono, MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import type { ConfigFile, RawServer } from './config.ts';
import type { Hub } from './front.ts';
import { isAdmin, loadKeys } from './keys.ts';
import { YARD_TOOLS } from './yard.ts';
import { THEME_MODES, THEME_NAMES, THEMES, type SettingKey, type Settings } from './settings.ts';
import { plural } from './ui-servers.ts';
import { release } from './release.ts';
import { box, checkbox, field, fields, linkButton, note, pageHead, section, segRadio, setting, tag } from './ui-kit.ts';
import { icon, locked, log, notFound, page, stylesheet, toast, type Env, type Fragment } from './ui-layout.ts';
import { logsBlock, logsForServer } from './ui-logs.ts';
import { rowOf, serverHead, serverOverview } from './ui-servers.ts';

/** An environment variable shown on the settings page; these are read at startup and never editable. */
export type EnvRow = { env: string; value?: string; secret?: boolean };

export type ConfigOptions = {
  keysPath: string;
  settings?: Settings;
  configFile?: ConfigFile;
  environment?: EnvRow[];
  base: (c: Context) => string;
};

const NAME = /^[A-Za-z0-9_-]+$/;
const FORM_FIELDS: SettingKey[] = ['adminTools', 'versionCheckHours', 'healthCheckMinutes', 'updateCheck', 'autoUpdate', 'autoUpdateTime', 'healthCheck', 'mode', 'theme'];

export function configRoutes(app: Hono<Env>, hub: Hub, guard: MiddlewareHandler<Env>, options: ConfigOptions): void {
  const { settings, configFile } = options;
  const editable = () => !!configFile && !configFile.readOnlyReason();

  app.get('/settings', guard, (c) => c.html(page(c, 'Settings', settingsView(c, hub, options))));

  app.post('/settings', guard, async (c) => {
    if (!settings) return notFound(c);
    const form = await c.req.parseBody({ all: true });
    // A toggle posts a hidden "false" then, when on, "true"; the last value wins.
    const changes = FORM_FIELDS.filter((key) => settings.get(key).source !== 'env' && form[key] !== undefined)
      .map((key): [SettingKey, string] => [key, String([form[key]].flat().at(-1))])
      .filter(([key, value]) => value !== String(settings.value(key)));
    try {
      for (const [key, value] of changes) settings.set(key, value);
    } catch (e) {
      return c.html(page(c, 'Settings', html`${settingsView(c, hub, options)}${toast((e as Error).message, 'error')}`), 400);
    }
    if (changes.length) log(c, 'settings_saved', Object.fromEntries(changes));
    // A theme change rebuilds the stylesheet; wait for it so the page links the new one.
    await stylesheet();
    return c.html(page(c, 'Settings', html`${settingsView(c, hub, options)}${toast('Settings saved and applied.')}`));
  });

  app.get('/servers/new', guard, (c) => c.html(page(c, 'New server', serverPage(hub, undefined, {}, configFile))));

  app.get('/servers/:name', guard, (c) => {
    const row = rowOf(hub, c.req.param('name') ?? '');
    if (!row) return notFound(c);
    return c.html(page(c, row.config.title ?? row.name, serverOverview(row, editable(), logsForServer(row.name).length)));
  });

  app.get('/servers/:name/logs', guard, (c) => {
    const row = rowOf(hub, c.req.param('name') ?? '');
    if (!row) return notFound(c);
    const entries = logsForServer(row.name);
    return c.html(page(c, `${row.config.title ?? row.name} logs`, html`<div id="server-logs" data-refresh>${serverHead(row, editable(), 'logs', entries.length)}${logsBlock(entries)}</div>`));
  });

  app.get('/servers/:name/edit', guard, (c) => {
    const name = c.req.param('name') ?? '';
    const raw = configFile?.raw(name);
    if (!raw) return notFound(c);
    return c.html(page(c, `${name} settings`, serverPage(hub, name, raw, configFile)));
  });

  const save = async (c: Context<Env>, existing: string | undefined) => {
    if (!configFile || configFile.readOnlyReason()) return c.text(`Forbidden: ${configFile?.readOnlyReason() ?? 'no server file'}`, 403);
    const form = await c.req.parseBody({ all: true });
    const name = existing ?? String(form.name ?? '').trim();
    const raw = toRaw(form);
    const fail = (message: string) => c.html(page(c, existing ? `Edit ${name}` : 'New server', serverPage(hub, existing, raw, configFile, message, name)), 400);
    if (!existing && !NAME.test(name)) return fail('Name: letters, digits, _ and - only.');
    if (!existing && hub.configs[name]) return fail(`A server named ${name} already exists.`);
    try {
      configFile.save(name, raw);
    } catch (e) {
      return fail((e as Error).message);
    }
    log(c, existing ? 'server_updated' : 'server_added', { server: name });
    await hub.reload();
    return c.redirect(`/servers?saved=${encodeURIComponent(name)}`, 303);
  };

  app.post('/servers', guard, (c) => save(c, undefined));

  app.post('/servers/:name', guard, async (c) => {
    const name = c.req.param('name') ?? '';
    if (!hub.configs[name]) return notFound(c);
    return save(c, name);
  });

  app.post('/servers/:name/delete', guard, async (c) => {
    const name = c.req.param('name') ?? '';
    if (!configFile || configFile.readOnlyReason()) return c.text('Forbidden: the server file is read-only', 403);
    if (!hub.configs[name]) return notFound(c);
    configFile.save(name, undefined);
    log(c, 'server_deleted', { server: name });
    await hub.reload();
    return c.redirect('/servers', 303);
  });
}

function settingsView(c: Context<Env>, hub: Hub, options: ConfigOptions): Fragment {
  const { settings, environment = [] } = options;
  const admin = settings?.get('adminTools');
  const hours = settings?.get('versionCheckHours');
  const healthOn = settings?.get('healthCheck');
  const health = settings?.get('healthCheckMinutes');
  const adminKeys = loadKeys(options.keysPath).filter((k) => isAdmin(k) && k.enabled).length;
  const updates = settings?.get('updateCheck');
  const autoOn = settings?.get('autoUpdate');
  const autoAt = settings?.get('autoUpdateTime');
  const mode = settings?.get('mode');
  const theme = settings?.get('theme');
  const editable = settings && [admin, hours, healthOn, health, updates, autoOn, autoAt, mode, theme].some((s) => s?.source !== 'env');
  const lockedValue = (value: string, env: string) => html`<span class="inline-flex flex-wrap items-center gap-2"><span>${value}</span>${locked(env)}</span>`;
  const toggle = (key: 'adminTools' | 'updateCheck' | 'autoUpdate' | 'healthCheck', label: string, on: boolean | undefined) =>
    html`<input type="hidden" name="${key}" value="false" /><input type="checkbox" class="toggle toggle-sm peer" name="${key}" value="true" aria-label="${label}" ${on ? 'checked' : ''} />`;
  const about = release.status();
  return html`<div id="settings">${pageHead('Settings', {
      sub: 'Every change is saved and applied at once. A padlock means the environment sets the value.',
      actions: editable ? html`<span class="badge badge-ghost gap-1.5" aria-live="polite" data-autosave-status>${icon('check', 'xs')}Saved automatically</span>` : '',
    })}
    <form method="post" action="/settings" data-autosave>
      ${box(html`
        ${section(
          html`${icon('wrench', 'sm')}Hub administration`,
          html`MCP Yard's own <span class="font-mono">yard-*</span> tools, for the keys allowed to administer the hub.`,
          html`${setting('Admin tools', admin?.source === 'env' ? lockedValue(admin.value ? 'on' : 'off', admin.env) : toggle('adminTools', 'Admin tools', admin?.value), 'Off removes them from every key at once.')}
            ${setting('Keys allowed', html`<a class="link link-primary" href="/keys">${plural(adminKeys, 'key')}</a>`)}
            ${yardTools()}`,
          { tone: 'warning' },
        )}
        ${section(
          'Updates',
          'MCP Yard checks the registries and tells you. It updates servers on its own only when you pick an hour.',
          html`${setting(
            'Check registries every',
            hours?.source === 'env'
              ? lockedValue(period(hours.value), hours.env)
              : html`<select class="select select-sm w-32" name="versionCheckHours" aria-label="Time between checks">${[...new Set([...PERIODS, hours?.value ?? 6])].map((h) => html`<option value="${h}" ${h === (hours?.value ?? 6) ? 'selected' : ''}>${period(h)}</option>`)}</select>`,
          )}
            ${setting(
              'Update automatically',
              switched(
                autoOn?.source === 'env' ? lockedValue(autoOn.value ? 'on' : 'off', autoOn.env) : toggle('autoUpdate', 'Update automatically', autoOn?.value),
                autoAt?.source === 'env'
                  ? lockedValue(autoAt.value, autoAt.env)
                  : html`<input type="time" class="input input-sm w-32 peer-not-checked:opacity-50" name="autoUpdateTime" value="${autoAt?.value ?? '02:00'}" required aria-label="Time of the automatic update" />`,
              ),
              html`Every unpinned package, once a day, hub time (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`,
            )}`,
        )}
        ${section(
          'Health',
          'MCP Yard pings every running server over MCP and logs a server that stops or starts answering. The dashboard shows the last results.',
          setting(
            'Check every',
            switched(
              healthOn?.source === 'env' ? lockedValue(healthOn.value ? 'on' : 'off', healthOn.env) : toggle('healthCheck', 'Automatic health check', healthOn?.value),
              health?.source === 'env'
                ? lockedValue(health.value ? `${health.value} min` : 'off', health.env)
                : html`<label class="input input-sm w-32 peer-not-checked:opacity-50"><input type="number" name="healthCheckMinutes" min="1" max="1440" value="${health?.value || 5}" required aria-label="Minutes between health checks" /><span class="opacity-50">min</span></label>`,
            ),
          ),
        )}
        ${section(
          'Appearance',
          'Each theme comes in a light and a dark version. The mode picks one, or follows the device.',
          html`${setting(
            'Theme',
            theme?.source === 'env'
              ? lockedValue(themeLabel(theme.value), theme.env)
              : html`<select class="select select-sm w-40" name="theme" aria-label="Theme">${THEME_NAMES.map((t) => html`<option value="${t}" ${t === theme?.value ? 'selected' : ''}>${themeLabel(t)}</option>`)}</select>`,
            html`<span class="font-mono">${THEMES[theme?.value ?? 'default'].join(' / ')}</span>`,
          )}
            ${setting(
            'Mode',
            mode?.source === 'env'
              ? lockedValue(mode.value, mode.env)
              : segRadio('mode', THEME_MODES.map((m) => ({ value: m, label: `${m[0]!.toUpperCase()}${m.slice(1)}` })), mode?.value ?? 'system', 'Mode'),
          )}`,
        )}
        ${section(
          'About',
          html`Release notes are on <a class="link link-primary" href="https://github.com/cedhuf/mcpyard/releases" target="_blank" rel="noreferrer">GitHub</a>.`,
          html`${setting('Version', html`<span class="font-mono">${about.current}</span>`)}
            ${setting(
              'Latest release',
              about.latest
                ? html`<span class="inline-flex flex-wrap items-center gap-2"><a class="link link-primary font-mono" href="${about.latest.url}" target="_blank" rel="noreferrer">${about.latest.version}</a>${about.newer ? tag('update available', { tone: 'primary', icon: 'up' }) : about.current === 'dev' ? '' : tag('up to date', { tone: 'success', icon: 'check' })}</span>`
                : html`<span class="text-base-content/50">${updates?.value ? (about.error ?? 'not checked yet') : 'not checked'}</span>`,
            )}
            ${setting('Check for new releases', updates?.source === 'env' ? lockedValue(updates.value ? 'on' : 'off', updates.env) : toggle('updateCheck', 'Check for new releases', updates?.value), 'Asks GitHub every few hours. MCP Yard never updates itself.')}`,
          { id: 'about' },
        )}
        ${section(
          'Environment',
          "Read once at startup. Change them in the container's environment, then restart.",
          html`<dl class="divide-y divide-base-300">${environment.map(
            (row) => html`<div class="grid sm:grid-cols-[auto_minmax(0,1fr)] gap-x-6 py-1.5 first:pt-0 last:pb-0"><dt class="font-mono font-medium">${row.env}</dt><dd class="font-mono text-base-content/60 truncate sm:text-right" title="${row.secret ? '' : (row.value ?? '')}">${row.value === undefined || row.value === '' ? html`<span class="opacity-60">not set</span>` : row.secret ? '••••••••' : row.value}</dd></div>`,
          )}</dl>`,
        )}
      `)}
      <noscript><div class="mt-4 flex justify-end"><button class="btn btn-sm btn-primary">Save settings</button></div></noscript>
    </form></div>`;
}

/** The admin tools, folded by default: read-only ones first, each with the first sentence of its description. */
function yardTools(): Fragment {
  const tools = [...YARD_TOOLS].sort((a, b) => Number(!a.tool.annotations?.readOnlyHint) - Number(!b.tool.annotations?.readOnlyHint));
  const reading = tools.filter((t) => t.tool.annotations?.readOnlyHint).length;
  return html`<details class="collapse collapse-arrow border-t border-base-300 rounded-none">
    <summary class="collapse-title px-0 py-2.5 min-h-0 after:end-1 font-medium">Tools <span class="font-normal text-base-content/50">${tools.length}: ${reading} read-only, ${tools.length - reading} that change things</span></summary>
    <ul class="collapse-content px-0 grid gap-x-6 gap-y-3 sm:grid-cols-2">${tools.map(
      (t) => html`<li class="min-w-0">
        <div class="flex items-center gap-2"><span class="font-mono font-medium truncate">yard-${t.tool.name}</span>${t.tool.annotations?.readOnlyHint ? tag('read') : tag('changes', { tone: 'warning' })}</div>
        <p class="text-xs text-base-content/60">${t.tool.description?.split(/(?<=\.)\s/)[0]}</p>
      </li>`,
    )}</ul>
  </details>`;
}

const themeLabel = (name: string) => `${name[0]!.toUpperCase()}${name.slice(1)}`;
const PERIODS = [0, 6, 24, 168, 720];
const period = (hours: number) =>
  ({ 0: 'Off', 6: '6 hours', 24: '1 day', 168: '1 week', 720: '1 month' })[hours] ?? `${hours} hours`;
const switched = (toggle: Fragment, field: Fragment) => html`<span class="inline-flex flex-wrap items-center gap-3">${toggle}${field}</span>`;

const lines = (value: unknown) =>
  String(value ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const pairs = (value: unknown, separator: RegExp) =>
  Object.fromEntries(
    lines(value).flatMap((line) => {
      const m = line.match(separator);
      return m ? [[line.slice(0, m.index).trim(), line.slice(m.index! + m[0].length).trim()]] : [];
    }),
  );

const globs = (value: unknown) =>
  String(value ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);

/** The form's fields as a server entry, keeping only what differs from the defaults so the file stays short. */
function toRaw(form: Record<string, unknown>): RawServer {
  const one = (k: string) => String([form[k] ?? ''].flat().at(-1) ?? '').trim();
  const kind = one('kind');
  const raw: RawServer = {};
  if (one('title')) raw.title = one('title');
  if (kind === 'npm' || kind === 'pypi') {
    raw.package = { [kind]: one('package'), ...(one('version') ? { version: one('version') } : {}), ...(one('bin') ? { bin: one('bin') } : {}) };
  } else if (kind === 'command') {
    raw.command = one('command');
    if (one('cwd')) raw.cwd = one('cwd');
  } else {
    raw.url = one('url');
    if (one('transport') === 'sse') raw.transport = 'sse';
    const headers = pairs(form.headers, /:\s?/);
    if (Object.keys(headers).length) raw.headers = headers;
  }
  if (kind !== 'url' && lines(form.args).length) raw.args = lines(form.args);
  const env = pairs(form.env, /=/);
  if (kind !== 'url' && Object.keys(env).length) raw.env = env;
  const allow = globs(form.allow);
  const deny = globs(form.deny);
  if (allow.length || deny.length) raw.tools = { ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}) };
  if ((kind === 'npm' || kind === 'pypi') && [form.allowScripts].flat().includes('true')) raw.allowScripts = true;
  if (![form.enabled].flat().includes('true')) raw.enabled = false;
  return raw;
}

function serverPage(hub: Hub, name: string | undefined, raw: RawServer, file: ConfigFile | undefined, error?: string, typedName?: string): Fragment {
  const readOnly = file ? file.readOnlyReason() : 'there is no server file';
  const pkg = (raw.package ?? {}) as Record<string, string>;
  const kind = raw.package ? (pkg.pypi !== undefined ? 'pypi' : 'npm') : raw.command !== undefined ? 'command' : raw.url !== undefined ? 'url' : 'npm';
  const text = (v: unknown) => (v === undefined ? '' : String(v));
  const tools = (raw.tools ?? {}) as { allow?: string[]; deny?: string[] };
  const record = (v: unknown, sep: string) =>
    Object.entries((v ?? {}) as Record<string, unknown>)
      .map(([k, x]) => `${k}${sep}${String(x)}`)
      .join('\n');
  const input = (fieldName: string, value: string, placeholder = '') => html`<input class="input input-sm" name="${fieldName}" value="${value}" placeholder="${placeholder}" />`;
  const area = (fieldName: string, value: string, placeholder = '') => html`<textarea class="textarea textarea-sm font-mono" name="${fieldName}" rows="3" placeholder="${placeholder}">${value}</textarea>`;
  const kinds = [
    ['npm', 'npm'],
    ['pypi', 'PyPI'],
    ['command', 'Command'],
    ['url', 'Remote URL'],
  ] as const;
  const row = name ? rowOf(hub, name) : undefined;
  return html`${row ? serverHead(row, !readOnly, 'settings', logsForServer(row.name).length) : pageHead('New server', { crumbs: [{ label: 'Servers', href: '/servers' }, { label: 'New server' }], sub: 'It is added to the server file and starts at once.' })}
    <div class="grid gap-4">
    ${readOnly ? note(`Read-only: ${readOnly}. Mount the server file read-write to edit servers here, or edit it by hand and reload.`, 'warning') : ''}
    ${error ? note(html`Not saved: <span class="font-mono whitespace-pre-wrap">${error}</span>`, 'error') : ''}
    <form method="post" action="${name ? `/servers/${name}` : '/servers'}" class="grid gap-4">
      <fieldset class="contents" ${readOnly ? 'disabled' : ''}>
        ${box(html`
          ${section(
            'Source',
            'Where the server comes from. Packages are installed and versioned by the hub.',
            fields(html`
              ${field(
                'Kind',
                segRadio('kind', kinds.map(([value, label]) => ({ value, label })), kind, 'Kind'),
                { wide: true },
              )}
              ${name ? '' : field('Name', html`<input class="input input-sm" name="name" required pattern="[A-Za-z0-9_\\-]+" value="${typedName ?? ''}" placeholder="mail" />`, { hint: html`Prefixes every tool: <span class="font-mono">name-tool</span>.` })}
              ${field('Title', input('title', text(raw.title), 'Mail'), { hint: 'Shown here only. Tools keep the name.' })}
              ${field('Package', input('package', pkg.npm ?? pkg.pypi ?? '', '@scope/mcp-server'), { kinds: 'npm pypi' })}
              ${field('Version', input('version', pkg.version ?? '', 'latest, owned by the hub'), { kinds: 'npm pypi', hint: 'Set it to pin the version.' })}
              ${field('Command', input('command', text(raw.command), '/usr/local/bin/my-server'), { kinds: 'command' })}
              ${field('Working directory', input('cwd', text(raw.cwd)), { kinds: 'command' })}
              ${field('URL', input('url', text(raw.url), 'https://example.lan/mcp'), { kinds: 'url' })}
              ${field('Transport', html`<select class="select select-sm" name="transport"><option value="streamable-http">Streamable HTTP</option><option value="sse" ${raw.transport === 'sse' ? 'selected' : ''}>SSE (legacy)</option></select>`, { kinds: 'url' })}
            `),
          )}
          ${section(
            'Launch',
            html`<span class="font-mono">\${VAR}</span> reads the hub's environment. Nothing else is passed to the process.`,
            fields(html`
              ${field('Arguments', area('args', ((raw.args ?? []) as unknown[]).map(String).join('\n'), 'one per line'))}
              ${field('Environment', area('env', record(raw.env, '='), 'TOKEN=\${TOKEN}'), { hint: html`One <span class="font-mono">NAME=value</span> per line.` })}
            `),
            { kinds: 'npm pypi command' },
          )}
          ${section(
            'Connection',
            'Headers sent with every request, for example a bearer token.',
            fields(field('Headers', area('headers', record(raw.headers, ': '), 'Authorization: Bearer \${TOKEN}'), { wide: true, hint: html`One <span class="font-mono">Name: value</span> per line.` })),
            { kinds: 'url' },
          )}
          ${section(
            'Tools',
            "Globs on the server's own tool names. Keys can narrow this further, never widen it.",
            fields(html`
              ${field('Allow', input('allow', (tools.allow ?? []).join(', '), 'all tools'))}
              ${field('Deny', input('deny', (tools.deny ?? []).join(', '), 'delete_*'))}
            `),
          )}
          ${section(
            'Advanced',
            'Rarely needed.',
            fields(html`
              ${field('Bin', input('bin', pkg.bin ?? '', 'when the package has several'), { kinds: 'npm pypi' })}
              ${field('Install scripts', checkbox('allowScripts', 'true', 'Allow', !!raw.allowScripts), { kinds: 'npm pypi', hint: 'Only for packages that need a build step.' })}
              ${field('In the server file', checkbox('enabled', 'true', 'Enabled', raw.enabled !== false, 'toggle'), { hint: 'Off keeps the entry but never starts it.' })}
            `),
          )}
        `)}
        <div class="savebar sticky bottom-3 z-20 flex flex-wrap items-center justify-end gap-2 rounded-box border border-base-300 bg-base-100/85 py-2.5 pl-5 pr-3 shadow-sm">
          <span class="flex-1 text-[13px] text-base-content/50">${readOnly ? 'The server file is read-only.' : name ? 'Saving restarts this server only.' : 'The server starts as soon as it is added.'}</span>
          ${linkButton(name ? `/servers/${name}` : '/servers', readOnly ? 'Back' : 'Cancel', { tone: 'ghost' })}
          ${readOnly ? '' : html`<button class="btn btn-sm btn-primary">${name ? 'Save and restart' : 'Add server'}</button>`}
        </div>
      </fieldset>
    </form>
    </div>`;
}
