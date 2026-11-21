import type { Context, Hono, MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import type { Hub } from './front.ts';
import { isAdmin, loadKeys, newKey, saveKeys, type Key } from './keys.ts';
import type { AuthServer, OAuthClient } from './oauth-server.ts';
import { type Content, box, cell, checkbox, dialogButton, empty, hero, field, fields, linkButton, list, menu, note, onOff, pageHead, row, tag, title } from './ui-kit.ts';
import { plural } from './ui-servers.ts';
import { mascot } from './ui-icons.ts';
import { icon, log, notFound, page, toast, type Env, type Fragment } from './ui-layout.ts';

export function keyRoutes(app: Hono<Env>, hub: Hub, guard: MiddlewareHandler<Env>, options: { keysPath: string; base: (c: Context) => string; authServer?: AuthServer }): void {
  const { keysPath, authServer } = options;

  app.get('/keys', guard, (c) => c.html(page(c, 'Access', keysView(hub, loadKeys(keysPath), authServer?.resource))));

  app.get('/keys/new', guard, (c) => c.html(page(c, 'New key', html`${pageHead('New key', { crumbs: [{ label: 'Access', href: '/keys' }, { label: 'New key' }] })}${box(keyForm(hub), { pad: true })}`)));

  app.post('/keys', guard, async (c) => {
    const form = await c.req.parseBody({ all: true });
    const name = String(form.name ?? '').trim();
    if (!name || name.length > 64) return c.text('Bad request: name is required, 64 characters at most', 400);
    const { token, key } = newKey(name);
    key.scope = scopeFrom(form);
    const keys = loadKeys(keysPath);
    saveKeys(keysPath, [...keys, key]);
    log(c, 'key_created', { key: key.name });
    return c.html(page(c, 'Access', html`${keysView(hub, [...keys, key], authServer?.resource)}${created(key, token, options.base(c))}`));
  });

  app.get('/keys/:id/edit', guard, (c) => {
    const key = loadKeys(keysPath).find((k) => k.id === c.req.param('id'));
    if (!key) return notFound(c);
    const via = key.oauth ? html`, signed in by ${key.oauth.user} with ${key.oauth.clientName}` : '';
    return c.html(page(c, 'Edit key', html`${pageHead(key.name, { crumbs: [{ label: 'Access', href: '/keys' }, { label: key.name }], sub: html`<span class="font-mono">${key.prefix}…</span>, created ${key.created.slice(0, 10)}${via}, last used ${ago(key.lastUsed)}` })}${box(keyForm(hub, key), { pad: true })}`));
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

  if (!authServer) return;

  app.get('/oauth/authorize', guard, async (c) => {
    const checked = await authServer.authorize(new URL(c.req.url).searchParams);
    if ('fail' in checked) return c.html(page(c, 'Sign-in refused', html`${pageHead('Sign-in refused')}${box(note(checked.fail, 'error'), { pad: true })}`), 400);
    if ('redirect' in checked) return c.redirect(checked.redirect);
    const res = await c.html(page(c, 'Allow access', consent(hub, checked.client, checked.request.redirectUri, authServer.seal(checked.request))));
    // The approval answers with a redirect to the client, which CSP form-action also governs.
    const csp = res.headers.get('content-security-policy');
    if (csp) res.headers.set('content-security-policy', csp.replace("form-action 'self'", `form-action 'self' ${new URL(checked.request.redirectUri).origin}`));
    return res;
  });

  app.post('/oauth/authorize', guard, async (c) => {
    const form = await c.req.parseBody({ all: true });
    const request = authServer.open(String(form.request ?? ''));
    if (!request) return c.html(page(c, 'Sign-in expired', html`${pageHead('Sign-in expired')}${box(note('This sign-in took too long. Start it again from the client.', 'error'), { pad: true })}`), 400);
    if ([form.decision].flat().at(-1) !== 'allow') return c.redirect(authServer.deny(request), 303);
    const name = String(form.name ?? '').trim();
    if (!name || name.length > 64) return c.text('Bad request: name is required, 64 characters at most', 400);
    log(c, 'oauth_approved', { key: name, client: request.clientName });
    return c.redirect(authServer.approve(request, name, scopeFrom(form), c.get('user')?.name ?? 'web UI'), 303);
  });
}

function consent(hub: Hub, client: OAuthClient, redirectUri: string, sealed: string): Fragment {
  const target = new URL(redirectUri);
  const local = target.protocol === 'http:';
  return html`${pageHead(html`Allow ${client.name}?`, { sub: html`It asks for access to this hub. Once allowed, the browser goes back to <span class="font-mono">${target.host}</span>.` })}
    ${local ? html`<div class="mb-4">${note(html`The answer goes to a program on this computer (<span class="font-mono">${target.host}</span>). Any local program can claim a name, so allow only a sign-in you just started.`, 'warning')}</div>` : ''}
    ${box(keyForm(hub, undefined, { request: sealed, name: client.name }), { pad: true })}`;
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

function reach(k: Key): string {
  const list = servers(k);
  return list.includes('*') ? 'all servers' : list.length ? list.join(', ') : isAdmin(k) ? 'administration only' : 'no server';
}

function access(k: Key): Fragment {
  return html`<span class="flex gap-1">${servers(k).length ? tag('tools') : ''}${isAdmin(k) ? tag('admin', { tone: 'warning', icon: 'wrench' }) : ''}</span>`;
}

function controls(k: Key, remove: string, warning: string): Fragment {
  return html`${onOff(`/keys/${k.id}/${k.enabled ? 'disable' : 'enable'}`, k.enabled, `${k.enabled ? 'Disable' : 'Enable'} ${k.name}`)}
    ${menu(`key-${k.id}`, `Actions for ${k.name}`, [
      { href: `/keys/${k.id}/edit`, label: 'Edit', icon: 'pencil' },
      { post: `/keys/${k.id}/delete`, label: remove, icon: 'trash', danger: true, confirm: warning },
    ])}`;
}

const truncated = (text: string, mono = false) => html`<span class="block max-w-48 truncate ${mono ? 'font-mono text-xs' : ''}" title="${text}">${text}</span>`;

function keyRow(k: Key): Fragment {
  const filter =
    [k.scope.tools.allow?.length ? `allow ${k.scope.tools.allow.join(', ')}` : '', k.scope.tools.deny?.length ? `deny ${k.scope.tools.deny.join(', ')}` : '']
      .filter(Boolean)
      .join(' · ') || 'all tools';
  return row(
    html`${title(k.name, html`<span class="font-mono">${k.prefix}…</span><span class="lg:hidden"> · ${[servers(k).length ? 'tools' : '', isAdmin(k) ? 'admin' : ''].filter(Boolean).join(' + ')}</span>`, { href: `/keys/${k.id}/edit` })}
      ${cell(access(k), { hide: true })}
      ${cell(truncated(reach(k)), { hide: true })}
      ${cell(truncated(filter, true), { hide: true })}
      ${cell(html`<span title="Created ${k.created.slice(0, 10)}">${ago(k.lastUsed)}</span>`, { hide: true })}`,
    { off: !k.enabled, end: controls(k, 'Delete', `Delete key ${k.name}? Clients using it lose access.`) },
  );
}

function grantRow(k: Key): Fragment {
  const g = k.oauth!;
  const expired = Date.parse(g.refreshExpires) <= Date.now();
  return row(
    html`${title(k.name, html`${g.clientName} · <span class="font-mono">${g.redirectHost}</span>`, { href: `/keys/${k.id}/edit` })}
      ${cell(g.user, { hide: true })}
      ${cell(access(k), { hide: true })}
      ${cell(truncated(reach(k)), { hide: true })}
      ${cell(html`<span title="Signed in ${k.created.slice(0, 10)}">${ago(k.lastUsed)}</span>`, { hide: true })}
      ${cell(expired ? tag('Expired', { tone: 'error', title: 'Sign in again from the client' }) : html`<span title="The client renews its token by itself until then">${g.refreshExpires.slice(0, 10)}</span>`, { hide: true })}`,
    { off: !k.enabled || expired, end: controls(k, 'Revoke', `Revoke ${k.name}? ${g.clientName} has to sign in again.`) },
  );
}

function section(heading: string, glyph: string, count: number, body: Content): Fragment {
  return html`<section class="grid gap-2">
    <h2 class="flex items-center gap-2 font-display text-lg font-semibold"><span class="text-secondary">${icon(glyph, 'sm')}</span>${heading}<span class="badge badge-sm badge-ghost">${count}</span></h2>
    ${body}
  </section>`;
}

/** The access page: clients signed in through OAuth, then hand-made keys. `signIn` is the URL to give clients when OAuth is on. */
function keysView(hub: Hub, all: Key[], signIn?: string): Fragment {
  const grants = all.filter((k) => k.oauth);
  const keys = all.filter((k) => !k.oauth);
  const signedIn = all.filter((k) => k.oauth).length;
  const off = all.filter((k) => !k.enabled).length;
  const admins = all.filter((k) => k.enabled && isAdmin(k)).length;
  const how = signIn ? html`Clients that support MCP sign-in need only the URL, <span class="font-mono">${signIn}</span>: they open a browser and you pick their rights.` : '';
  const grantList = grants.length
    ? list(['Client', { label: 'Signed in by', hide: true }, { label: 'Access', hide: true }, { label: 'Servers', hide: true }, { label: 'Last used', hide: true }, { label: 'Renews until', hide: true }], grants.map(grantRow))
    : empty(html`<p class="text-center">No client signed in yet. ${how}</p>`);
  const keyList = keys.length
    ? list(['Name', { label: 'Access', hide: true }, { label: 'Servers', hide: true }, { label: 'Tools', hide: true }, { label: 'Last used', hide: true }], keys.map(keyRow))
    : empty(html`<p class="text-center">No key yet. Make one for a client that cannot sign in, or for a script.</p>`);
  return html`${pageHead('Access', {
      sub: html`${plural(signedIn, 'signed-in client')} and ${plural(all.length - signedIn, 'key')}${admins ? `, ${admins} with administration` : ''}${off ? `, ${off} off` : ''}. Every client reaches <span class="font-mono">/mcp</span> with its own sign-in or key.`,
      actions: dialogButton('new-key', 'New key', { tone: 'primary', icon: 'key' }),
    })}
    ${!all.length
      ? hero('Nobody gets in yet', html`Every client gets its own access, so you can see who calls what and switch one off without touching the others. ${how}`, dialogButton('new-key', 'Make a key', { tone: 'primary', icon: 'key' }), 'hello')
      : html`<div class="grid gap-6">
            ${signIn || grants.length ? section('Signed-in clients', 'lock', grants.length, grantList) : ''}
            ${section('Keys', 'key', keys.length, keyList)}
          </div>`}
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

/** The key form, or with `consent` the rights of an OAuth sign-in, posted back to the authorization endpoint. */
function keyForm(hub: Hub, key?: Key, consent?: { request: string; name: string }): Fragment {
  const scope = key?.scope ?? { servers: ['*'], tools: {} };
  const all = scope.servers.includes('*');
  const known = [...new Set([...hub.upstreams.keys(), ...(key ? servers(key) : []).filter((s) => s !== '*')])];
  const hint = consent
    ? 'The sign-in becomes a key under Access, where its rights can change later.'
    : key?.oauth
      ? 'Signed in through OAuth: the client renews its token, delete the key to revoke it.'
      : key
        ? 'The token does not change; create a new key to rotate it.'
        : 'One key per client, so you can turn each off on its own.';
  const actions = consent
    ? html`<button class="btn btn-sm btn-ghost" name="decision" value="deny" formnovalidate>Deny</button><button class="btn btn-sm btn-primary" name="decision" value="allow">Allow</button>`
    : html`${linkButton('/keys', 'Cancel', { tone: 'ghost' })}<button class="btn btn-sm btn-primary">${key ? 'Save' : 'Create key'}</button>`;
  return html`<form method="post" action="${consent ? '/oauth/authorize' : key ? `/keys/${key.id}` : '/keys'}" class="grid gap-5">
    ${consent ? html`<input type="hidden" name="request" value="${consent.request}" />` : ''}
    ${fields(html`
      ${field('Name', html`<input class="input input-sm" name="name" required maxlength="64" placeholder="laptop-claude-code" value="${key?.name ?? consent?.name ?? ''}" />`, { wide: true, hint })}
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
    <div class="flex justify-end gap-2">${actions}</div>
  </form>`;
}

function created(key: Key, token: string, base: string): Fragment {
  const command = `claude mcp add --transport http mcpyard ${base}/mcp --header "Authorization: Bearer ${token}"`;
  const secret = (id: string, value: string) =>
    html`<div class="flex items-center gap-2 rounded-field bg-base-200 py-1.5 pl-3 pr-1.5"><code id="${id}" class="flex-1 min-w-0 break-all font-mono text-xs">${value}</code><button type="button" class="btn btn-sm btn-ghost" data-copy="${id}">${icon('copy', 'xs')}<span>Copy</span></button></div>`;
  return html`<dialog class="modal modal-open" open>
    <div class="modal-box max-w-2xl grid gap-4">
      <div class="flex items-center gap-4">${mascot('sm', 'hello')}<div><h3 class="font-display text-xl font-semibold">Here is the key for ${key.name}</h3>
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
