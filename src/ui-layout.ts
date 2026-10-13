import type { Context } from 'hono';
import { html, raw } from 'hono/html';
import { compile, optimize } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { User } from './oidc.ts';
import { event } from './logs.ts';
import { release } from './release.ts';

export type Env = { Variables: { user?: User; nonce: string } };
export type Fragment = ReturnType<typeof html>;

export type Appearance = { mode: 'system' | 'light' | 'dark'; light: string; dark: string };

let appearance: Appearance = { mode: 'system', light: 'yard', dark: 'yard-night' };

type Stylesheet = { body: Buffer; gzip: Buffer; version: string };
let current: Stylesheet | undefined;
let building: Promise<Stylesheet> | undefined;

const SOURCES = fileURLToPath(new URL('.', import.meta.url));

/** The daisyUI modules the UI uses, so the stylesheet carries nothing else. */
const DAISY = ['properties', 'rootcolor', 'scrollbar', 'rootscrolllock', 'svg', 'alert', 'avatar', 'badge', 'breadcrumbs', 'button', 'card', 'checkbox', 'collapse', 'countdown', 'dropdown', 'fieldset', 'indicator', 'input', 'join', 'label', 'link', 'list', 'menu', 'modal', 'navbar', 'progress', 'radialprogress', 'radio', 'select', 'stat', 'status', 'tab', 'table', 'textarea', 'toast', 'toggle', 'tooltip'];

/**
 * Tailwind and daisyUI, compiled at startup from the classes the UI's own files use, so there is no
 * build step. Rebuilt when the themes change; served compressed with its hash in the URL.
 */
async function build(look: Appearance): Promise<Stylesheet> {
  const input = `@import "tailwindcss" source(none);
@source "./*.ts";
@source inline("{alert,badge,status,toggle,text,bg,border}-{primary,success,warning,error,info,neutral}");
${themeCss(look.light, look.dark, DAISY)}
@font-face { font-family: "Fredoka"; src: url("/assets/fredoka.woff2") format("woff2"); font-weight: 300 700; font-display: swap; }
@theme { --font-display: "Fredoka", ui-rounded, system-ui, sans-serif; }`;
  const compiler = await compile(input, { base: SOURCES, onDependency: () => {} });
  const candidates = new Scanner({ sources: compiler.sources.map((s) => ({ ...s, base: SOURCES })) }).scan();
  const { code } = optimize(compiler.build(candidates), { minify: true });
  const body = Buffer.from(code);
  return { body, gzip: gzipSync(body, { level: 9 }), version: createHash('sha256').update(body).digest('hex').slice(0, 12) };
}

/** The stylesheet for the current themes, built on first use. */
export async function stylesheet(): Promise<Stylesheet> {
  building ??= build(appearance).then((sheet) => (current = sheet));
  return building;
}

/** The current stylesheet's version for links; empty until the first build ends. */
function sheetVersion(): string {
  return current?.version ?? '';
}

export async function setAppearance(next: Appearance): Promise<void> {
  const rebuild = next.light !== appearance.light || next.dark !== appearance.dark || !building;
  appearance = next;
  if (rebuild) {
    building = undefined;
    await stylesheet();
  }
}

import { icon, LOGO } from './ui-icons.ts';
import { hero, linkButton, menu, search, type MenuEntry } from './ui-kit.ts';
import { themeCss } from './ui-theme.ts';

export { icon, LOGO };

export function locked(env: string): Fragment {
  return html`<span class="badge badge-sm badge-ghost gap-1 whitespace-nowrap" title="Set by ${env} in the environment; change it there and restart">${icon('lock', 'xs')}<span class="font-mono">${env}</span></span>`;
}

/** A notice in the corner; errors stay, the rest fade out. */
export function toast(message: Fragment | string, kind: 'success' | 'error' | 'info' = 'success'): Fragment {
  return html`<div class="toast toast-end toast-bottom z-50"><div role="${kind === 'error' ? 'alert' : 'status'}" class="alert alert-${kind} alert-soft text-sm shadow-lg" ${kind === 'error' ? '' : html`data-fades`}>${icon(kind === 'error' ? 'alert' : 'check', 'sm')}<span>${message}</span></div></div>`;
}

export function log(c: Context<Env>, name: string, subject?: Record<string, string>): void {
  event(name, { ...subject, by: c.get('user')?.name ?? null });
}

/** A friendly 404 inside the app, for a server, key or page that is not there. */
export function notFound(c: Context<Env>): Response | Promise<Response> {
  return c.html(page(c, 'Not found', hero('Nothing grows here', 'This page, server or key does not exist, or not any more.', linkButton('/', 'Back to the dashboard', { tone: 'primary', icon: 'home' }), 'lost')), 404);
}

const NAV = [
  ['/servers', 'Servers', 'server', 'text-primary'],
  ['/keys', 'Keys', 'key', 'text-secondary'],
  ['/logs', 'Logs', 'logs', 'text-accent'],
] as const;

/** The navbar search looks in the section the page belongs to, keeping that section's filters. */
function sectionSearch(c: Context<Env>): { action: string; placeholder: string; keep: Record<string, string> } {
  const path = c.req.path;
  const keep = (...names: string[]) => Object.fromEntries(names.flatMap((n) => (c.req.query(n) ? [[n, c.req.query(n)!]] : [])));
  if (path.startsWith('/keys')) return { action: '/keys', placeholder: 'Search keys', keep: {} };
  if (path.startsWith('/logs')) return { action: '/logs', placeholder: 'Search logs', keep: keep('kind', 'server') };
  return { action: '/servers', placeholder: 'Search servers', keep: path === '/servers' ? keep('state') : {} };
}

/** The account menu: who is signed in, the settings, and signing out. */
function accountMenu(c: Context<Env>): Fragment {
  const user = c.get('user');
  const face = user?.picture
    ? html`<div class="w-9 rounded-full"><img src="${user.picture}" alt="" referrerpolicy="no-referrer" /></div>`
    : html`<div class="w-9 rounded-full ${user ? 'bg-primary text-primary-content' : 'bg-base-300'}">${user ? html`<span class="font-display font-semibold">${user.name.slice(0, 1).toUpperCase()}</span>` : icon('lock', 'sm')}</div>`;
  return menu(
    'account',
    user ? `Account of ${user.name}` : 'Account',
    [{ label: 'Settings', icon: 'settings', href: '/settings' }, !!user && { label: 'Sign out', icon: 'logout', post: '/auth/logout' }],
    { title: user ? user.name : 'Sign-in is off', trigger: html`<span class="avatar ${user?.picture ? '' : 'avatar-placeholder'}">${face}</span>` },
  );
}

/** The version, a newer release when there is one, the links, and who made it. */
function footer(): Fragment {
  const { current, latest, newer } = release.status();
  const version = current === 'dev' ? 'dev build' : `v${current}`;
  return html`<footer class="px-2 pb-2 sm:px-4">
    <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-box bg-base-200 px-5 py-3 text-xs text-base-content/60 border-b-4 border-primary/50">
      <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class="flex items-center gap-1.5">${icon('fence', 'xs')}MCP Yard ${version}</span>
        ${newer && latest ? html`<a class="badge badge-sm badge-primary gap-1" href="${latest.url}" target="_blank" rel="noreferrer">${icon('up', 'xs')}v${latest.version} is out</a>` : ''}
      </span>
      <span class="flex flex-wrap items-center gap-x-4 gap-y-1">
        <a class="link link-hover" href="https://cedhuf.github.io/mcpyard/" target="_blank" rel="noreferrer">Docs</a>
        <a class="link link-hover" href="https://github.com/cedhuf/mcpyard" target="_blank" rel="noreferrer">GitHub</a>
        <span class="flex items-center gap-1">Made with <span class="text-error" aria-label="love">${icon('heart', 'xs')}</span> by <a class="link link-hover font-medium" href="https://thehuf.com" target="_blank" rel="noreferrer">cedhuf</a></span>
      </span>
    </div>
  </footer>`;
}

export function page(c: Context<Env>, title: string, body: Fragment, options: { bare?: boolean } = {}): Fragment {
  const nonce = c.get('nonce');
  const path = c.req.path;
  const active = (href: string) => (href === '/servers' ? path.startsWith('/servers') || path === '/reload' : path.startsWith(href));
  const head = html`<!doctype html>
    <html lang="en" ${appearance.mode === 'system' ? '' : html`data-theme="${appearance[appearance.mode]}"`}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · MCP Yard</title>
        <link rel="stylesheet" href="/assets/ui.css?v=${sheetVersion()}" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>`;
  const brand = html`<a class="btn btn-ghost h-auto gap-2 px-2 py-1 font-display text-xl font-semibold" href="/" title="Dashboard">${LOGO}<span>MCP Yard</span></a>`;
  if (options.bare) {
    return html`${head}
      <body class="min-h-screen grid place-items-center bg-base-200 text-sm">
        <main class="w-[min(420px,calc(100vw-32px))] py-10 grid gap-6 justify-items-center">${brand}${body}</main>
      </body>
    </html>`;
  }
  const find = sectionSearch(c);
  const links = NAV.map(([href, label, name, tint]) => html`<li><a href="${href}" class="font-medium ${active(href) ? 'menu-active' : ''}" ${active(href) ? html`aria-current="page"` : ''}><span class="${active(href) ? '' : tint}">${icon(name, 'sm')}</span>${label}</a></li>`);
  return html`${head}
    <body class="min-h-screen text-sm">
      <header class="sticky top-0 z-30 px-2 pt-2 sm:px-4">
        <div class="max-lg:collapse w-full rounded-box bg-base-200 shadow-sm">
          <input id="nav-toggle" class="peer hidden" type="checkbox" aria-label="Menu" />
          <label for="nav-toggle" class="fixed inset-0 hidden max-lg:peer-checked:block" aria-hidden="true"></label>
          <nav class="collapse-title navbar min-h-14 gap-2 p-2 sm:px-3" aria-label="Main">
            <div class="navbar-start w-auto gap-1">
              <label for="nav-toggle" class="btn btn-ghost btn-square btn-sm lg:hidden" aria-label="Open the menu">${icon('menu')}</label>
              ${brand}
            </div>
            <div class="navbar-center hidden lg:flex"><ul class="menu menu-horizontal gap-1 p-0">${links}</ul></div>
            <div class="navbar-end flex-1 gap-2">
              <div class="max-sm:hidden">${search(find.action, c.req.query('q') ?? '', find.placeholder, find.keep)}</div>
              ${accountMenu(c)}
            </div>
          </nav>
          <div class="collapse-content lg:hidden">
            <div class="sm:hidden px-2 pb-2">${search(find.action, c.req.query('q') ?? '', find.placeholder, find.keep)}</div>
            <ul class="menu w-full">${links}</ul>
          </div>
        </div>
      </header>
      <main class="px-4 sm:px-6 lg:px-8 pt-6 pb-16 min-h-[calc(100dvh-10rem)]">${body}</main>
      ${footer()}
      ${nonce ? html`${CONFIRM}<script nonce="${nonce}">${raw(SCRIPT)}</script>` : ''}
    </body>
  </html>`;
}

/** Asks before any form or button carrying `data-confirm`; `data-danger` turns the confirm button red. */
const CONFIRM = html`<dialog id="confirm" class="modal" aria-labelledby="confirm-text">
  <div class="modal-box max-w-sm grid gap-5">
    <p id="confirm-text" class="text-base"></p>
    <form method="dialog" class="modal-action mt-0">
      <button class="btn btn-sm btn-ghost" value="">Cancel</button>
      <button class="btn btn-sm" value="ok" autofocus></button>
    </form>
  </div>
  <form method="dialog" class="modal-backdrop"><button>close</button></form>
</dialog>`;

const SCRIPT = `
const ask = document.getElementById('confirm');
let confirmed = false;
document.addEventListener('submit', (e) => {
  const from = e.submitter?.dataset.confirm ? e.submitter : e.target;
  if (confirmed || !from.dataset.confirm) return;
  e.preventDefault();
  e.submitter?.closest('[popover]')?.hidePopover();
  const ok = ask.querySelector('[value=ok]');
  ask.querySelector('#confirm-text').textContent = from.dataset.confirm;
  ok.textContent = e.submitter?.textContent.trim() || 'Confirm';
  ok.className = 'btn btn-sm ' + ('danger' in from.dataset ? 'btn-error' : 'btn-primary');
  ask.returnValue = '';
  ask.onclose = () => {
    if (ask.returnValue !== 'ok') return;
    confirmed = true;
    e.target.requestSubmit(e.submitter);
    confirmed = false;
  };
  ask.showModal();
});
document.addEventListener('change', (e) => {
  const pick = e.target.closest('[data-pick]');
  if (!pick) return;
  pick.querySelector('[data-pick-label]').textContent = e.target.closest('label').textContent.trim();
  pick.querySelector('[popover]').hidePopover();
});
document.addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard.writeText(document.getElementById(copy.dataset.copy).textContent.trim()).then(() => {
      const label = copy.querySelector('span'); const text = label.textContent;
      label.textContent = 'Copied'; setTimeout(() => (label.textContent = text), 1500);
    });
  }
});
setTimeout(() => document.querySelectorAll('[data-fades]').forEach((el) => el.closest('.toast').remove()), 5000);
const kind = document.querySelector('[name=kind]:checked, select[name=kind]');
if (kind) {
  const current = () => (document.querySelector('[name=kind]:checked') || kind).value;
  const sync = () => document.querySelectorAll('[data-kinds]').forEach((el) => (el.hidden = !el.dataset.kinds.split(' ').includes(current())));
  document.querySelectorAll('[name=kind]').forEach((el) => el.addEventListener('change', sync));
  sync();
}
const autosave = document.querySelector('form[data-autosave]');
if (autosave) {
  const status = document.querySelector('[data-autosave-status]');
  const show = (text, state) => { if (status) { status.textContent = text; status.className = 'autosave ' + state; } };
  autosave.addEventListener('change', async () => {
    show('Saving…', 'saving');
    const res = await fetch(autosave.action, { method: 'POST', body: new URLSearchParams(new FormData(autosave)) }).catch(() => null);
    if (!res || !res.ok) return show(res ? 'Not saved: ' + (new DOMParser().parseFromString(await res.text(), 'text/html').querySelector('.toast')?.textContent.trim() || res.status) : 'Not saved: no connection', 'failed');
    const next = new DOMParser().parseFromString(await res.text(), 'text/html');
    const apply = () => {
      const theme = next.documentElement.getAttribute('data-theme');
      if (theme) document.documentElement.setAttribute('data-theme', theme); else document.documentElement.removeAttribute('data-theme');
      show('Saved', 'saved');
    };
    // Swap the stylesheet only once the new one has loaded, or the page flashes unstyled.
    const sheet = next.querySelector('link[rel=stylesheet]')?.getAttribute('href');
    const old = document.querySelector('link[rel=stylesheet]');
    if (!sheet || sheet === old.getAttribute('href')) return apply();
    const link = old.cloneNode();
    link.href = sheet;
    link.onload = () => { apply(); old.remove(); };
    old.after(link);
  });
}
const clock = document.querySelector('[data-clock]');
if (clock) {
  const offset = Number(clock.dataset.now) - Date.now();
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: clock.dataset.zone, hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
  // Tick on the hub's second boundary, so each digit rolls once, on time.
  const tick = () => {
    const now = Date.now() + offset;
    const parts = Object.fromEntries(format.formatToParts(new Date(now)).map((p) => [p.type, p.value]));
    clock.querySelectorAll('[data-unit]').forEach((el) => {
      const value = Number(parts[el.dataset.unit]);
      if (Number(el.textContent) === value) return;
      el.style.setProperty('--value', value); el.textContent = value; el.setAttribute('aria-label', value);
    });
    setTimeout(tick, 1000 - (now % 1000) + 5);
  };
  tick();
}
/** Moves the elements marked data-keep from the page into its refreshed copy, so a clock keeps ticking. */
const keep = (from, to) => from.querySelectorAll('[data-keep]').forEach((el) => to.querySelector('#' + CSS.escape(el.id))?.replaceWith(el));
let searching;
document.addEventListener('input', (e) => {
  const form = e.target.closest('form[role=search]');
  if (!form) return;
  const url = new URL(form.action);
  url.search = new URLSearchParams(new FormData(form)).toString();
  // Live on the page the search belongs to; elsewhere Enter opens it.
  if (url.pathname !== location.pathname) return;
  clearTimeout(searching);
  searching = setTimeout(async () => {
    const res = await fetch(url).catch(() => null);
    const area = document.querySelector('[data-refresh]');
    if (!res || !res.ok || !area) return;
    const next = new DOMParser().parseFromString(await res.text(), 'text/html').getElementById(area.id);
    if (next) { keep(area, next); area.replaceWith(next); history.replaceState(null, '', url); }
  }, 200);
});
const live = document.querySelector('[data-refresh]');
if (live) setInterval(async () => {
  const current = document.getElementById(live.id);
  if (document.hidden || document.querySelector('dialog[open], :popover-open') || String(getSelection()) || document.activeElement?.matches('input')) return;
  const res = await fetch(location.pathname + location.search).catch(() => null);
  if (!res || !res.ok || res.redirected) return;
  const next = new DOMParser().parseFromString(await res.text(), 'text/html').getElementById(live.id);
  if (!next) return;
  keep(current, next);
  current.replaceWith(next);
}, 4000);`;
