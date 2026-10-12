import type { Context } from 'hono';
import { html, raw } from 'hono/html';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { User } from './oidc.ts';
import { release } from './release.ts';

export type Env = { Variables: { user?: User; nonce: string } };
export type Fragment = ReturnType<typeof html>;

export type Appearance = { mode: 'system' | 'light' | 'dark'; light: string; dark: string };

let appearance: Appearance = { mode: 'system', light: 'winter', dark: 'dim' };

/** A daisyUI theme's variables, re-targeted so the theme follows the system without any script. */
function themeVars(name: string): string {
  const css = readFileSync(fileURLToPath(import.meta.resolve(`daisyui/theme/${name}.css`)), 'utf8');
  return css.slice(css.indexOf('{') + 1, css.lastIndexOf('}'));
}

const daisy = (file: string) => readFileSync(fileURLToPath(import.meta.resolve(`daisyui/${file}`)), 'utf8');
const BASE = [daisy('daisyui.css'), daisy('themes.css')].join('\n');

type Stylesheet = { body: Buffer; gzip: Buffer; version: string };
let current: Stylesheet | undefined;
let currentFor = '';

/** daisyUI, its themes and our layout as one stylesheet, built once per theme pair and served compressed. */
export function stylesheet(): Stylesheet {
  const key = `${appearance.light}/${appearance.dark}`;
  if (!current || currentFor !== key) {
    const css = [
      BASE,
      `:root:not([data-theme]){${themeVars(appearance.light)}}`,
      `@media (prefers-color-scheme: dark){:root:not([data-theme]){${themeVars(appearance.dark)}}}`,
      CSS(),
    ].join('\n');
    const body = Buffer.from(css);
    current = { body, gzip: gzipSync(body, { level: 9 }), version: createHash('sha256').update(body).digest('hex').slice(0, 12) };
    currentFor = key;
  }
  return current;
}

export function setAppearance(next: Appearance): void {
  appearance = next;
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
  power: '<path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8M14.7 6.3 13 4.7a4 4 0 0 0-5 5L3 15l3 3 5.3-5.3"/>',
};

export function icon(name: string, size: 'xs' | 'sm' | 'md' = 'md'): Fragment {
  return html`<svg class="icon icon-${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(ICONS[name] ?? '')}</svg>`;
}

export const LOGO = raw('<img src="/icon-96.png" width="34" height="34" alt="" class="logo" />');

export function locked(env: string): Fragment {
  return html`<span class="badge badge-ghost gap-1 locked" title="Set by ${env} in the environment; change it there and restart">${icon('lock', 'xs')}<span class="mono">${env}</span></span>`;
}

/** A dismissible notice in the corner; errors stay until closed, the rest fade out. */
export function toast(message: Fragment | string, kind: 'success' | 'error' | 'info' = 'success'): Fragment {
  return html`<div class="toast toast-end toast-bottom z-50"><div role="${kind === 'error' ? 'alert' : 'status'}" class="alert alert-${kind} alert-soft shadow-lg ${kind === 'error' ? '' : 'fades'}">${icon(kind === 'error' ? 'alert' : 'check', 'sm')}<span>${message}</span></div></div>`;
}

export function log(c: Context<Env>, event: string, subject?: Record<string, string>): void {
  console.log(JSON.stringify({ event, time: new Date().toISOString(), ...subject, by: c.get('user')?.name ?? null }));
}

const NAV = [
  ['/', 'Servers', 'server'],
  ['/keys', 'Keys', 'key'],
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
        <link rel="stylesheet" href="/assets/ui.css?v=${stylesheet().version}" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>`;
  if (options.bare) {
    return html`${head}
      <body class="bare">
        <main class="bare-main">
          <div class="brand mb-6">${LOGO}<span>MCP Yard</span></div>
          ${body}
        </main>
      </body>
    </html>`;
  }
  return html`${head}
    <body>
      <div class="drawer lg:drawer-open">
        <input id="nav" type="checkbox" class="drawer-toggle" />
        <div class="drawer-content">
          <header class="mobilebar">
            <label for="nav" class="btn btn-ghost btn-square" aria-label="Open the menu">${icon('menu')}</label>
            <a class="brand" href="/">${LOGO}<span>MCP Yard</span></a>
          </header>
          <main class="page">${body}</main>
        </div>
        <div class="drawer-side z-40">
          <label for="nav" class="drawer-overlay" aria-label="Close the menu"></label>
          <aside class="sidebar">
            <a class="brand" href="/">${LOGO}<span>MCP Yard</span></a>
            <ul class="menu w-full gap-1">
              ${NAV.map(([href, label, name]) => html`<li><a href="${href}" class="${active(href) ? 'menu-active' : ''}">${icon(name)}${label}</a></li>`)}
            </ul>
            ${versionLine()}
            ${user
              ? html`<form method="post" action="/auth/logout" class="userbox">
                  <div class="avatar avatar-placeholder"><div class="bg-primary text-primary-content w-8 rounded-full avatar-face">
                    <span>${user.name.slice(0, 1).toUpperCase()}</span>
                    ${user.picture ? html`<img src="${user.picture}" alt="" referrerpolicy="no-referrer" />` : ''}
                  </div></div>
                  <div class="grow min-w-0"><div class="truncate font-medium">${user.name}</div><div class="text-xs opacity-60">signed in</div></div>
                  <button class="btn btn-ghost btn-sm btn-square" title="Sign out" aria-label="Sign out">${icon('logout', 'sm')}</button>
                </form>`
              : html`<div class="userbox text-xs opacity-70">${icon('lock', 'sm')}<span>Sign-in is off (MCPYARD_UI_AUTH=none)</span></div>`}
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
  return newer && latest
    ? html`<a class="version-line newer" href="${latest.url}" target="_blank" rel="noreferrer" title="v${latest.version} is available: release notes">${icon('up', 'xs')}<span>${label}</span></a>`
    : html`<a class="version-line" href="/settings" title="About MCP Yard"><span>${label}</span></a>`;
}

const SCRIPT = `
document.addEventListener('submit', (e) => {
  const message = e.target.dataset.confirm;
  if (message && !confirm(message)) e.preventDefault();
});
document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-dialog]');
  if (opener) { e.preventDefault(); document.getElementById(opener.dataset.dialog)?.showModal(); }
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
if (document.getElementById('servers')) setInterval(async () => {
  if (document.hidden || document.querySelector('dialog[open]')) return;
  const current = document.getElementById('servers');
  const open = [...current.querySelectorAll('input[data-id]:checked')].map((i) => i.dataset.id);
  const res = await fetch('/').catch(() => null);
  if (!res || !res.ok || res.redirected) return;
  const next = new DOMParser().parseFromString(await res.text(), 'text/html').getElementById('servers');
  if (!next) return;
  for (const id of open) { const box = next.querySelector('input[data-id="' + CSS.escape(id) + '"]'); if (box) box.checked = true; }
  current.replaceWith(next);
}, 4000);`;

/** Layout only: daisyUI draws the components. Tailwind utilities are not in the prebuilt CSS, so the few we need live here. */
function CSS(): string {
  return `
.icon { flex: none; } .icon-md { width: 18px; height: 18px; } .icon-sm { width: 15px; height: 15px; } .icon-xs { width: 12px; height: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; }
.grow { flex: 1 1 auto; } .min-w-0 { min-width: 0; } .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.w-full { width: 100%; } .w-8 { width: 2rem; } .rounded-full { border-radius: 9999px; } .z-40 { z-index: 40; } .z-50 { z-index: 50; }
.text-xs { font-size: 0.75rem; } .font-medium { font-weight: 500; } .opacity-60 { opacity: 0.6; } .opacity-70 { opacity: 0.7; }
.gap-1 { gap: 0.25rem; } .gap-2 { gap: 0.5rem; } .mb-6 { margin-bottom: 1.5rem; }
.bg-primary { background: var(--color-primary); } .text-primary-content { color: var(--color-primary-content); }
[hidden] { display: none !important; }
.badge.badge-soft { color: color-mix(in oklab, var(--badge-color, var(--color-base-content)) 40%, var(--color-base-content)); }
body { background: var(--color-base-200); min-height: 100vh; }
.logo { flex: none; object-fit: contain; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 1.1rem; color: var(--color-base-content); text-decoration: none; }
.sidebar { width: 252px; height: 100dvh; padding: 22px 14px; display: flex; flex-direction: column; gap: 18px; background: var(--color-base-200); border-right: 1px solid var(--color-base-300); }
.sidebar .brand { padding: 4px 12px; }
.sidebar .menu a { font-size: 0.95rem; padding: 0.55rem 0.8rem; }
.version-line { margin-top: auto; display: flex; justify-content: center; align-items: center; gap: 5px; font-size: 0.75rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: inherit; opacity: 0.55; text-decoration: none; }
.version-line:hover { opacity: 0.9; }
.version-line.newer { color: var(--color-primary); opacity: 1; font-weight: 600; }
.version-line + .userbox { margin-top: 0; }
.userbox { margin-top: auto; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-box); background: var(--color-base-100); font-size: 0.85rem; }
.mobilebar { display: none; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--color-base-300); background: var(--color-base-100); position: sticky; top: 0; z-index: 30; }
@media (max-width: 1023px) { .mobilebar { display: flex; } }
.page { padding: 32px clamp(16px, 3vw, 48px) 72px; }
@media (max-width: 700px) { .page { padding: 20px 16px 56px; } }
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 26px; }
.page-head h1 { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 8px; }
.row-wrap { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.muted { opacity: 0.65; }
.section-title { font-size: 1.1rem; font-weight: 650; margin: 32px 0 12px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 18px; }
.srv { background: var(--color-base-100); }
.srv .card-body { gap: 14px; }
.srv-top { display: flex; align-items: flex-start; gap: 14px; }
.kind-icon { width: 42px; height: 42px; border-radius: 14px; display: grid; place-items: center; background: var(--color-base-200); flex: none; }
.srv-title { flex: 1; min-width: 0; }
.srv-title h3 { font-size: 1.02rem; font-weight: 650; margin: 0; }
.srv dl { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 0; }
.srv dt { font-size: 0.75rem; opacity: 0.6; margin-bottom: 3px; }
.srv dd { margin: 0; font-size: 0.9rem; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.callout { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-box); font-size: 0.87rem; }
.callout.update { background: color-mix(in oklab, var(--color-primary) 10%, transparent); }
.callout.error { background: color-mix(in oklab, var(--color-error) 12%, transparent); color: var(--color-error); align-items: flex-start; white-space: pre-wrap; word-break: break-word; }
.callout .grow { min-width: 0; }
.actions { display: flex; justify-content: flex-end; gap: 4px; flex-wrap: wrap; }
.actions form { display: contents; }
.tools-list { display: flex; flex-wrap: wrap; gap: 6px; }
.tools-list .off { text-decoration: line-through; opacity: 0.5; }
.list { background: var(--color-base-100); border-radius: var(--radius-box); border: 1px solid var(--color-base-300); overflow: hidden; }
.list > .acc + .acc { border-top: 1px solid var(--color-base-300); }
.acc-title { position: relative; display: grid; grid-template-columns: 34px minmax(160px, 1.3fr) 110px minmax(140px, 1fr) 150px 16px; align-items: center; gap: 14px; padding: 12px 18px; cursor: pointer; transition: background-color 0.15s; }
.acc-title:hover { background: color-mix(in oklab, var(--color-base-200) 60%, transparent); }
.acc-title:has(:focus-visible) { outline: 2px solid var(--color-primary); outline-offset: -2px; }
.acc .kind-icon { width: 34px; height: 34px; border-radius: 10px; }
.chevron { width: 8px; height: 8px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(45deg); opacity: 0.6; transition: transform 0.25s ease; justify-self: end; margin-top: -4px; }
.acc:has(> .acc-title :checked) .chevron { transform: rotate(-135deg); margin-top: 4px; }
.acc-wrap { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.25s ease; }
.acc:has(> .acc-title :checked) .acc-wrap { grid-template-rows: 1fr; }
.acc-wrap > div { overflow: hidden; min-height: 0; }
.acc-body { display: grid; gap: 14px; padding: 2px 18px 16px 66px; }
@media (max-width: 800px) { .acc-title { grid-template-columns: 34px 1fr auto 16px; } .acc .hide-sm { display: none; } .acc-body { padding-left: 18px; } }
@media (prefers-reduced-motion: reduce) { .acc-wrap, .chevron { transition: none; } }
.status-dot.pulse { animation: pulse 1.2s ease-in-out infinite; } @keyframes pulse { 50% { opacity: 0.25; } }
.panel { background: var(--color-base-100); border: 1px solid var(--color-base-300); border-radius: var(--radius-box); padding: 22px 24px; }
.panel h2 { font-size: 1.05rem; font-weight: 650; margin: 0 0 4px; }
.kv { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 0; border-top: 1px solid var(--color-base-300); flex-wrap: wrap; }
.kv:first-of-type { margin-top: 12px; }
.kv > :first-child { font-weight: 600; font-size: 0.9rem; }
.kv-value { text-align: right; min-width: 0; }
.panel-flush { padding: 4px 6px; }
.avatar-face { position: relative; overflow: hidden; }
.avatar-face img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.admin-block { border: 1px solid color-mix(in oklab, var(--color-warning) 55%, transparent); background: color-mix(in oklab, var(--color-warning) 9%, transparent); border-radius: var(--radius-box); padding: 14px 18px; display: grid; gap: 8px; }
.admin-head { display: flex; align-items: center; gap: 8px; color: color-mix(in oklab, var(--color-warning) 45%, var(--color-base-content)); }
.admin-block p { margin: 0; font-size: 0.85rem; }
.admin-panel { border-color: color-mix(in oklab, var(--color-warning) 55%, transparent); }
.hint { font-size: 0.75rem; opacity: 0.7; margin-top: 2px; }
.inline-form { display: inline-flex; }
.checks { display: flex; flex-wrap: wrap; gap: 6px 22px; }
.block { display: block; } .break-all { word-break: break-all; } .w-px { width: 1px; white-space: nowrap; } .justify-end { justify-content: flex-end; }
.py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; } .max-w-3xl { max-width: 48rem; } .w-44 { width: 11rem; } .whitespace-normal { white-space: normal; } .overflow-x-auto { overflow-x: auto; }
.settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: 18px; align-items: start; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 4px 20px; }
.form-grid .span { grid-column: 1 / -1; }

.fieldset .input, .fieldset .select, .fieldset .textarea { width: 100%; }
.fieldset .textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; }
.secret { display: flex; align-items: center; gap: 8px; background: var(--color-base-200); border-radius: var(--radius-field); padding: 10px 12px; }
.secret code { flex: 1; min-width: 0; word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; }
.fades { animation: fade 0.4s ease 4.6s forwards; } @keyframes fade { to { opacity: 0; transform: translateY(8px); } }
.locked { white-space: nowrap; }
.keys-table td { vertical-align: middle; }
.keys-table td:first-child, .keys-table .actions, .keys-table .row-wrap { white-space: nowrap; flex-wrap: nowrap; }
.hidden-radio { position: absolute; opacity: 0; width: 1px; height: 1px; pointer-events: none; }
.seg:has(:checked) { --btn-color: var(--color-primary); --btn-fg: var(--color-primary-content); }
.seg:has(:focus-visible) { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.contents { display: contents; } .flex-wrap { flex-wrap: wrap; }
.max-w-2xl { max-width: 42rem; } .w-32 { width: 8rem; } .text-lg { font-size: 1.125rem; } .text-sm { font-size: 0.875rem; } .font-bold { font-weight: 700; }
.mt-1 { margin-top: 0.25rem; } .mt-2 { margin-top: 0.5rem; } .mt-4 { margin-top: 1rem; } .mb-2 { margin-bottom: 0.5rem; } .mb-4 { margin-bottom: 1rem; }
.gap-4 { gap: 1rem; } .cursor-pointer { cursor: pointer; } .text-error { color: var(--color-error); }
.tools { display: grid; min-width: 0; }
.tools-toggle { position: relative; cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
.tools-toggle:has(:focus-visible) { outline: 2px solid var(--color-primary); outline-offset: 2px; border-radius: 4px; }
.tools-wrap { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.25s ease; }
.tools:has(.tools-toggle :checked) .tools-wrap { grid-template-rows: 1fr; }
.tools-wrap > div { overflow: hidden; min-height: 0; }
.tools-wrap .tools-list { padding-top: 8px; }
@media (prefers-reduced-motion: reduce) { .tools-wrap { transition: none; } }
.bare { display: grid; place-items: center; }
.bare-main { width: min(440px, calc(100vw - 32px)); padding: 40px 0; }
`;
}
