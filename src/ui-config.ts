import type { Context, Hono, MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import type { ConfigFile, RawServer } from './config.ts';
import type { Hub } from './front.ts';
import { loadKeys, reaches } from './keys.ts';
import { THEME_MODES, THEMES, type SettingKey, type Settings } from './settings.ts';
import { release } from './release.ts';
import { alert, badge, checkbox, field, formGrid, kv, linkButton, pageHead, panel, postButton, table } from './ui-kit.ts';
import { icon, locked, log, page, toast, type Env, type Fragment } from './ui-layout.ts';

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
const FORM_FIELDS: SettingKey[] = ['adminEndpoint', 'versionCheckHours', 'updateCheck', 'theme', 'lightTheme', 'darkTheme'];
const ADMIN_TOOLS = ['list_servers', 'get_server', 'restart_server', 'update_server', 'reload_config'];

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

  app.get('/servers/new', guard, (c) => c.html(page(c, 'New server', serverPage(undefined, {}, configFile))));

  app.get('/servers/:name/edit', guard, (c) => {
    const name = c.req.param('name') ?? '';
    const raw = configFile?.raw(name);
    if (!raw) return c.text('Not found', 404);
    return c.html(page(c, `Edit ${name}`, serverPage(name, raw, configFile)));
  });

  const save = async (c: Context<Env>, existing: string | undefined) => {
    if (!configFile || configFile.readOnlyReason()) return c.text(`Forbidden: ${configFile?.readOnlyReason() ?? 'no server file'}`, 403);
    const form = await c.req.parseBody({ all: true });
    const name = existing ?? String(form.name ?? '').trim();
    const raw = toRaw(form);
    const fail = (message: string) => c.html(page(c, existing ? `Edit ${name}` : 'New server', serverPage(existing, raw, configFile, message, name)), 400);
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
  const admin = settings?.get('adminEndpoint');
  const hours = settings?.get('versionCheckHours');
  const adminKeys = loadKeys(options.keysPath).filter((k) => reaches(k, 'admin') && k.enabled).length;
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
  return html`${pageHead('Settings', { subtitle: 'Applied at once, without a restart. A padlock means the environment sets it.' })}
    <form method="post" action="/settings">
      <div class="settings-grid">
        ${panel(
          html`${kv(
            'Enabled',
            admin?.source === 'env'
              ? lockedValue(admin.value ? 'yes' : 'no', admin.env)
              : html`<input type="hidden" name="adminEndpoint" value="false" /><input type="checkbox" class="toggle toggle-primary" name="adminEndpoint" value="true" aria-label="Admin endpoint enabled" ${admin?.value ? 'checked' : ''} />`,
          )}
          ${kv('URL', html`<code class="mono break-all">${options.base(c)}/admin/mcp</code>`)}
          ${kv('Admin keys', html`${adminKeys} active · <a class="link link-primary" href="/keys">create one</a> with kind <em>admin</em> or <em>both</em>`)}
          ${kv('Tools', html`<span class="row-wrap justify-end">${ADMIN_TOOLS.map((t) => badge(t, { mono: true }))}</span>`)}`,
          { title: 'Admin endpoint', description: 'A second MCP endpoint for agents that watch and manage the hub. Only admin and both keys reach it; client keys never do.' },
        )}
        ${panel(
          kv(
            'Check registries every',
            hours?.source === 'env'
              ? lockedValue(`${hours.value} h`, hours.env)
              : html`<label class="input input-sm w-32"><input type="number" name="versionCheckHours" min="1" max="168" value="${hours?.value ?? 6}" /><span class="muted">hours</span></label>`,
          ),
          { title: 'Updates', description: 'The hub only checks registries for new versions; it never updates on its own.' },
        )}
        ${panel(
          html`${kv(
            'Theme',
            mode?.source === 'env'
              ? lockedValue(mode.value, mode.env)
              : html`<div class="join">${THEME_MODES.map((m) => html`<label class="btn btn-sm join-item seg"><input type="radio" class="hidden-radio" name="theme" value="${m}" ${m === mode?.value ? 'checked' : ''} />${m}</label>`)}</div>`,
          )}
          ${kv('Light theme', themeSelect('lightTheme'))}
          ${kv('Dark theme', themeSelect('darkTheme'))}`,
          { title: 'Appearance', description: html`<em>system</em> follows the device's light or dark preference; the two themes are daisyUI themes.` },
        )}
        ${panel(
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
          { title: 'About MCP Yard', description: html`Releases and their notes are on <a class="link link-primary" href="https://github.com/cedhuf/mcpyard/releases" target="_blank" rel="noreferrer">GitHub</a>. The hub tells you; it never updates itself.` },
        )}
      </div>
      ${editable ? html`<div class="mt-4"><button class="btn btn-primary">Save settings</button></div>` : ''}
    </form>
    <h2 class="section-title">Environment</h2>
    <p class="muted text-sm mb-4">Read once at startup from the environment (your <span class="mono">.env</span>). Change them there and restart the container.</p>
    ${table(
      [],
      environment.map(
        (row) => html`<tr>
          <td class="w-px">${locked(row.env)}</td>
          <td class="mono break-all">${row.value === undefined || row.value === '' ? html`<span class="muted">not set</span>` : row.secret ? '••••••••' : row.value}</td>
        </tr>`,
      ),
    )}`;
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

function serverPage(name: string | undefined, raw: RawServer, file: ConfigFile | undefined, error?: string, typedName?: string): Fragment {
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
  return html`${pageHead(name ? html`Edit <span class="mono">${name}</span>` : 'New server', { subtitle: 'Saved into the server file; only this server restarts.' })}
    ${readOnly ? alert(`Servers cannot be edited here: ${readOnly}. Mount the server file read-write to edit it from the UI, or edit it by hand and reload.`, 'warning') : ''}
    ${error ? alert(html`<div class="font-medium">Not saved:</div><pre class="mono">${error}</pre>`, 'error') : ''}
    <form method="post" action="${name ? `/servers/${name}` : '/servers'}">
      ${panel(
        html`<fieldset class="contents" ${readOnly ? 'disabled' : ''}>
          ${formGrid(html`
            ${field(
              'Kind',
              html`<div class="join flex-wrap">${kinds.map(([value, label, ic]) => html`<label class="btn btn-sm join-item seg gap-2"><input type="radio" class="hidden-radio" name="kind" value="${value}" ${kind === value ? 'checked' : ''} />${icon(ic, 'sm')}${label}</label>`)}</div>`,
              { wide: true },
            )}
            ${name ? '' : field('Name', html`<input class="input" name="name" required pattern="[A-Za-z0-9_\\-]+" value="${typedName ?? ''}" placeholder="mail" />`, { hint: html`Prefixes every tool: <span class="mono">name-tool</span>. Keep it short.` })}
            ${field('Package', input('package', pkg.npm ?? pkg.pypi ?? '', '@scope/mcp-server'), { kinds: 'npm pypi' })}
            ${field('Version', input('version', pkg.version ?? '', 'empty: the hub owns it'), { kinds: 'npm pypi', hint: 'Set it to pin the version.' })}
            ${field('Bin', input('bin', pkg.bin ?? '', 'only if the package has several'), { kinds: 'npm pypi' })}
            ${field('Install', checkbox('allowScripts', 'true', 'Allow install scripts', !!raw.allowScripts), { kinds: 'npm pypi' })}
            ${field('Command', input('command', text(raw.command), '/usr/local/bin/my-server'), { kinds: 'command' })}
            ${field('Working directory', input('cwd', text(raw.cwd)), { kinds: 'command' })}
            ${field('URL', input('url', text(raw.url), 'https://example.lan/mcp'), { kinds: 'url' })}
            ${field('Transport', html`<select class="select" name="transport"><option value="streamable-http">Streamable HTTP</option><option value="sse" ${raw.transport === 'sse' ? 'selected' : ''}>SSE (legacy)</option></select>`, { kinds: 'url' })}
            ${field('Headers', area('headers', record(raw.headers, ': '), 'Authorization: Bearer \${TOKEN}'), { kinds: 'url', wide: true })}
            ${field('Arguments', area('args', ((raw.args ?? []) as unknown[]).map(String).join('\n'), 'one per line'), { kinds: 'npm pypi command' })}
            ${field('Environment', area('env', record(raw.env, '='), 'TOKEN=\${TOKEN}'), { kinds: 'npm pypi command', hint: html`One <span class="mono">NAME=value</span> per line; <span class="mono">\${VAR}</span> reads the hub's environment.` })}
            ${field('Allow tools', input('allow', (tools.allow ?? []).join(', '), 'empty: all'), { hint: "Globs on the server's own tool names." })}
            ${field('Deny tools', input('deny', (tools.deny ?? []).join(', '), 'delete_*'))}
            ${field('State', checkbox('enabled', 'true', 'Enabled', raw.enabled !== false, 'toggle'))}
          `)}
          <div class="row-wrap mt-4">
            ${readOnly ? '' : html`<button class="btn btn-primary">${name ? 'Save and restart' : 'Add server'}</button>`}
            ${linkButton('/', 'Cancel')}
          </div>
        </fieldset>`,
      )}
    </form>
    ${name && !readOnly
      ? html`<div class="mt-4">${postButton(`/servers/${name}/delete`, 'Remove server', { size: 'sm', tone: 'danger', icon: 'trash', confirm: `Remove ${name} from the server file? It stops now.` })}</div>`
      : ''}`;
}
