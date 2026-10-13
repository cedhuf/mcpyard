import { html } from 'hono/html';
import { icon, mascot } from './ui-icons.ts';
import type { Fragment } from './ui-layout.ts';

/**
 * The building blocks every page is made of: daisyUI components laid out with Tailwind utilities.
 * Pages only arrange them, so the whole UI shares one look.
 */

export type Content = Fragment | string | (Fragment | string)[];
export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'error' | 'info';
export type Crumb = { label: Content; href?: string };

/** The top of every page: breadcrumbs from the home page, the title, a line under it, and the page's actions. */
export function pageHead(title: Content, options: { sub?: Content; actions?: Content; crumbs?: Crumb[]; eyebrow?: Content } = {}): Fragment {
  return html`<header class="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 mb-6">
    <div class="min-w-0">
      ${breadcrumbs(options.crumbs ?? [{ label: title }])}
      ${options.eyebrow ? html`<p class="mt-2 text-xs font-semibold uppercase tracking-[0.2em] text-primary">${options.eyebrow}</p>` : ''}
      <h1 class="flex flex-wrap items-center gap-3 font-display text-3xl font-semibold">${title}</h1>
      ${options.sub ? html`<p class="mt-1 text-base-content/60">${options.sub}</p>` : ''}
    </div>
    ${options.actions ? html`<div class="flex flex-wrap items-center gap-2 max-sm:w-full">${options.actions}</div>` : ''}
  </header>`;
}

export function breadcrumbs(items: Crumb[]): Fragment {
  const home = html`<li><a href="/" aria-label="Dashboard" title="Dashboard">${icon('home', 'sm')}</a></li>`;
  return html`<nav class="breadcrumbs text-sm text-base-content/60 py-0 mb-1" aria-label="Breadcrumb"><ul>${home}${items.map((c) => html`<li>${c.href ? html`<a href="${c.href}">${c.label}</a>` : html`<span class="text-base-content" aria-current="page">${c.label}</span>`}</li>`)}</ul></nav>`;
}

/** A daisyUI card with a border. */
export function box(content: Content, options: { title?: Content; aside?: Content; pad?: boolean } = {}): Fragment {
  return html`<section class="card card-border border-base-300 bg-base-100 min-w-0">
    ${options.title ? html`<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 py-3 border-b border-base-300"><h2 class="card-title font-display text-lg font-medium whitespace-nowrap">${options.title}</h2>${options.aside ?? ''}</div>` : ''}
    ${options.pad ? html`<div class="card-body p-5">${content}</div>` : content}
  </section>`;
}

type Heading = string | { label: string; hide?: boolean };

/** A daisyUI table in a card. Hidden columns disappear below the lg breakpoint. */
export function list(headings: Heading[], rows: Fragment[]): Fragment {
  return html`<div class="card card-border border-base-300 bg-base-100 overflow-x-auto"><table class="table">
    <thead><tr class="text-base-content/60">${headings.map((h) => (typeof h === 'string' ? html`<th>${h}</th>` : html`<th class="${h.hide ? 'max-lg:hidden' : ''}">${h.label}</th>`))}<th class="w-px"></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

/** A row whose title link covers it all, while the controls at its end stay clickable on top. */
export const ROW = 'relative hover:bg-base-200/50 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-primary has-[a:focus-visible]:-outline-offset-2';
export const ROW_ANCHOR = "outline-none after:absolute after:inset-0 after:content-['']";
export const ROW_END = 'relative z-1';

/** A table row; the title cell's link covers the whole row while the controls stay on top. */
export function row(cells: Content, options: { end?: Content; off?: boolean } = {}): Fragment {
  return html`<tr class="${ROW} ${options.off ? 'text-base-content/50' : ''}">${cells}<td class="w-px"><div class="${ROW_END} flex items-center justify-end gap-1">${options.end ?? ''}</div></td></tr>`;
}

/** The first cell of a row: a name, linked when `href` is set, and a quieter second line. */
export function title(name: Content, sub?: Content, options: { mono?: boolean; href?: string } = {}): Fragment {
  const label = options.href ? html`<a class="${ROW_ANCHOR}" href="${options.href}">${name}</a>` : name;
  return html`<td class="max-w-0 w-[40%]"><div class="font-semibold truncate ${options.mono ? 'font-mono' : ''}">${label}</div>${sub ? html`<div class="text-xs text-base-content/50 truncate">${sub}</div>` : ''}</td>`;
}

export function cell(content: Content, options: { hide?: boolean } = {}): Fragment {
  return html`<td class="${options.hide ? 'max-lg:hidden' : ''} text-base-content/70 whitespace-nowrap">${content}</td>`;
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
  return html`<div class="alert alert-soft alert-${tone} alert-vertical sm:alert-horizontal text-sm" role="${tone === 'error' ? 'alert' : 'status'}">${icon(name, 'sm')}<div class="min-w-0 break-words">${content}</div>${action ?? ''}</div>`;
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

export type MenuEntry = {
  label: string;
  icon: string;
  /** A link, or else a POST to `post`, with an optional `name=value` and a confirmation. */
  href?: string;
  post?: string;
  value?: [name: string, value: string];
  confirm?: string;
  danger?: boolean;
  badge?: string;
};

/**
 * A daisyUI dropdown menu on the popover API: it sits in the top layer, so no table edge clips it and
 * no row covers it, and it closes on an outside click without any script. Its POST entries share one
 * form, each button naming its own action.
 */
export function menu(name: string, label: string, entries: (MenuEntry | false | undefined)[], options: { title?: Content; trigger?: Content } = {}): Fragment {
  const id = `menu-${name}`;
  const item = (e: MenuEntry) => {
    const body = html`${icon(e.icon, 'sm')}<span class="flex-1">${e.label}</span>${e.badge ? html`<span class="badge badge-sm badge-primary">${e.badge}</span>` : ''}`;
    if (e.href) return html`<li><a href="${e.href}">${body}</a></li>`;
    return html`<li><button formaction="${e.post}" class="${e.danger ? 'text-error' : ''}" ${e.value ? html`name="${e.value[0]}" value="${e.value[1]}"` : ''} ${e.confirm ? html`data-confirm="${e.confirm}"` : ''}>${body}</button></li>`;
  };
  return html`<form method="post" class="contents">
    <button type="button" class="btn btn-ghost ${options.trigger ? 'btn-circle' : 'btn-sm btn-square'}" popovertarget="${id}" style="anchor-name:--${id}" aria-label="${label}">${options.trigger ?? icon('dots')}</button>
    <ul class="dropdown dropdown-end menu w-60 rounded-box border border-base-300 bg-base-100 text-base-content p-1 shadow-lg [position-try-fallbacks:flip-block]" popover id="${id}" style="position-anchor:--${id}">${options.title ? html`<li class="menu-title truncate">${options.title}</li>` : ''}${entries.filter((e): e is MenuEntry => !!e).map(item)}</ul>
  </form>`;
}

/** One block of a long form or page: its title and explanation on the left, the content on the right. */
export function section(heading: Content, description: Content, content: Content, options: { kinds?: string; tone?: 'warning'; id?: string } = {}): Fragment {
  return html`<section ${options.id ? html`id="${options.id}"` : ''} class="grid md:grid-cols-[minmax(180px,280px)_1fr] gap-x-10 gap-y-3 p-5 md:p-6 border-base-300 [&+&]:border-t ${options.tone === 'warning' ? 'bg-warning/5' : ''}" ${options.kinds ? html`data-kinds="${options.kinds}"` : ''}>
    <div><h2 class="font-display text-lg font-medium flex items-center gap-2">${heading}</h2>${description ? html`<p class="mt-1 text-[13px] text-base-content/60">${description}</p>` : ''}</div>
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

/** daisyUI stats: one figure each, with an optional icon and a line under it. */
export function stats(items: { label: string; value: Content; tone?: Tone; desc?: Content; icon?: string; tint?: string }[], options: { large?: boolean } = {}): Fragment {
  return html`<div class="stats grid grid-flow-row grid-cols-2 lg:grid-cols-4 w-full border border-base-300 bg-base-100">${items.map(
    (s) => html`<div class="stat ${options.large ? 'py-4' : 'py-2.5'}">
      ${s.icon ? html`<div class="stat-figure ${s.tint ?? 'text-base-content/40'}">${icon(s.icon, 'md')}</div>` : ''}
      <div class="stat-title">${s.label}</div>
      <div class="stat-value ${options.large ? 'font-display text-3xl' : 'text-xl'} ${s.tone === 'error' ? 'text-error' : ''}">${s.value}</div>
      ${s.desc ? html`<div class="stat-desc whitespace-normal">${s.desc}</div>` : ''}
    </div>`,
  )}</div>`;
}

type ButtonOptions = { tone?: 'primary' | 'ghost' | 'outline' | 'danger'; icon?: string; title?: string };

function buttonClass(options: ButtonOptions): string {
  const tone = { primary: 'btn-primary', ghost: 'btn-ghost', outline: '', danger: 'btn-ghost text-error' }[options.tone ?? 'outline'];
  return `btn btn-sm ${tone}`;
}

export function linkButton(href: string, label: Content, options: ButtonOptions = {}): Fragment {
  return html`<a class="${buttonClass(options)}" href="${href}" ${options.title ? html`title="${options.title}"` : ''}>${options.icon ? icon(options.icon, 'sm') : ''}${label}</a>`;
}

/** A button that opens a daisyUI modal, through an invoker command: no script. */
export function dialogButton(dialog: string, label: Content, options: ButtonOptions = {}): Fragment {
  return html`<button type="button" class="${buttonClass(options)}" command="show-modal" commandfor="${dialog}">${options.icon ? icon(options.icon, 'sm') : ''}${label}</button>`;
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

/** An empty or lost page: the mascot, a title, a line and what to do next. */
export function hero(heading: Content, text: Content, action?: Content): Fragment {
  return html`<div class="card card-border border-base-300 bg-base-100"><div class="card-body items-center text-center gap-3 py-12">
    ${mascot('lg')}
    <h2 class="font-display text-2xl font-semibold">${heading}</h2>
    <p class="max-w-md text-base-content/70">${text}</p>
    ${action ? html`<div class="mt-2">${action}</div>` : ''}
  </div></div>`;
}

/** A row of controls above a list: filters, search, layout. */
export function toolbar(content: Content): Fragment {
  return html`<div class="flex flex-wrap items-center gap-2 mb-4">${content}</div>`;
}
