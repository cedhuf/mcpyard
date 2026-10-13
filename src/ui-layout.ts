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

let appearance: Appearance = { mode: 'system', light: 'winter', dark: 'dim' };

type Stylesheet = { body: Buffer; gzip: Buffer; version: string };
let current: Stylesheet | undefined;
let building: Promise<Stylesheet> | undefined;

const SOURCES = fileURLToPath(new URL('.', import.meta.url));

/** The daisyUI modules the UI uses, so the stylesheet carries nothing else. */
const DAISY = ['properties', 'rootcolor', 'scrollbar', 'rootscrolllock', 'svg', 'alert', 'avatar', 'badge', 'breadcrumbs', 'button', 'card', 'checkbox', 'collapse', 'dropdown', 'fieldset', 'indicator', 'input', 'join', 'label', 'link', 'list', 'menu', 'modal', 'navbar', 'radio', 'select', 'stat', 'status', 'tab', 'table', 'textarea', 'toast', 'toggle', 'tooltip'];

/**
 * Tailwind and daisyUI, compiled at startup from the classes the UI's own files use, so there is no
 * build step. Rebuilt when the themes change; served compressed with its hash in the URL.
 */
async function build(look: Appearance): Promise<Stylesheet> {
  const input = `@import "tailwindcss" source(none);
@source "./*.ts";
@source inline("{alert,badge,status,toggle,text,bg,border}-{primary,success,warning,error,info,neutral}");
@plugin "daisyui" { themes: ${look.light} --default, ${look.dark} --prefersdark; logs: false; include: ${DAISY.join(', ')}; }`;
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
import { menu, search, type MenuEntry } from './ui-kit.ts';

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

const NAV = [
  ['/', 'Servers', 'server'],
  ['/keys', 'Keys', 'key'],
  ['/logs', 'Logs', 'logs'],
] as const;

/** The navbar search looks in the section the page belongs to, keeping that section's filters. */
function sectionSearch(c: Context<Env>): { action: string; placeholder: string; keep: Record<string, string> } {
  const path = c.req.path;
  const keep = (...names: string[]) => Object.fromEntries(names.flatMap((n) => (c.req.query(n) ? [[n, c.req.query(n)!]] : [])));
  if (path.startsWith('/keys')) return { action: '/keys', placeholder: 'Search keys', keep: {} };
  if (path.startsWith('/logs')) return { action: '/logs', placeholder: 'Search logs', keep: keep('kind', 'server') };
  return { action: '/', placeholder: 'Search servers', keep: path === '/' ? keep('state') : {} };
}

/** The account menu: who is signed in, the settings, the running version and any newer release. */
function accountMenu(c: Context<Env>): Fragment {
  const user = c.get('user');
  const { current, latest, newer } = release.status();
  const version = current === 'dev' ? 'dev build' : `v${current}`;
  const entries: (MenuEntry | false)[] = [
    { label: 'Settings', icon: 'settings', href: '/settings' },
    newer && latest
      ? { label: `v${latest.version} is available`, icon: 'up', href: latest.url, badge: 'new' }
      : { label: `MCP Yard ${version}`, icon: 'check', href: '/settings#about' },
    !!user && { label: 'Sign out', icon: 'logout', post: '/auth/logout' },
  ];
  const face = user
    ? html`<div class="w-8 rounded-full bg-primary text-primary-content"><span class="text-sm">${user.name.slice(0, 1).toUpperCase()}</span>${user.picture ? html`<img class="absolute inset-0" src="${user.picture}" alt="" referrerpolicy="no-referrer" />` : ''}</div>`
    : html`<div class="w-8 rounded-full bg-base-300">${icon('lock', 'sm')}</div>`;
  return menu('account', user ? `Account of ${user.name}` : 'Account', entries, {
    title: user ? user.name : 'Sign-in is off',
    trigger: html`<span class="indicator">${newer ? html`<span class="indicator-item status status-primary" aria-label="A newer version is available"></span>` : ''}<span class="avatar avatar-placeholder">${face}</span></span>`,
  });
}

export function page(c: Context<Env>, title: string, body: Fragment, options: { bare?: boolean } = {}): Fragment {
  const nonce = c.get('nonce');
  const path = c.req.path;
  const active = (href: string) => (href === '/' ? path === '/' || path.startsWith('/servers') || path === '/reload' : path.startsWith(href));
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
  const brand = html`<a class="btn btn-ghost gap-2 px-2 text-base font-semibold" href="/">${LOGO}<span>MCP Yard</span></a>`;
  if (options.bare) {
    return html`${head}
      <body class="min-h-screen grid place-items-center bg-base-200 text-sm">
        <main class="w-[min(400px,calc(100vw-32px))] py-10 grid gap-6 justify-items-start">${brand}${body}</main>
      </body>
    </html>`;
  }
  const find = sectionSearch(c);
  const links = NAV.map(([href, label, name]) => html`<li><a href="${href}" class="${active(href) ? 'menu-active' : ''}" ${active(href) ? html`aria-current="page"` : ''}>${icon(name, 'sm')}${label}</a></li>`);
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
      <main class="px-4 sm:px-6 lg:px-8 pt-6 pb-16">${body}</main>
      ${nonce ? html`<script nonce="${nonce}">${raw(SCRIPT)}</script>` : ''}
    </body>
  </html>`;
}

const SCRIPT = `
document.addEventListener('submit', (e) => {
  const message = (e.submitter?.dataset.confirm) || e.target.dataset.confirm;
  if (message && !confirm(message)) e.preventDefault();
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
    const sheet = next.querySelector('link[rel=stylesheet]');
    if (sheet) document.querySelector('link[rel=stylesheet]').href = sheet.getAttribute('href');
    const theme = next.documentElement.getAttribute('data-theme');
    if (theme) document.documentElement.setAttribute('data-theme', theme); else document.documentElement.removeAttribute('data-theme');
    show('Saved', 'saved');
  });
}
const live = document.querySelector('[data-refresh]');
if (live) setInterval(async () => {
  const current = document.getElementById(live.id);
  if (document.hidden || document.querySelector('dialog[open], :popover-open') || String(getSelection()) || document.activeElement?.matches('input')) return;
  const res = await fetch(location.pathname + location.search).catch(() => null);
  if (!res || !res.ok || res.redirected) return;
  const next = new DOMParser().parseFromString(await res.text(), 'text/html').getElementById(live.id);
  if (!next) return;
  current.replaceWith(next);
}, 4000);`;
