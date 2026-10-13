import { html } from 'hono/html';
import { icon, type Fragment } from './ui-layout.ts';

/**
 * The building blocks every page is made of: daisyUI components laid out with Tailwind utilities.
 * Pages only arrange them, so the whole UI shares one look.
 */

export type Content = Fragment | string | (Fragment | string)[];
export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'error' | 'info';
export type Crumb = { label: Content; href?: string };

export function pageHead(title: Content, options: { sub?: Content; actions?: Content; crumbs?: Crumb[] } = {}): Fragment {
  return html`<header class="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 mb-6">
    <div class="min-w-0">
      ${options.crumbs ? breadcrumbs(options.crumbs) : ''}
      <h1 class="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">${title}</h1>
      ${options.sub ? html`<p class="mt-1 text-base-content/60">${options.sub}</p>` : ''}
    </div>
    ${options.actions ? html`<div class="flex flex-wrap items-center gap-2">${options.actions}</div>` : ''}
  </header>`;
}

export function breadcrumbs(items: Crumb[]): Fragment {
  return html`<nav class="breadcrumbs text-sm text-base-content/60 py-0 mb-1" aria-label="Breadcrumb"><ul>${items.map((c) => html`<li>${c.href ? html`<a href="${c.href}">${c.label}</a>` : html`<span class="text-base-content" aria-current="page">${c.label}</span>`}</li>`)}</ul></nav>`;
}

/** A daisyUI card with a border. */
export function box(content: Content, options: { title?: Content; aside?: Content; pad?: boolean } = {}): Fragment {
  return html`<section class="card card-border border-base-300 bg-base-100 min-w-0">
    ${options.title ? html`<div class="flex items-center justify-between gap-3 px-5 py-3 border-b border-base-300"><h2 class="font-semibold flex items-center gap-2">${options.title}</h2>${options.aside ?? ''}</div>` : ''}
    ${options.pad ? html`<div class="card-body p-5">${content}</div>` : content}
  </section>`;
}

type Heading = string | { label: string; hide?: boolean };

/** A daisyUI table in a card. Hidden columns disappear below the md breakpoint. */
export function list(headings: Heading[], rows: Fragment[]): Fragment {
  return html`<div class="card card-border border-base-300 bg-base-100 overflow-hidden"><table class="table">
    <thead><tr class="text-base-content/60">${headings.map((h) => (typeof h === 'string' ? html`<th>${h}</th>` : html`<th class="${h.hide ? 'max-md:hidden' : ''}">${h.label}</th>`))}<th class="w-px"></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

/** A table row; the title cell's link covers the whole row while the controls stay on top. */
export function row(cells: Content, options: { end?: Content; off?: boolean } = {}): Fragment {
  return html`<tr class="row-link ${options.off ? 'text-base-content/50' : ''}">${cells}<td class="w-px"><div class="row-end flex items-center justify-end gap-1">${options.end ?? ''}</div></td></tr>`;
}

/** The first cell of a row: a name, linked when `href` is set, and a quieter second line. */
export function title(name: Content, sub?: Content, options: { mono?: boolean; href?: string } = {}): Fragment {
  const label = options.href ? html`<a class="row-anchor" href="${options.href}">${name}</a>` : name;
  return html`<td class="max-w-0 w-[40%]"><div class="font-semibold truncate ${options.mono ? 'font-mono' : ''}">${label}</div>${sub ? html`<div class="text-xs text-base-content/50 truncate">${sub}</div>` : ''}</td>`;
}

export function cell(content: Content, options: { hide?: boolean } = {}): Fragment {
  return html`<td class="${options.hide ? 'max-md:hidden' : ''} text-base-content/70 whitespace-nowrap">${content}</td>`;
}

export function status(tone: Tone, label: string, options: { busy?: boolean } = {}): Fragment {
  return html`<span class="inline-flex items-center gap-2 whitespace-nowrap ${tone === 'error' ? 'text-error' : ''}"><span class="status ${tone === 'neutral' ? '' : `status-${tone}`} ${options.busy ? 'animate-pulse' : ''}" aria-hidden="true"></span>${label}</span>`;
}

export function tag(text: Content, options: { mono?: boolean; tone?: Tone; icon?: string; title?: string } = {}): Fragment {
  const tone = options.tone && options.tone !== 'neutral' ? `badge-soft badge-${options.tone}` : 'badge-ghost';
  return html`<span class="badge badge-sm ${tone} gap-1 whitespace-nowrap ${options.mono ? 'font-mono' : ''}" ${options.title ? html`title="${options.title}"` : ''}>${options.icon ? icon(options.icon, 'xs') : ''}${text}</span>`;
}

/** A daisyUI alert: an error, an available update, a warning. */
export function note(content: Content, tone: 'error' | 'info' | 'warning' = 'info', action?: Content): Fragment {
  const name = tone === 'error' ? 'alert' : tone === 'warning' ? 'lock' : 'up';
  return html`<div class="alert alert-soft alert-${tone} text-sm" role="${tone === 'error' ? 'alert' : 'status'}">${icon(name, 'sm')}<div class="min-w-0 break-words">${content}</div>${action ?? ''}</div>`;
}

type TabItem = { href: string; label: string; count?: number; active: boolean };

function tabItems(items: TabItem[]): Fragment[] {
  return items.map(
    (t) => html`<a role="tab" class="tab gap-1.5 ${t.active ? 'tab-active' : ''}" href="${t.href}" ${t.active ? html`aria-current="page"` : ''}>${t.label}${t.count === undefined ? '' : html`<span class="text-xs opacity-50 tabular-nums">${t.count}</span>`}</a>`,
  );
}

/** Filters: daisyUI boxed tabs, as links. */
export function chips(items: TabItem[]): Fragment {
  return html`<div role="tablist" class="tabs tabs-box tabs-sm">${tabItems(items)}</div>`;
}

/** Page tabs: daisyUI bordered tabs, as links. */
export function tabs(items: TabItem[]): Fragment {
  return html`<div role="tablist" class="tabs tabs-border -mt-2 mb-6 border-b border-base-300">${tabItems(items)}</div>`;
}

/** Icon buttons joined together, one active. */
export function segLinks(label: string, items: { href: string; icon: string; label: string; active: boolean }[]): Fragment {
  return html`<div class="join" role="group" aria-label="${label}">${items.map((i) => html`<a class="btn btn-sm btn-square join-item ${i.active ? 'btn-active' : ''}" href="${i.href}" title="${i.label}" aria-label="${i.label}">${icon(i.icon, 'sm')}</a>`)}</div>`;
}

/** Radio buttons joined together: daisyUI draws each from its aria-label. */
export function segRadio(name: string, options: { value: string; label: string }[], current: string, label: string): Fragment {
  return html`<div class="join" role="radiogroup" aria-label="${label}">${options.map((o) => html`<input class="join-item btn btn-sm" type="radio" name="${name}" value="${o.value}" aria-label="${o.label}" ${o.value === current ? 'checked' : ''} />`)}</div>`;
}

/** A GET search box that keeps the other query parameters. */
export function search(action: string, value: string, placeholder: string, keep: Record<string, string> = {}): Fragment {
  return html`<form method="get" action="${action}" class="max-sm:order-last max-sm:w-full" role="search">
    ${Object.entries(keep).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}
    <label class="input input-sm w-full sm:w-60">${icon('search', 'sm')}<input type="search" name="q" value="${value}" placeholder="${placeholder}" /></label>
  </form>`;
}

/** A daisyUI toggle that posts to `action`: a one-button form, so it works without any script. `locked` disables it. */
export function onOff(action: string, on: boolean, label: string, locked?: string): Fragment {
  if (locked) return html`<span class="tooltip tooltip-left" data-tip="${locked}"><input type="checkbox" class="toggle toggle-sm" disabled aria-label="${locked}" /></span>`;
  return html`<form method="post" action="${action}" class="inline-flex">
    <button class="toggle toggle-sm toggle-success" role="switch" aria-checked="${on ? 'true' : 'false'}" title="${label}" aria-label="${label}"></button>
  </form>`;
}

type MenuItem = Fragment | '' | false | undefined;

/** A daisyUI dropdown with a menu; a details element, so it needs no script. */
export function menu(label: string, items: MenuItem[]): Fragment {
  return html`<details class="dropdown dropdown-end">
    <summary class="btn btn-ghost btn-sm btn-square" aria-label="${label}">${icon('dots')}</summary>
    <ul class="dropdown-content menu z-40 mt-1 w-56 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">${items.filter(Boolean)}</ul>
  </details>`;
}

export function menuLink(href: string, label: Content, iconName: string): Fragment {
  return html`<li><a href="${href}">${icon(iconName, 'sm')}${label}</a></li>`;
}

export function menuItem(action: string, label: Content, iconName: string, options: { fields?: Record<string, string>; confirm?: string; danger?: boolean } = {}): Fragment {
  return html`<li><form method="post" action="${action}" ${options.confirm ? html`data-confirm="${options.confirm}"` : ''}>${hidden(options.fields)}<button class="${options.danger ? 'text-error' : ''}">${icon(iconName, 'sm')}${label}</button></form></li>`;
}

/** One block of a long form or page: its title and explanation on the left, the content on the right. */
export function section(heading: Content, description: Content, content: Content, options: { kinds?: string; tone?: 'warning' } = {}): Fragment {
  return html`<section class="grid md:grid-cols-[minmax(180px,280px)_1fr] gap-x-10 gap-y-3 p-5 md:p-6 border-base-300 [&+&]:border-t ${options.tone === 'warning' ? 'bg-warning/5' : ''}" ${options.kinds ? html`data-kinds="${options.kinds}"` : ''}>
    <div><h2 class="font-semibold flex items-center gap-2">${heading}</h2>${description ? html`<p class="mt-1 text-[13px] text-base-content/60">${description}</p>` : ''}</div>
    <div class="min-w-0">${content}</div>
  </section>`;
}

/** A setting inside a section: label and hint on the left, its control on the right. */
export function setting(label: Content, control: Content, hint?: Content): Fragment {
  return html`<div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-2.5 first:pt-0 last:pb-0 border-base-300 [&+&]:border-t">
    <div class="grid"><span class="font-medium">${label}</span>${hint ? html`<span class="text-xs text-base-content/50">${hint}</span>` : ''}</div>
    <div class="flex flex-wrap items-center justify-end gap-2">${control}</div>
  </div>`;
}

/** A daisyUI fieldset; `wide` spans both columns of a `fields` grid. */
export function field(legend: string, control: Content, options: { hint?: Content; wide?: boolean; kinds?: string } = {}): Fragment {
  return html`<fieldset class="fieldset py-0 min-w-0 ${options.wide ? 'sm:col-span-2' : ''}" ${options.kinds ? html`data-kinds="${options.kinds}"` : ''}>
    <legend class="fieldset-legend pt-0">${legend}</legend>
    ${control}
    ${options.hint ? html`<p class="label whitespace-normal">${options.hint}</p>` : ''}
  </fieldset>`;
}

export function fields(content: Content): Fragment {
  return html`<div class="grid sm:grid-cols-2 gap-x-5 gap-y-4 [&_.input]:w-full [&_.select]:w-full [&_.textarea]:w-full">${content}</div>`;
}

export function checkbox(name: string, value: string, label: Content, checked: boolean, kind: 'checkbox' | 'toggle' = 'checkbox'): Fragment {
  return html`<label class="label text-base-content cursor-pointer"><input type="checkbox" class="${kind === 'toggle' ? 'toggle toggle-sm' : 'checkbox checkbox-sm'}" name="${name}" value="${value}" ${checked ? 'checked' : ''} />${label}</label>`;
}

/** daisyUI stats. */
export function stats(items: { label: string; value: Content; tone?: Tone }[]): Fragment {
  return html`<div class="stats grid grid-flow-row grid-cols-2 sm:grid-cols-4 w-full border border-base-300 bg-base-100">${items.map((s) => html`<div class="stat py-2.5"><div class="stat-title">${s.label}</div><div class="stat-value text-xl ${s.tone === 'error' ? 'text-error' : ''}">${s.value}</div></div>`)}</div>`;
}

type ButtonOptions = { tone?: 'primary' | 'ghost' | 'outline' | 'danger'; icon?: string; title?: string };

function buttonClass(options: ButtonOptions): string {
  const tone = { primary: 'btn-primary', ghost: 'btn-ghost', outline: 'btn-outline border-base-300', danger: 'btn-ghost text-error' }[options.tone ?? 'outline'];
  return `btn btn-sm ${tone}`;
}

export function linkButton(href: string, label: Content, options: ButtonOptions & { dialog?: string } = {}): Fragment {
  return html`<a class="${buttonClass(options)}" href="${href}" ${options.dialog ? html`data-dialog="${options.dialog}"` : ''} ${options.title ? html`title="${options.title}"` : ''}>${options.icon ? icon(options.icon, 'sm') : ''}${label}</a>`;
}

/** A button that POSTs, with hidden fields and an optional confirmation. */
export function postButton(action: string, label: Content, options: ButtonOptions & { confirm?: string; fields?: Record<string, string> } = {}): Fragment {
  return html`<form method="post" action="${action}" class="inline-flex" ${options.confirm ? html`data-confirm="${options.confirm}"` : ''}>${hidden(options.fields)}<button class="${buttonClass(options)}" ${options.title ? html`title="${options.title}"` : ''}>${options.icon ? icon(options.icon, 'sm') : ''}${label}</button></form>`;
}

function hidden(fields: Record<string, string> = {}): Fragment[] {
  return Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`);
}

export function empty(content: Content): Fragment {
  return html`<div class="card card-border border-base-300 bg-base-100"><div class="card-body items-center py-10 text-base-content/60">${content}</div></div>`;
}

/** A row of controls above a list: filters, search, layout. */
export function toolbar(content: Content): Fragment {
  return html`<div class="flex flex-wrap items-center gap-2 mb-4">${content}</div>`;
}
