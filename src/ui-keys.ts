import type { Context, Hono, MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import type { Hub } from './front.ts';
import { isAdmin, loadKeys, newKey, saveKeys, type Key } from './keys.ts';
import { actions, badge, checkbox, empty, field, formGrid, linkButton, pageHead, panel, postButton, table } from './ui-kit.ts';
import { icon, log, page, toast, type Env, type Fragment } from './ui-layout.ts';

export function keyRoutes(app: Hono<Env>, hub: Hub, guard: MiddlewareHandler<Env>, options: { keysPath: string; base: (c: Context) => string }): void {
  const { keysPath } = options;

  app.get('/keys', guard, (c) => c.html(page(c, 'Keys', keysView(hub, loadKeys(keysPath)))));

  app.get('/keys/new', guard, (c) => c.html(page(c, 'New key', html`${pageHead('New key')}${panel(keyForm(hub))}`)));

  app.post('/keys', guard, async (c) => {
    const form = await c.req.parseBody({ all: true });
    const name = String(form.name ?? '').trim();
    if (!name || name.length > 64) return c.text('Bad request: name is required, 64 characters at most', 400);
    const { token, key } = newKey(name);
    key.scope = scopeFrom(form);
    const keys = loadKeys(keysPath);
    saveKeys(keysPath, [...keys, key]);
    log(c, 'key_created', { key: key.name });
    return c.html(page(c, 'Keys', html`${keysView(hub, [...keys, key])}${created(key, token, options.base(c))}`));
  });

  app.get('/keys/:id/edit', guard, (c) => {
    const key = loadKeys(keysPath).find((k) => k.id === c.req.param('id'));
    if (!key) return c.text('Not found', 404);
    return c.html(page(c, 'Edit key', html`${pageHead(html`Edit key <span class="mono">${key.name}</span>`)}${panel(keyForm(hub, key))}`));
  });

  app.post('/keys/:id', guard, async (c) => {
    const form = await c.req.parseBody({ all: true });
    const name = String(form.name ?? '').trim();
    if (!name || name.length > 64) return c.text('Bad request: name is required, 64 characters at most', 400);
    const keys = loadKeys(keysPath);
    const key = keys.find((k) => k.id === c.req.param('id'));
    if (!key) return c.text('Not found', 404);
    key.name = name;
    key.scope = scopeFrom(form);
    saveKeys(keysPath, keys);
    log(c, 'key_updated', { key: key.name });
    return c.redirect('/keys?saved=1', 303);
  });

  for (const action of ['enable', 'disable', 'delete'] as const) {
    app.post(`/keys/:id/${action}`, guard, (c) => {
      const id = c.req.param('id') ?? '';
      const keys = loadKeys(keysPath);
      const key = keys.find((k) => k.id === id);
      if (!key) return c.text('Not found', 404);
      if (action === 'delete') keys.splice(keys.indexOf(key), 1);
      else key.enabled = action === 'enable';
      saveKeys(keysPath, keys);
      log(c, `key_${action}`, { key: key.name });
      return c.redirect('/keys', 303);
    });
  }
}

function globs(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

function scopeFrom(form: Record<string, unknown>): Key['scope'] {
  const picked = ([] as unknown[]).concat(form.servers ?? []).map(String).filter((s) => s !== 'yard');
  const servers = picked.includes('*') ? ['*'] : picked;
  const admin = [form.admin].flat().at(-1) === 'true';
  const allow = globs(form.allow);
  const deny = globs(form.deny);
  return {
    servers: admin ? [...servers, 'yard'] : servers,
    tools: { ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}) },
  };
}

/** "3 h ago" style, coarse on purpose: `lastUsed` is only written once an hour. */
function ago(iso: string | null): string {
  if (!iso) return 'never';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return 'within the hour';
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

function keysView(hub: Hub, keys: Key[]): Fragment {
  const filter = (k: Key) =>
    [k.scope.tools.allow?.length ? `allow ${k.scope.tools.allow.join(', ')}` : '', k.scope.tools.deny?.length ? `deny ${k.scope.tools.deny.join(', ')}` : '']
      .filter(Boolean)
      .join(' · ') || 'all tools';
  const rows = keys.map(
    (k) => html`<tr class="${k.enabled ? '' : 'opacity-60'}">
      <td><div class="font-medium">${k.name}</div><div class="mono muted">${k.prefix}</div></td>
      <td><div class="row-wrap">${servers(k).length ? badge('tools', { tone: 'info', soft: true }) : ''}${isAdmin(k) ? badge('admin', { tone: 'warning', icon: 'wrench' }) : ''}${k.enabled ? '' : badge('disabled')}</div></td>
      <td><div class="row-wrap">${servers(k).includes('*') ? badge('all') : servers(k).length ? servers(k).map((s) => badge(s)) : html`<span class="muted">${isAdmin(k) ? 'manages all' : 'none'}</span>`}</div></td>
      <td class="mono">${filter(k)}</td>
      <td title="Created ${k.created.slice(0, 10)}">${ago(k.lastUsed)}</td>
      <td>${actions(html`${linkButton(`/keys/${k.id}/edit`, 'Edit', { size: 'xs' })}
        ${postButton(`/keys/${k.id}/${k.enabled ? 'disable' : 'enable'}`, k.enabled ? 'Disable' : 'Enable', { size: 'xs' })}
        ${postButton(`/keys/${k.id}/delete`, 'Delete', { size: 'xs', tone: 'danger', confirm: `Delete key ${k.name}? Clients using it lose access.` })}`)}</td>
    </tr>`,
  );
  return html`${pageHead('Keys', {
      subtitle: html`One key per client, all on <span class="mono">/mcp</span>. A key sees the tools of its servers, and the hub's own <span class="mono">yard-*</span> tools only when administration is allowed.`,
      actions: linkButton('/keys/new', 'New key', { tone: 'primary', size: 'sm', icon: 'plus', dialog: 'new-key' }),
    })}
    ${keys.length ? table(['Name', 'Access', 'Servers', 'Tools', 'Last used', ''], rows, 'keys-table') : empty('No keys yet. Create one for each client.')}
    <dialog id="new-key" class="modal">
      <div class="modal-box max-w-3xl">
        <h3 class="text-lg font-bold mb-4">New key</h3>
        ${keyForm(hub)}
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>`;
}

/** The key's servers, without the hub administration it may also have. */
function servers(key: Key): string[] {
  return key.scope.servers.filter((s) => s !== 'yard');
}

function keyForm(hub: Hub, key?: Key): Fragment {
  const scope = key?.scope ?? { servers: ['*'], tools: {} };
  const all = scope.servers.includes('*');
  const known = [...new Set([...hub.upstreams.keys(), ...(key ? servers(key) : []).filter((s) => s !== '*')])];
  return html`<form method="post" action="${key ? `/keys/${key.id}` : '/keys'}">
    ${formGrid(html`
      ${field('Name', html`<input class="input" name="name" required maxlength="64" placeholder="laptop-claude-code" value="${key?.name ?? ''}" />`, {
        hint: key ? 'The token does not change; create a new key to rotate it.' : undefined,
      })}
      ${field(
        'Servers',
        html`<div class="checks">${checkbox('servers', '*', 'All, including future ones', all)}
          ${known.map((s) => checkbox('servers', s, html`${s}${hub.upstreams.has(s) ? '' : html` <span class="muted">(not in the configuration)</span>`}`, !all && scope.servers.includes(s)))}</div>`,
        { wide: true, hint: 'Leave every box empty for a key that only administers the hub.' },
      )}
      ${field('Allow tools', html`<input class="input" name="allow" placeholder="mail-*, calendar-list_*" value="${scope.tools.allow?.join(', ') ?? ''}" />`, { hint: 'Globs on exposed names, empty for all.' })}
      ${field('Deny tools', html`<input class="input" name="deny" placeholder="*-delete_*, yard-update_server" value="${scope.tools.deny?.join(', ') ?? ''}" />`)}
    `)}
    <div class="admin-block mt-4">
      <div class="admin-head">${icon('wrench')}<strong>Hub administration</strong></div>
      <p>Adds MCP Yard's own <span class="mono">yard-*</span> tools to this key: list and inspect servers, restart them, update or roll back
        their packages, reload the server file. The key manages the servers it reaches, or all of them when it reaches none.</p>
      <label class="label cursor-pointer"><input type="hidden" name="admin" value="false" /><input type="checkbox" class="toggle toggle-warning" name="admin" value="true" ${key && isAdmin(key) ? 'checked' : ''} />
        Allow this key to administer the hub</label>
      <p class="hint">An assistant that also reads mail or web pages could be talked into using these tools; allow it only where it is needed.</p>
    </div>
    <div class="row-wrap mt-4"><button class="btn btn-primary">${key ? 'Save' : 'Create key'}</button>${linkButton('/keys', 'Cancel')}</div>
  </form>`;
}

function created(key: Key, token: string, base: string): Fragment {
  const command = `claude mcp add --transport http mcpyard ${base}/mcp --header "Authorization: Bearer ${token}"`;
  const secret = (id: string, value: string) =>
    html`<div class="secret"><code id="${id}">${value}</code><button type="button" class="btn btn-sm gap-1" data-copy="${id}">${icon('copy', 'xs')}<span>Copy</span></button></div>`;
  return html`<dialog class="modal modal-open" open>
    <div class="modal-box max-w-3xl">
      <h3 class="text-lg font-bold">Key ${key.name} created</h3>
      <p class="muted mt-1 mb-4">Copy the token now: it is shown once and only its hash is stored.</p>
      ${secret('new-token', token)}
      <p class="mt-4 mb-2 font-medium">Claude Code</p>
      ${secret('new-command', command)}
      <div class="modal-action">${linkButton('/keys', 'Done', { tone: 'primary' })}</div>
    </div>
  </dialog>
  ${toast(`Key ${key.name} created.`)}`;
}
