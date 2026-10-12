import type { Context, Hono, MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import type { Hub } from './front.ts';
import { KINDS, loadKeys, newKey, reaches, saveKeys, type Key, type Kind } from './keys.ts';
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
    const { token, key } = newKey(name, kindFrom(form));
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
    key.kind = kindFrom(form);
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

const KIND_LABEL: Record<Kind, string> = { client: 'client: /mcp', admin: 'admin: admin endpoint', both: 'both' };
const KIND_TONE: Record<Kind, 'info' | 'warning' | 'primary'> = { client: 'info', admin: 'warning', both: 'primary' };

function kindFrom(form: Record<string, unknown>): Kind {
  return KINDS.find((k) => k === [form.kind].flat().at(-1)) ?? 'client';
}

function globs(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

function scopeFrom(form: Record<string, unknown>): Key['scope'] {
  const servers = ([] as unknown[]).concat(form.servers ?? []).map(String);
  const allow = globs(form.allow);
  const deny = globs(form.deny);
  return {
    servers: servers.length === 0 || servers.includes('*') ? ['*'] : servers,
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
      <td><div class="row-wrap">${badge(k.kind, { tone: KIND_TONE[k.kind], soft: true })}${k.enabled ? '' : badge('disabled')}</div></td>
      <td><div class="row-wrap">${k.scope.servers.includes('*') ? badge('all') : k.scope.servers.map((s) => badge(s))}</div></td>
      <td class="mono">${filter(k)}</td>
      <td title="Created ${k.created.slice(0, 10)}">${ago(k.lastUsed)}</td>
      <td>${actions(html`${linkButton(`/keys/${k.id}/edit`, 'Edit', { size: 'xs' })}
        ${postButton(`/keys/${k.id}/${k.enabled ? 'disable' : 'enable'}`, k.enabled ? 'Disable' : 'Enable', { size: 'xs' })}
        ${postButton(`/keys/${k.id}/delete`, 'Delete', { size: 'xs', tone: 'danger', confirm: `Delete key ${k.name}? Clients using it lose access.` })}`)}</td>
    </tr>`,
  );
  return html`${pageHead('Keys', {
      subtitle: html`One key per client. Client keys reach <span class="mono">/mcp</span>, admin keys the admin endpoint, <em>both</em> keys reach the two.`,
      actions: linkButton('/keys/new', 'New key', { tone: 'primary', size: 'sm', icon: 'plus', dialog: 'new-key' }),
    })}
    ${keys.length ? table(['Name', 'Kind', 'Servers', 'Tools', 'Last used', ''], rows, 'keys-table') : empty('No keys yet. Create one for each client.')}
    <dialog id="new-key" class="modal">
      <div class="modal-box max-w-3xl">
        <h3 class="text-lg font-bold mb-4">New key</h3>
        ${keyForm(hub)}
      </div>
      <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>`;
}

function keyForm(hub: Hub, key?: Key): Fragment {
  const scope = key?.scope ?? { servers: ['*'], tools: {} };
  const all = scope.servers.includes('*');
  const servers = [...new Set([...hub.upstreams.keys(), ...scope.servers.filter((s) => s !== '*')])];
  const current = key?.kind ?? 'client';
  const kind = html`<div class="join flex-wrap">
    ${KINDS.map((k) => html`<label class="btn btn-sm join-item seg"><input type="radio" class="hidden-radio" name="kind" value="${k}" ${k === current ? 'checked' : ''} />${KIND_LABEL[k]}</label>`)}
  </div>`;
  return html`<form method="post" action="${key ? `/keys/${key.id}` : '/keys'}">
    ${formGrid(html`
      ${field('Name', html`<input class="input" name="name" required maxlength="64" placeholder="laptop-claude-code" value="${key?.name ?? ''}" />`)}
      ${field('Kind', kind, { hint: key ? 'The token does not change; create a new key to rotate it.' : html`<em>both</em> gives one token for the tools and the admin endpoint.` })}
      ${field(
        'Servers',
        html`<div class="checks">${checkbox('servers', '*', 'All, including future ones', all)}
          ${servers.map((s) => checkbox('servers', s, html`${s}${hub.upstreams.has(s) ? '' : html` <span class="muted">(not in the configuration)</span>`}`, !all && scope.servers.includes(s)))}</div>`,
        { wide: true },
      )}
      ${field('Allow tools', html`<input class="input" name="allow" placeholder="mail-*, calendar-list_*" value="${scope.tools.allow?.join(', ') ?? ''}" />`, { hint: 'Globs on exposed names, empty for all.' })}
      ${field('Deny tools', html`<input class="input" name="deny" placeholder="*-delete_*" value="${scope.tools.deny?.join(', ') ?? ''}" />`)}
    `)}
    <div class="row-wrap mt-4"><button class="btn btn-primary">${key ? 'Save' : 'Create key'}</button>${linkButton('/keys', 'Cancel')}</div>
  </form>`;
}

function created(key: Key, token: string, base: string): Fragment {
  const command = (name: string, path: string) => `claude mcp add --transport http ${name} ${base}${path} --header "Authorization: Bearer ${token}"`;
  const commands = [
    ...(reaches(key, 'client') ? [['Claude Code', command('mcpyard', '/mcp')]] : []),
    ...(reaches(key, 'admin') ? [['Claude Code, admin endpoint', command('mcpyard-admin', '/admin/mcp')]] : []),
  ];
  const secret = (id: string, value: string) =>
    html`<div class="secret"><code id="${id}">${value}</code><button type="button" class="btn btn-sm gap-1" data-copy="${id}">${icon('copy', 'xs')}<span>Copy</span></button></div>`;
  return html`<dialog class="modal modal-open" open>
    <div class="modal-box max-w-3xl">
      <h3 class="text-lg font-bold">Key ${key.name} created</h3>
      <p class="muted mt-1 mb-4">Copy the token now: it is shown once and only its hash is stored.</p>
      ${secret('new-token', token)}
      ${commands.map(([label, text], i) => html`<p class="mt-4 mb-2 font-medium">${label}</p>${secret(`new-command-${i}`, text!)}`)}
      <div class="modal-action">${linkButton('/keys', 'Done', { tone: 'primary' })}</div>
    </div>
  </dialog>
  ${toast(`Key ${key.name} created.`)}`;
}
