import type { Context, Hono, MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import type { Hub } from './front.ts';
import { isAdmin, loadKeys, newKey, saveKeys, type Key } from './keys.ts';
import { box, cell, checkbox, dialogButton, empty, hero, field, fields, linkButton, list, menu, onOff, pageHead, row, tag, title } from './ui-kit.ts';
import { plural } from './ui-servers.ts';
import { mascot } from './ui-icons.ts';
import { icon, log, notFound, page, toast, type Env, type Fragment } from './ui-layout.ts';

export function keyRoutes(app: Hono<Env>, hub: Hub, guard: MiddlewareHandler<Env>, options: { keysPath: string; base: (c: Context) => string }): void {
  const { keysPath } = options;

  app.get('/keys', guard, (c) => c.html(page(c, 'Keys', keysView(hub, loadKeys(keysPath), (c.req.query('q') ?? '').trim()))));

  app.get('/keys/new', guard, (c) => c.html(page(c, 'New key', html`${pageHead('New key', { crumbs: [{ label: 'Keys', href: '/keys' }, { label: 'New key' }] })}${box(keyForm(hub), { pad: true })}`)));

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
    if (!key) return notFound(c);
    return c.html(page(c, 'Edit key', html`${pageHead(key.name, { crumbs: [{ label: 'Keys', href: '/keys' }, { label: key.name }], sub: html`<span class="font-mono">${key.prefix}…</span>, created ${key.created.slice(0, 10)}, last used ${ago(key.lastUsed)}` })}${box(keyForm(hub, key), { pad: true })}`));
  });

  app.post('/keys/:id', guard, async (c) => {
    const form = await c.req.parseBody({ all: true });
    const name = String(form.name ?? '').trim();
    if (!name || name.length > 64) return c.text('Bad request: name is required, 64 characters at most', 400);
    const keys = loadKeys(keysPath);
    const key = keys.find((k) => k.id === c.req.param('id'));
    if (!key) return notFound(c);
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
      if (!key) return notFound(c);
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

function keyRow(k: Key): Fragment {
  const filter =
    [k.scope.tools.allow?.length ? `allow ${k.scope.tools.allow.join(', ')}` : '', k.scope.tools.deny?.length ? `deny ${k.scope.tools.deny.join(', ')}` : '']
      .filter(Boolean)
      .join(' · ') || 'all tools';
  const list = servers(k);
  const reach = list.includes('*') ? 'all servers' : list.length ? list.join(', ') : isAdmin(k) ? 'administration only' : 'no server';
  return row(
    html`${title(k.name, html`<span class="font-mono">${k.prefix}…</span><span class="lg:hidden"> · ${[list.length ? 'tools' : '', isAdmin(k) ? 'admin' : ''].filter(Boolean).join(' + ')}</span>`, { href: `/keys/${k.id}/edit` })}
      ${cell(html`<span class="flex gap-1">${list.length ? tag('tools') : ''}${isAdmin(k) ? tag('admin', { tone: 'warning', icon: 'wrench' }) : ''}</span>`, { hide: true })}
      ${cell(html`<span class="block max-w-48 truncate" title="${reach}">${reach}</span>`, { hide: true })}
      ${cell(html`<span class="block max-w-48 truncate font-mono text-xs" title="${filter}">${filter}</span>`, { hide: true })}
      ${cell(html`<span title="Created ${k.created.slice(0, 10)}">${ago(k.lastUsed)}</span>`, { hide: true })}`,
    {
      off: !k.enabled,
      end: html`${onOff(`/keys/${k.id}/${k.enabled ? 'disable' : 'enable'}`, k.enabled, `${k.enabled ? 'Disable' : 'Enable'} key ${k.name}`)}
        ${menu(`key-${k.id}`, `Actions for ${k.name}`, [
          { href: `/keys/${k.id}/edit`, label: 'Edit', icon: 'pencil' },
          { post: `/keys/${k.id}/delete`, label: 'Delete', icon: 'trash', danger: true, confirm: `Delete key ${k.name}? Clients using it lose access.` },
        ])}`,
    },
  );
}

function keysView(hub: Hub, all: Key[], q = ''): Fragment {
  const needle = q.toLowerCase();
  const keys = all.filter((k) => !needle || [k.name, k.prefix, ...k.scope.servers].some((v) => v.toLowerCase().includes(needle)));
  const off = all.filter((k) => !k.enabled).length;
  const admins = all.filter((k) => k.enabled && isAdmin(k)).length;
  return html`${pageHead('Keys', {
      sub: html`${plural(all.length, 'key')}${admins ? `, ${admins} with administration` : ''}${off ? `, ${off} off` : ''}. Every client connects to <span class="font-mono">/mcp</span> with its own key.`,
      actions: dialogButton('new-key', 'New key', { tone: 'primary', icon: 'key' }),
    })}
    ${q ? html`<div class="mb-3"><a class="badge badge-ghost gap-1" href="/keys" title="Clear the search">“${q}” ✕</a></div>` : ''}
    ${!all.length ? hero('No keys yet', 'Every client gets its own key, so you can see who calls what and switch one off without touching the others.', dialogButton('new-key', 'Make the first key', { tone: 'primary', icon: 'key' })) : !keys.length && q ? empty(html`<p>No key matches <strong>${q}</strong>.</p>`) : keys.length ? list(['Name', { label: 'Access', hide: true }, { label: 'Servers', hide: true }, { label: 'Tools', hide: true }, { label: 'Last used', hide: true }], keys.map(keyRow)) : empty('No keys yet. Create one for each client.')}
    <dialog id="new-key" class="modal">
      <div class="modal-box max-w-2xl">
        <h3 class="font-display text-xl font-semibold mb-4 flex items-center gap-2"><span class="text-secondary">${icon('key')}</span>New key</h3>
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
  return html`<form method="post" action="${key ? `/keys/${key.id}` : '/keys'}" class="grid gap-5">
    ${fields(html`
      ${field('Name', html`<input class="input input-sm" name="name" required maxlength="64" placeholder="laptop-claude-code" value="${key?.name ?? ''}" />`, {
        wide: true,
        hint: key ? 'The token does not change; create a new key to rotate it.' : 'One key per client, so you can turn each off on its own.',
      })}
      ${field(
        'Servers',
        html`<span class="flex flex-wrap gap-x-5 gap-y-1">${checkbox('servers', '*', 'All, including future ones', all)}
          ${known.map((s) => checkbox('servers', s, html`<span class="font-mono">${s}</span>${hub.upstreams.has(s) ? '' : html` <span class="text-base-content/50">(not in the configuration)</span>`}`, !all && scope.servers.includes(s)))}</span>`,
        { wide: true, hint: 'None for a key that only administers the hub.' },
      )}
      ${field('Allow tools', html`<input class="input input-sm font-mono" name="allow" placeholder="mail-*, calendar-list_*" value="${scope.tools.allow?.join(', ') ?? ''}" />`, { hint: 'Globs on exposed names. Empty for all.' })}
      ${field('Deny tools', html`<input class="input input-sm font-mono" name="deny" placeholder="*-delete_*" value="${scope.tools.deny?.join(', ') ?? ''}" />`)}
    `)}
    <label class="alert alert-soft alert-warning items-start cursor-pointer text-sm">
      <input type="hidden" name="admin" value="false" /><input type="checkbox" class="toggle toggle-sm toggle-warning mt-0.5" name="admin" value="true" ${key && isAdmin(key) ? 'checked' : ''} />
      <span class="grid gap-1"><strong class="flex items-center gap-1.5">${icon('wrench', 'xs')}Hub administration</strong>
        <small class="text-base-content/70">Adds the <span class="font-mono">yard-*</span> tools: inspect, restart, switch, update and roll back servers, reload the server file. Only for a client that needs it: an assistant that also reads mail or web pages could be talked into using them.</small></span>
    </label>
    <div class="flex justify-end gap-2">${linkButton('/keys', 'Cancel', { tone: 'ghost' })}<button class="btn btn-sm btn-primary">${key ? 'Save' : 'Create key'}</button></div>
  </form>`;
}

function created(key: Key, token: string, base: string): Fragment {
  const command = `claude mcp add --transport http mcpyard ${base}/mcp --header "Authorization: Bearer ${token}"`;
  const secret = (id: string, value: string) =>
    html`<div class="flex items-center gap-2 rounded-field bg-base-200 py-1.5 pl-3 pr-1.5"><code id="${id}" class="flex-1 min-w-0 break-all font-mono text-xs">${value}</code><button type="button" class="btn btn-sm btn-ghost" data-copy="${id}">${icon('copy', 'xs')}<span>Copy</span></button></div>`;
  return html`<dialog class="modal modal-open" open>
    <div class="modal-box max-w-2xl grid gap-4">
      <div class="flex items-center gap-4">${mascot('sm')}<div><h3 class="font-display text-xl font-semibold">Here is the key for ${key.name}</h3>
      <p class="text-base-content/60">Copy it now: it is shown once, and only its hash is kept.</p></div></div>
      <div class="grid gap-1.5">
        <span class="text-xs font-semibold">Token</span>${secret('new-token', token)}
        <span class="text-xs font-semibold mt-2">Claude Code</span>${secret('new-command', command)}
      </div>
      <div class="modal-action mt-0">${linkButton('/keys', 'Done', { tone: 'primary' })}</div>
    </div>
  </dialog>
  ${toast(`Key ${key.name} created.`)}`;
}
