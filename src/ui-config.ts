import type { Context, Hono, MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import type { ConfigFile, RawServer } from './config.ts';
import type { Hub } from './front.ts';
import { isAdmin, loadKeys } from './keys.ts';
import { YARD_TOOLS } from './yard.ts';
import { THEME_MODES, THEMES, type SettingKey, type Settings } from './settings.ts';
import { release } from './release.ts';
import { alert, badge, checkbox, field, formGrid, kv, linkButton, pageHead, panel, postButton, section } from './ui-kit.ts';
import { icon, locked, log, page, toast, type Env, type Fragment } from './ui-layout.ts';
import { rowOf, serverSummary, toolsSection } from './ui-servers.ts';

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
const FORM_FIELDS: SettingKey[] = ['adminTools', 'versionCheckHours', 'updateCheck', 'theme', 'lightTheme', 'darkTheme'];

export function configRoutes(app: Hono<Env>, hub: Hub, guard: MiddlewareHandler<Env>, options: ConfigOptions): void {
  const { settings, configFile } = options;

  app.get('/settings', guard, (c) => c.html(page(c, 'Settings', settingsView(c, hub, options))));

  app.post('/settings', guard, async (c) => {
    if (!settings) return c.text('Not found', 404);
    const form = await c.req.parseBody({ all: true });
    // A toggle posts a hidden "false" then, when on, "true"; the last value wins.
    const changes = FORM_FIELDS.filter((key) => settings.get(key).source !== 'env' && form[key] !== undefined).map(
      (key): [SettingKey, string] => [key, String([form[key]].flat().at(-1))],
    );
    try {
      for (const [key, value] of changes) settings.set(key, value);
    } catch (e) {
      return c.html(page(c, 'Settings', html`${settingsView(c, hub, options)}${toast((e as Error).message, 'error')}`), 400);
    }
    log(c, 'settings_saved', Object.fromEntries(changes));
    return c.html(page(c, 'Settings', html`${settingsView(c, hub, options)}${toast('Settings saved and applied.')}`));
  });

  app.get('/servers/new', guard, (c) => c.html(page(c, 'New server', serverPage(hub, undefined, {}, configFile))));

  app.get('/servers/:name/edit', guard, (c) => {
    const name = c.req.param('name') ?? '';
    const raw = configFile?.raw(name);
    if (!raw) return c.text('Not found', 404);
    return c.html(page(c, `Edit ${name}`, serverPage(hub, name, raw, configFile)));
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
    return c.redirect(`/?saved=${encodeURIComponent(name)}`, 303);
  };

  app.post('/servers', guard, (c) => save(c, undefined));

  app.post('/servers/:name', guard, async (c) => {
    const name = c.req.param('name') ?? '';
    if (!hub.configs[name]) return c.text('Not found', 404);
    return save(c, name);
  });

  app.post('/servers/:name/delete', guard, async (c) => {
    const name = c.req.param('name') ?? '';
    if (!configFile || configFile.readOnlyReason()) return c.text('Forbidden: the server file is read-only', 403);
    if (!hub.configs[name]) return c.text('Not found', 404);
    configFile.save(name, undefined);
    log(c, 'server_deleted', { server: name });
    await hub.reload();
    return c.redirect('/', 303);
  });
}

function settingsView(c: Context<Env>, hub: Hub, options: ConfigOptions): Fragment {
  const { settings, environment = [] } = options;
  const admin = settings?.get('adminTools');
  const hours = settings?.get('versionCheckHours');
  const adminKeys = loadKeys(options.keysPath).filter((k) => isAdmin(k) && k.enabled).length;
  const updates = settings?.get('updateCheck');
  const mode = settings?.get('theme');
  const light = settings?.get('lightTheme');
  const dark = settings?.get('darkTheme');
  const editable = settings && [admin, hours, updates, mode, light, dark].some((s) => s?.source !== 'env');
  const themeSelect = (key: 'lightTheme' | 'darkTheme') => {
    const setting = settings?.get(key);
    return setting?.source === 'env'
      ? lockedValue(setting.value, setting.env)
      : html`<select class="select select-sm w-44" name="${key}">${THEMES.map((t) => html`<option value="${t}" ${t === setting?.value ? 'selected' : ''}>${t}</option>`)}</select>`;
  };
  const about = release.status();
  const lockedValue = (value: string, env: string) => html`<span class="row-wrap"><strong>${value}</strong>${locked(env)}</span>`;
  const setEnv = environment.filter((row) => row.value !== undefined && row.value !== '').length;
  return html`${pageHead('Settings', { subtitle: 'Applied at once, without a restart. A padlock means the environment sets it.' })}
    <form method="post" action="/settings">
      <div class="sections">
        <section class="section admin-section">
          <div class="section-side"><h2>${icon('wrench')}Hub administration</h2>
            <p>MCP Yard's own <span class="mono">yard-*</span> tools, served in <span class="mono">/mcp</span> to the keys allowed to administer the hub. Off here means off for every key.</p></div>
          <div class="section-main">
            ${kv(
              'Enabled',
              admin?.source === 'env'
                ? lockedValue(admin.value ? 'yes' : 'no', admin.env)
                : html`<input type="hidden" name="adminTools" value="false" /><input type="checkbox" class="toggle toggle-warning" name="adminTools" value="true" aria-label="Hub administration enabled" ${admin?.value ? 'checked' : ''} />`,
            )}
            ${kv('Keys allowed', html`${adminKeys} · <a class="link link-primary" href="/keys">manage keys</a>`)}
            ${kv('Tools', html`<span class="row-wrap justify-end">${YARD_TOOLS.map((t) => badge(`yard-${t.tool.name}`, { mono: true, small: true }))}</span>`)}
          </div>
        </section>
        ${section(
          'Updates',
          'The hub checks registries for new versions of your servers. It never updates on its own.',
          kv(
            'Check registries every',
            hours?.source === 'env'
              ? lockedValue(`${hours.value} h`, hours.env)
              : html`<label class="input input-sm w-32"><input type="number" name="versionCheckHours" min="1" max="168" value="${hours?.value ?? 6}" /><span class="muted">hours</span></label>`,
          ),
        )}
        ${section(
          'Appearance',
          html`<em>system</em> follows the device's light or dark preference. Both themes are daisyUI themes.`,
          html`${kv(
            'Theme',
            mode?.source === 'env'
              ? lockedValue(mode.value, mode.env)
              : html`<div class="join">${THEME_MODES.map((m) => html`<label class="btn btn-sm join-item seg"><input type="radio" class="hidden-radio" name="theme" value="${m}" ${m === mode?.value ? 'checked' : ''} />${m}</label>`)}</div>`,
          )}
          ${kv('Light theme', themeSelect('lightTheme'))}
          ${kv('Dark theme', themeSelect('darkTheme'))}`,
        )}
        ${section(
          'About MCP Yard',
          html`Release notes are on <a class="link link-primary" href="https://github.com/cedhuf/mcpyard/releases" target="_blank" rel="noreferrer">GitHub</a>. The hub tells you about a new release; it never updates itself.`,
          html`${kv('Version', html`<span class="mono">${about.current}</span>`)}
          ${kv(
            'Latest release',
            about.latest
              ? html`<span class="row-wrap justify-end"><a class="link link-primary mono" href="${about.latest.url}" target="_blank" rel="noreferrer">${about.latest.version}</a>${about.newer ? badge('update available', { tone: 'primary', soft: true, icon: 'up' }) : about.current === 'dev' ? '' : badge('up to date', { tone: 'success', soft: true, icon: 'check' })}</span>`
              : html`<span class="muted">${updates?.value ? (about.error ?? 'not checked yet') : 'not checked'}</span>`,
          )}
          ${kv(
            'Check GitHub for new releases',
            updates?.source === 'env'
              ? lockedValue(updates.value ? 'yes' : 'no', updates.env)
              : html`<input type="hidden" name="updateCheck" value="false" /><input type="checkbox" class="toggle toggle-primary" name="updateCheck" value="true" aria-label="Check GitHub for new releases" ${updates?.value ? 'checked' : ''} />`,
          )}`,
        )}
        ${section(
          'Environment',
          html`Read once at startup. Change them in the container's environment and restart.`,
          html`<details class="fold-panel">
            <summary class="fold-toggle">${icon('lock', 'xs')}Show the ${environment.length} startup variables <span class="muted">(${setEnv} set)</span><span class="chevron sm" aria-hidden="true"></span></summary>
            <div class="tools-scroll"><table class="tools-table">${environment.map(
              (row) => html`<tr>
                  <td class="mono">${row.env}</td>
                  <td class="mono break-all">${row.value === undefined || row.value === '' ? html`<span class="muted">not set</span>` : row.secret ? '••••••••' : row.value}</td>
                </tr>`,
            )}</table></div>
          </details>`,
        )}
      </div>
      ${editable ? html`<div class="savebar"><span class="grow">Changes apply as soon as they are saved.</span><button class="btn btn-primary btn-sm">Save settings</button></div>` : ''}
    </form>`;
}

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
  const input = (fieldName: string, value: string, placeholder = '') => html`<input class="input" name="${fieldName}" value="${value}" placeholder="${placeholder}" />`;
  const area = (fieldName: string, value: string, placeholder = '') => html`<textarea class="textarea" name="${fieldName}" rows="3" placeholder="${placeholder}">${value}</textarea>`;
  const kinds = [
    ['npm', 'npm package', 'package'],
    ['pypi', 'PyPI package', 'package'],
    ['command', 'Command', 'terminal'],
    ['url', 'Remote URL', 'globe'],
  ] as const;
  const row = name ? rowOf(hub, name) : undefined;
  const top = row ? serverSummary(row, !readOnly) : undefined;
  return html`<a class="back-link" href="/">${icon('back', 'xs')}Servers</a>
    ${pageHead(name ? html`<span class="mono">${name}</span>` : 'New server', {
      subtitle: readOnly ? 'Read-only: these are the settings from the server file.' : 'Saved into the server file; only this server restarts.',
      actions: top?.controls,
    })}
    ${top?.summary ?? ''}
    ${readOnly ? alert(`Servers cannot be edited here: ${readOnly}. Mount the server file read-write to edit it from the UI, or edit it by hand and reload.`, 'warning') : ''}
    ${error ? alert(html`<div class="font-medium">Not saved:</div><pre class="mono">${error}</pre>`, 'error') : ''}
    <form method="post" action="${name ? `/servers/${name}` : '/servers'}">
      <fieldset class="contents" ${readOnly ? 'disabled' : ''}>
        <div class="sections">
          ${section(
            'Source',
            'Where the server comes from. Packages are installed and versioned by the hub.',
            formGrid(html`
              ${field(
                'Kind',
                html`<div class="join flex-wrap">${kinds.map(([value, label, ic]) => html`<label class="btn btn-sm join-item seg gap-2"><input type="radio" class="hidden-radio" name="kind" value="${value}" ${kind === value ? 'checked' : ''} />${icon(ic, 'sm')}${label}</label>`)}</div>`,
                { wide: true },
              )}
              ${name ? '' : field('Name', html`<input class="input" name="name" required pattern="[A-Za-z0-9_\\-]+" value="${typedName ?? ''}" placeholder="mail" />`, { hint: html`Prefixes every tool: <span class="mono">name-tool</span>. Keep it short.` })}
              ${field('Package', input('package', pkg.npm ?? pkg.pypi ?? '', '@scope/mcp-server'), { kinds: 'npm pypi' })}
              ${field('Version', input('version', pkg.version ?? '', 'empty: the hub owns it'), { kinds: 'npm pypi', hint: 'Set it to pin the version.' })}
              ${field('Command', input('command', text(raw.command), '/usr/local/bin/my-server'), { kinds: 'command' })}
              ${field('URL', input('url', text(raw.url), 'https://example.lan/mcp'), { kinds: 'url' })}
              ${field('Transport', html`<select class="select" name="transport"><option value="streamable-http">Streamable HTTP</option><option value="sse" ${raw.transport === 'sse' ? 'selected' : ''}>SSE (legacy)</option></select>`, { kinds: 'url' })}
            `),
          )}
          ${section(
            'Launch',
            html`Arguments and environment of the process. <span class="mono">\${VAR}</span> reads the hub's environment; nothing else is passed.`,
            formGrid(html`
              ${field('Arguments', area('args', ((raw.args ?? []) as unknown[]).map(String).join('\n'), 'one per line'), {})}
              ${field('Environment', area('env', record(raw.env, '='), 'TOKEN=\${TOKEN}'), { hint: html`One <span class="mono">NAME=value</span> per line.` })}
              ${field('Working directory', input('cwd', text(raw.cwd)), { kinds: 'command' })}
            `),
            { kinds: 'npm pypi command' },
          )}
          ${section(
            'Connection',
            'Headers sent with every request, for example a bearer token.',
            formGrid(field('Headers', area('headers', record(raw.headers, ': '), 'Authorization: Bearer \${TOKEN}'), { wide: true })),
            { kinds: 'url' },
          )}
          ${section(
            'Tools',
            "Globs on the server's own tool names. Keys can narrow this further, never widen it.",
            html`${formGrid(html`
              ${field('Allow tools', input('allow', (tools.allow ?? []).join(', '), 'empty: all'))}
              ${field('Deny tools', input('deny', (tools.deny ?? []).join(', '), 'delete_*'))}
            `)}${row ? html`<div class="mt-2">${toolsSection(row)}</div>` : ''}`,
          )}
          ${section(
            'Advanced',
            'Rarely needed.',
            formGrid(html`
              ${field('Bin', input('bin', pkg.bin ?? '', 'only if the package has several'), { kinds: 'npm pypi' })}
              ${field('Install', checkbox('allowScripts', 'true', 'Allow install scripts', !!raw.allowScripts), { kinds: 'npm pypi', hint: 'Only for packages that need a build step.' })}
              ${field('In the server file', checkbox('enabled', 'true', 'Enabled', raw.enabled !== false, 'toggle'), { hint: 'Off keeps the entry but never starts it. The switch at the top is the quicker way.' })}
            `),
          )}
        </div>
        <div class="savebar">
          <span class="grow">${readOnly ? 'The server file is read-only.' : name ? 'Saving restarts this server only.' : 'The server starts as soon as it is added.'}</span>
          ${linkButton('/', readOnly ? 'Back' : 'Cancel', { size: 'sm' })}
          ${readOnly ? '' : html`<button class="btn btn-primary btn-sm">${name ? 'Save and restart' : 'Add server'}</button>`}
        </div>
      </fieldset>
    </form>`;
}
