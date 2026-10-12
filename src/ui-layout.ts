import type { Context } from 'hono';
import { html, raw } from 'hono/html';
import type { User } from './oidc.ts';

export type Env = { Variables: { user?: User; nonce: string } };
export type Fragment = ReturnType<typeof html>;

export const LOCK = html`<svg class="lock" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4Zm1.5 0h5V5a2.5 2.5 0 0 0-5 0v2Z"/></svg>`;

export function log(c: Context<Env>, event: string, subject?: Record<string, string>): void {
  console.log(JSON.stringify({ event, time: new Date().toISOString(), ...subject, by: c.get('user')?.name ?? null }));
}

export function page(c: Context<Env>, title: string, body: Fragment): Fragment {
  const user = c.get('user');
  const nonce = c.get('nonce');
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · mcpyard</title>
        <style>
          ${raw(CSS)}
        </style>
      </head>
      <body>
        <header>
          <a class="brand" href="/">mcpyard</a>
          <nav><a href="/">Servers</a><a href="/keys">Keys</a><a href="/settings">Settings</a></nav>
          ${user ? html`<form method="post" action="/auth/logout" class="user"><span>${user.name}</span><button>Sign out</button></form>` : ''}
        </header>
        <main>${body}</main>
        ${nonce ? html`<script nonce="${nonce}">${raw(SCRIPT)}</script>` : ''}
      </body>
    </html>`;
}

const SCRIPT = `
const kind = document.querySelector('select[name=kind]');
if (kind) {
  const sync = () => document.querySelectorAll('[data-kinds]').forEach((el) => (el.hidden = !el.dataset.kinds.split(' ').includes(kind.value)));
  kind.addEventListener('change', sync);
  sync();
}
document.addEventListener('submit', (e) => {
  const message = e.target.dataset.confirm;
  if (message && !confirm(message)) e.preventDefault();
});
if (document.getElementById('servers')) setInterval(async () => {
  if (document.hidden) return;
  const current = document.getElementById('servers');
  const open = [...current.querySelectorAll('details[open]')].map((d) => d.dataset.id);
  const res = await fetch('/').catch(() => null);
  if (!res || !res.ok || res.redirected) return;
  const next = new DOMParser().parseFromString(await res.text(), 'text/html').getElementById('servers');
  if (!next) return;
  for (const id of open) next.querySelector('details[data-id="' + CSS.escape(id) + '"]')?.setAttribute('open', '');
  current.replaceWith(next);
}, 4000);`;

const CSS = `
:root { --bg: #f7f7f5; --fg: #1d1d1b; --muted: #6b6b66; --line: #e2e2dc; --card: #fff; --accent: #2f5bd3; --ok: #1f8a4c; --warn: #b7791f; --bad: #c53030; --info: #2b6cb0; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --fg: #ecece8; --muted: #9a9a93; --line: #2c2c2a; --card: #1d1d1c; --accent: #7aa2ff; --ok: #48bb78; --warn: #ecc94b; --bad: #fc8181; --info: #63b3ed; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; align-items: center; gap: 24px; padding: 12px 24px; border-bottom: 1px solid var(--line); background: var(--card); flex-wrap: wrap; }
.brand { font-weight: 700; font-size: 17px; color: var(--fg); text-decoration: none; letter-spacing: -0.01em; }
nav { display: flex; gap: 16px; flex: 1; }
nav a { color: var(--muted); text-decoration: none; }
nav a:hover { color: var(--fg); }
.user { display: flex; align-items: center; gap: 10px; color: var(--muted); }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 8px 0 16px; }
h2 { font-size: 17px; margin: 32px 0 12px; }
section.card h2, .notice h2 { margin-top: 0; }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
tr.error td { color: var(--bad); font-size: 13px; padding-top: 0; white-space: pre-wrap; word-break: break-word; }
tr.disabled td { opacity: 0.55; }
.muted { color: var(--muted); font-size: 13px; }
.mono, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
td .mono { word-break: break-all; }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid currentColor; }
.badge.ready { color: var(--ok); } .badge.degraded { color: var(--warn); } .badge.failed { color: var(--bad); }
.badge.installing, .badge.starting, .badge.updating { color: var(--info); } .badge.stopped, .badge.disabled { color: var(--muted); }
.tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; margin-left: 4px; }
details summary { cursor: pointer; }
ul.tools { margin: 6px 0 0; padding-left: 18px; }
ul.tools li.hidden { color: var(--muted); text-decoration: line-through; }
.actions { white-space: nowrap; text-align: right; }
.actions form, td form { display: inline-block; margin: 4px 4px 0 0; }
button, .button { font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; text-decoration: none; display: inline-block; }
button:hover, .button:hover { border-color: var(--muted); }
button.primary, .button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { color: var(--bad); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px 20px; }
.notice { border-color: var(--accent); margin-bottom: 24px; }
.notice.failed { border-color: var(--bad); }
.notice p { margin: 0; }
.notice pre { margin: 10px 0 0; }
.heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.buttons { display: flex; gap: 8px; }
.actions a.button { margin: 4px 4px 0 0; }
form.card { display: grid; gap: 14px; max-width: 560px; }
form.card label { display: grid; gap: 4px; font-weight: 600; font-size: 14px; }
form.card label.check { display: flex; gap: 8px; font-weight: 400; align-items: center; }
form.card button { justify-self: start; }
input, select { font: inherit; font-weight: 400; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
fieldset { border: 1px solid var(--line); border-radius: 6px; display: grid; gap: 6px; padding: 10px 14px; }
legend { font-weight: 600; font-size: 14px; padding: 0 4px; }
[hidden] { display: none !important; }
.locked { display: inline-flex; align-items: center; gap: 5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); background: var(--bg); border: 1px solid var(--line); border-radius: 999px; padding: 1px 9px 1px 7px; white-space: nowrap; }
.lock { flex: none; }
form.settings { display: grid; gap: 16px; max-width: 760px; }
form.settings .card h2 { margin: 0 0 4px; }
form.settings button { justify-self: start; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 10px 0; border-top: 1px solid var(--line); flex-wrap: wrap; }
.row > span:first-child { font-weight: 600; font-size: 14px; }
input.short { width: 80px; }
.switch { position: relative; display: inline-block; width: 40px; height: 22px; }
.switch input[type=checkbox] { opacity: 0; width: 0; height: 0; position: absolute; }
.switch span { position: absolute; inset: 0; background: var(--line); border-radius: 999px; transition: background 0.15s; cursor: pointer; }
.switch span::after { content: ""; position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.15s; box-shadow: 0 1px 2px rgba(0,0,0,0.3); }
.switch input:checked + span { background: var(--accent); }
.switch input:checked + span::after { transform: translateX(18px); }
.switch input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
form.card.wide { max-width: 860px; }
fieldset.plain { border: 0; padding: 0; margin: 0; display: grid; gap: 14px; min-width: 0; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
form.card label { align-content: start; }
main a:not(.button) { color: var(--accent); }
.grid .span { grid-column: 1 / -1; }
textarea { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); resize: vertical; }
.danger-zone { margin-top: 16px; }
@media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
@media (max-width: 700px) { thead { display: none; } table, tbody, tr, td { display: block; width: 100%; } td { border-bottom: 0; padding: 4px 12px; } tr { border-bottom: 1px solid var(--line); padding: 8px 0; } .actions { text-align: left; } }
`;
