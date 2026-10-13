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

/**
 * Tailwind and daisyUI, compiled at startup from the classes the UI's own files use, so there is no
 * build step. Rebuilt when the themes change; served compressed with its hash in the URL.
 */
async function build(look: Appearance): Promise<Stylesheet> {
  const input = `@import "tailwindcss" source(none);
@source "./*.ts";
@source inline("{alert,badge,status,toggle,text,bg,border}-{primary,success,warning,error,info,neutral}");
@plugin "daisyui" { themes: ${look.light} --default, ${look.dark} --prefersdark; logs: false; }
${CSS}`;
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

const ICONS: Record<string, string> = {
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M17 6l2 2M15 8l2 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  package: '<path d="m21 8-9-5-9 5 9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>',
  terminal: '<path d="m6 9 3 3-3 3M12 15h6"/><rect x="2" y="3" width="20" height="18" rx="3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  pencil: '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  pin: '<path d="M12 17v5M9 10.8V4h6v6.8l2 2.2v2H7v-2Z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  logs: '<path d="M4 6h16M4 10h16M4 14h10M4 18h7"/>',
  power: '<path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8M14.7 6.3 13 4.7a4 4 0 0 0-5 5L3 15l3 3 5.3-5.3"/>',
};

const SIZES = { xs: 'size-3', sm: 'size-4', md: 'size-[18px]' } as const;

export function icon(name: string, size: 'xs' | 'sm' | 'md' = 'md'): Fragment {
  return html`<svg class="${SIZES[size]} shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(ICONS[name] ?? '')}</svg>`;
}

export const LOGO = raw('<img src="/apple-touch-icon.png" width="28" height="28" alt="" class="size-7 shrink-0 object-contain" />');

export function locked(env: string): Fragment {
  return html`<span class="badge badge-sm badge-ghost gap-1 whitespace-nowrap" title="Set by ${env} in the environment; change it there and restart">${icon('lock', 'xs')}<span class="font-mono">${env}</span></span>`;
}

/** A notice in the corner; errors stay, the rest fade out. */
export function toast(message: Fragment | string, kind: 'success' | 'error' | 'info' = 'success'): Fragment {
  return html`<div class="toast toast-end toast-bottom z-50"><div role="${kind === 'error' ? 'alert' : 'status'}" class="alert alert-${kind} alert-soft text-sm shadow-lg ${kind === 'error' ? '' : 'fades'}">${icon(kind === 'error' ? 'alert' : 'check', 'sm')}<span>${message}</span></div></div>`;
}

export function log(c: Context<Env>, name: string, subject?: Record<string, string>): void {
  event(name, { ...subject, by: c.get('user')?.name ?? null });
}

const NAV = [
  ['/', 'Servers', 'server'],
  ['/keys', 'Keys', 'key'],
  ['/logs', 'Logs', 'logs'],
  ['/settings', 'Settings', 'settings'],
] as const;

export function page(c: Context<Env>, title: string, body: Fragment, options: { bare?: boolean } = {}): Fragment {
  const user = c.get('user');
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
  const brand = html`<a class="flex items-center gap-2.5 font-semibold text-[15px]" href="/">${LOGO}<span>MCP Yard</span></a>`;
  if (options.bare) {
    return html`${head}
      <body class="min-h-screen grid place-items-center bg-base-200 text-sm">
        <main class="w-[min(400px,calc(100vw-32px))] py-10 grid gap-6">${brand}${body}</main>
      </body>
    </html>`;
  }
  return html`${head}
    <body class="min-h-screen bg-base-100 text-sm">
      <div class="drawer lg:drawer-open">
        <input id="nav" type="checkbox" class="drawer-toggle" />
        <div class="drawer-content min-w-0">
          <header class="lg:hidden sticky top-0 z-30 flex items-center gap-2 px-3 py-2 border-b border-base-300 bg-base-100">
            <label for="nav" class="btn btn-ghost btn-sm btn-square" aria-label="Open the menu">${icon('menu')}</label>
            ${brand}
          </header>
          <main class="px-4 sm:px-8 lg:px-10 pt-6 lg:pt-8 pb-16 max-w-[1400px]">${body}</main>
        </div>
        <div class="drawer-side z-40">
          <label for="nav" class="drawer-overlay" aria-label="Close the menu"></label>
          <aside class="w-60 min-h-dvh h-dvh flex flex-col gap-1 p-3 pt-5 bg-base-200 border-r border-base-300">
            <div class="px-2 pb-4">${brand}</div>
            <ul class="menu w-full p-0 gap-0.5">
              ${NAV.map(([href, label, name]) => html`<li><a href="${href}" class="${active(href) ? 'menu-active' : ''}" ${active(href) ? html`aria-current="page"` : ''}>${icon(name, 'sm')}${label}</a></li>`)}
            </ul>
            <div class="mt-auto grid gap-2">
              ${versionLine()}
              ${user
                ? html`<form method="post" action="/auth/logout" class="flex items-center gap-2.5 rounded-box bg-base-100 border border-base-300 px-2.5 py-2">
                    <div class="avatar avatar-placeholder"><div class="relative w-7 rounded-full bg-primary text-primary-content text-xs">
                      <span>${user.name.slice(0, 1).toUpperCase()}</span>
                      ${user.picture ? html`<img class="absolute inset-0" src="${user.picture}" alt="" referrerpolicy="no-referrer" />` : ''}
                    </div></div>
                    <span class="flex-1 min-w-0 truncate font-medium">${user.name}</span>
                    <button class="btn btn-ghost btn-xs btn-square" title="Sign out" aria-label="Sign out">${icon('logout', 'sm')}</button>
                  </form>`
                : html`<div class="flex items-center gap-2 rounded-box bg-base-100 border border-base-300 px-2.5 py-2 text-xs text-base-content/60">${icon('lock', 'sm')}Sign-in is off</div>`}
            </div>
          </aside>
        </div>
      </div>
      ${nonce ? html`<script nonce="${nonce}">${raw(SCRIPT)}</script>` : ''}
    </body>
  </html>`;
}

function versionLine(): Fragment {
  const { current, latest, newer } = release.status();
  const label = current === 'dev' ? 'MCP Yard dev' : `MCP Yard v${current}`;
  const cls = 'flex items-center justify-center gap-1 font-mono text-xs';
  return newer && latest
    ? html`<a class="${cls} text-primary font-semibold" href="${latest.url}" target="_blank" rel="noreferrer" title="v${latest.version} is available: release notes">${icon('up', 'xs')}${label}</a>`
    : html`<a class="${cls} text-base-content/50 hover:text-base-content" href="/settings" title="About MCP Yard">${label}</a>`;
}

const SCRIPT = `
document.addEventListener('submit', (e) => {
  const message = e.target.dataset.confirm;
  if (message && !confirm(message)) e.preventDefault();
});
document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-dialog]');
  if (opener) { e.preventDefault(); document.getElementById(opener.dataset.dialog)?.showModal(); }
  document.querySelectorAll('details.dropdown[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard.writeText(document.getElementById(copy.dataset.copy).textContent.trim()).then(() => {
      const label = copy.querySelector('span'); const text = label.textContent;
      label.textContent = 'Copied'; setTimeout(() => (label.textContent = text), 1500);
    });
  }
});
setTimeout(() => document.querySelectorAll('.fades').forEach((el) => el.closest('.toast').remove()), 5000);
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
  if (document.hidden || document.querySelector('dialog[open], details[open]') || String(getSelection()) || current.contains(document.activeElement) && document.activeElement.matches('input[type=search]')) return;
  const open = [...current.querySelectorAll('input[data-id]:checked')].map((i) => i.dataset.id);
  const res = await fetch(location.pathname + location.search).catch(() => null);
  if (!res || !res.ok || res.redirected) return;
  const next = new DOMParser().parseFromString(await res.text(), 'text/html').getElementById(live.id);
  if (!next) return;
  for (const id of open) { const box = next.querySelector('input[data-id="' + CSS.escape(id) + '"]'); if (box) box.checked = true; }
  current.replaceWith(next);
}, 4000);`;

/** What no utility class says: the whole-row link, the toast fade, and daisyUI tweaks. */
const CSS = `
@layer components {
  .row-link { position: relative; }
  .row-link:hover { background: color-mix(in oklab, var(--color-base-content) 3%, transparent); }
  .row-anchor::after { content: ""; position: absolute; inset: 0; }
  .row-anchor:focus-visible { outline: none; }
  .row-link:has(.row-anchor:focus-visible) { outline: 2px solid var(--color-primary); outline-offset: -2px; }
  .row-end { position: relative; z-index: 1; }
  .fades { animation: fade 0.4s ease 4.6s forwards; }
  @keyframes fade { to { opacity: 0; transform: translateY(8px); } }
  .dropdown > summary { list-style: none; }
  .dropdown > summary::-webkit-details-marker { display: none; }
  .menu form { display: contents; }
  .savebar { backdrop-filter: blur(8px); }
}
`;
