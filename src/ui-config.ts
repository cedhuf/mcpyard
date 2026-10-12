import type { Context, Hono, MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import type { ConfigFile, RawServer } from './config.ts';
import type { Hub } from './front.ts';
import { loadKeys } from './keys.ts';
import type { SettingKey, Settings } from './settings.ts';
import { LOCK, log, page, type Env, type Fragment } from './ui-layout.ts';

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
const ADMIN_TOOLS = ['list_servers', 'get_server', 'restart_server', 'update_server', 'reload_config'];

export function configRoutes(app: Hono<Env>, hub: Hub, guard: MiddlewareHandler<Env>, options: ConfigOptions): void {
  const { settings, configFile } = options;

  app.get('/settings', guard, (c) => c.html(page(c, 'Settings', settingsView(c, hub, options))));

  app.post('/settings', guard, async (c) => {
    if (!settings) return c.text('Not found', 404);
    const form = await c.req.parseBody({ all: true });
    const changes: [SettingKey, string][] = [];
    if (settings.get('adminEndpoint').source !== 'env') changes.push(['adminEndpoint', [form.adminEndpoint].flat().includes('true') ? 'true' : 'false']);
    if (settings.get('versionCheckHours').source !== 'env') changes.push(['versionCheckHours', String(form.versionCheckHours ?? '')]);
    try {
      for (const [key, value] of changes) settings.set(key, value);
    } catch (e) {
      return c.html(page(c, 'Settings', html`${notice((e as Error).message, true)}${settingsView(c, hub, options)}`), 400);
    }
    log(c, 'settings_saved', Object.fromEntries(changes));
    return c.html(page(c, 'Settings', html`${notice('Settings saved and applied.')}${settingsView(c, hub, options)}`));
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

function notice(message: string, failed = false): Fragment {
  return html`<section class="card notice ${failed ? 'failed' : ''}"><p>${message}</p></section>`;
}

function locked(env: string): Fragment {
  return html`<span class="locked" title="Set by ${env} in the environment; change it there and restart">${LOCK} ${env}</span>`;
}

function settingsView(c: Context<Env>, hub: Hub, options: ConfigOptions): Fragment {
  const { settings, environment = [] } = options;
  const admin = settings?.get('adminEndpoint');
  const hours = settings?.get('versionCheckHours');
  const adminKeys = loadKeys(options.keysPath).filter((k) => k.kind === 'admin' && k.enabled).length;
  return html`<section>
      <h1>Settings</h1>
      <form method="post" action="/settings" class="settings">
        <div class="card">
          <h2>Admin endpoint</h2>
          <p class="muted">A second MCP endpoint for agents that watch and manage the hub. Only admin keys reach it; client keys never do.</p>
          <div class="row">
            <span>Enabled</span>
            ${admin?.source === 'env'
              ? html`<span><strong>${admin.value ? 'yes' : 'no'}</strong> ${locked(admin.env)}</span>`
              : html`<label class="switch"><input type="hidden" name="adminEndpoint" value="false" /><input type="checkbox" name="adminEndpoint" value="true" ${admin?.value ? 'checked' : ''} /><span></span></label>`}
          </div>
          <div class="row"><span>URL</span><code>${options.base(c)}/admin/mcp</code></div>
          <div class="row"><span>Admin keys</span><span>${adminKeys} active · <a href="/keys">create one</a> with kind <em>admin</em></span></div>
          <div class="row"><span>Tools</span><span class="mono">${ADMIN_TOOLS.join(', ')}</span></div>
        </div>
        <div class="card">
          <h2>Updates</h2>
          <div class="row">
            <span>Check registries every</span>
            ${hours?.source === 'env'
              ? html`<span><strong>${hours.value} h</strong> ${locked(hours.env)}</span>`
              : html`<span><input type="number" name="versionCheckHours" min="1" max="168" value="${hours?.value ?? 6}" class="short" /> hours</span>`}
          </div>
          <p class="muted">The hub only checks; it never updates on its own.</p>
        </div>
        ${settings && (admin?.source !== 'env' || hours?.source !== 'env') ? html`<button class="primary">Save settings</button>` : ''}
      </form>
    </section>
    <section>
      <h2>Environment</h2>
      <p class="muted">Read once at startup from the environment (your <code>.env</code>). Change them there and restart the container.</p>
      <table>
        <tbody>
          ${environment.map(
            (row) => html`<tr>
              <td>${locked(row.env)}</td>
              <td class="mono">${row.value === undefined || row.value === '' ? html`<span class="muted">not set</span>` : row.secret ? '••••••••' : row.value}</td>
            </tr>`,
          )}
        </tbody>
      </table>
    </section>`;
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
  return html`<section>
    <h1>${name ? html`Edit server <span class="mono">${name}</span>` : 'New server'}</h1>
    ${readOnly ? html`<section class="card notice failed"><p>${LOCK} Servers cannot be edited here: ${readOnly}. Mount the server file read-write to edit it from the UI, or edit it by hand and reload.</p></section>` : ''}
    ${error ? html`<section class="card notice failed"><p>Not saved:</p><pre class="mono">${error}</pre></section>` : ''}
    <form method="post" action="${name ? `/servers/${name}` : '/servers'}" class="card wide">
      <fieldset class="plain" ${readOnly ? 'disabled' : ''}>
        ${name ? '' : html`<label>Name <input name="name" required pattern="[A-Za-z0-9_\\-]+" value="${typedName ?? ''}" placeholder="mail" /><span class="muted">Prefixes every tool: <span class="mono">name-tool</span>. Keep it short.</span></label>`}
        <label>Kind
          <select name="kind">
            <option value="npm" ${kind === 'npm' ? 'selected' : ''}>npm package, installed by the hub</option>
            <option value="pypi" ${kind === 'pypi' ? 'selected' : ''}>PyPI package, installed by the hub</option>
            <option value="command" ${kind === 'command' ? 'selected' : ''}>Command on the host</option>
            <option value="url" ${kind === 'url' ? 'selected' : ''}>Remote URL</option>
          </select>
        </label>
        <div class="grid" data-kinds="npm pypi">
          <label>Package <input name="package" value="${pkg.npm ?? pkg.pypi ?? ''}" placeholder="@scope/mcp-server" /></label>
          <label>Version <input name="version" value="${pkg.version ?? ''}" placeholder="empty: the hub owns it" /><span class="muted">Set to pin.</span></label>
          <label>Bin <input name="bin" value="${pkg.bin ?? ''}" placeholder="only if the package has several" /></label>
          <label class="check"><input type="checkbox" name="allowScripts" value="true" ${raw.allowScripts ? 'checked' : ''} /> Allow install scripts</label>
        </div>
        <div class="grid" data-kinds="command">
          <label>Command <input name="command" value="${text(raw.command)}" placeholder="/usr/local/bin/my-server" /></label>
          <label>Working directory <input name="cwd" value="${text(raw.cwd)}" /></label>
        </div>
        <div class="grid" data-kinds="url">
          <label>URL <input name="url" value="${text(raw.url)}" placeholder="https://example.lan/mcp" /></label>
          <label>Transport
            <select name="transport"><option value="streamable-http">Streamable HTTP</option><option value="sse" ${raw.transport === 'sse' ? 'selected' : ''}>SSE (legacy)</option></select>
          </label>
          <label class="span">Headers <textarea name="headers" rows="2" placeholder="Authorization: Bearer \${TOKEN}">${record(raw.headers, ': ')}</textarea></label>
        </div>
        <div class="grid" data-kinds="npm pypi command">
          <label>Arguments <textarea name="args" rows="2" placeholder="one per line">${((raw.args ?? []) as unknown[]).map(String).join('\n')}</textarea></label>
          <label>Environment <textarea name="env" rows="2" placeholder="TOKEN=\${TOKEN}">${record(raw.env, '=')}</textarea><span class="muted">One <span class="mono">NAME=value</span> per line. <span class="mono">\${VAR}</span> reads the hub's environment.</span></label>
        </div>
        <div class="grid">
          <label>Allow tools <input name="allow" value="${(tools.allow ?? []).join(', ')}" placeholder="empty: all" /><span class="muted">Globs on the server's own tool names.</span></label>
          <label>Deny tools <input name="deny" value="${(tools.deny ?? []).join(', ')}" placeholder="delete_*" /></label>
        </div>
        <label class="check"><input type="checkbox" name="enabled" value="true" ${raw.enabled === false ? '' : 'checked'} /> Enabled</label>
        <div class="buttons">
          ${readOnly ? '' : html`<button class="primary">${name ? 'Save and restart' : 'Add server'}</button>`}
          <a class="button" href="/">Cancel</a>
        </div>
      </fieldset>
    </form>
    ${name && !readOnly
      ? html`<form method="post" action="/servers/${name}/delete" data-confirm="Remove ${name} from the server file? It stops now." class="danger-zone"><button class="danger">Remove server</button></form>`
      : ''}
  </section>`;
}
