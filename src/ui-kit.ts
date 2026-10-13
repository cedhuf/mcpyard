import { html } from 'hono/html';
import { icon, type Fragment } from './ui-layout.ts';

/** The building blocks every page is made of, so pages only arrange them. */

type Content = Fragment | string | (Fragment | string)[];
type Tone = 'neutral' | 'primary' | 'info' | 'success' | 'warning' | 'error' | 'ghost';

export function pageHead(title: Content, options: { subtitle?: Content; below?: Content; actions?: Content } = {}): Fragment {
  return html`<div class="page-head">
    <div class="min-w-0">
      <h1>${title}</h1>
      ${options.subtitle ? html`<p class="muted">${options.subtitle}</p>` : ''}
      ${options.below ? html`<div class="row-wrap mt-2">${options.below}</div>` : ''}
    </div>
    ${options.actions ? html`<div class="row-wrap">${options.actions}</div>` : ''}
  </div>`;
}

export function panel(content: Content, options: { title?: Content; description?: Content; flush?: boolean; className?: string } = {}): Fragment {
  return html`<section class="panel ${options.flush ? 'panel-flush' : ''} ${options.className ?? ''}">
    ${options.title ? html`<h2>${options.title}</h2>` : ''}
    ${options.description ? html`<p class="muted text-sm">${options.description}</p>` : ''}
    ${content}
  </section>`;
}

/** A labelled form control; `wide` spans every column of a `form-grid`. */
export function field(legend: string, control: Content, options: { hint?: Content; wide?: boolean; kinds?: string } = {}): Fragment {
  return html`<fieldset class="fieldset ${options.wide ? 'span' : ''}" ${options.kinds ? html`data-kinds="${options.kinds}"` : ''}>
    <legend class="fieldset-legend">${legend}</legend>
    ${control}
    ${options.hint ? html`<p class="hint">${options.hint}</p>` : ''}
  </fieldset>`;
}

export function formGrid(content: Content, kinds?: string): Fragment {
  return html`<div class="form-grid" ${kinds ? html`data-kinds="${kinds}"` : ''}>${content}</div>`;
}

export function checkbox(name: string, value: string, label: Content, checked: boolean, kind: 'checkbox' | 'toggle' = 'checkbox'): Fragment {
  return html`<label class="label cursor-pointer"><input type="checkbox" class="${kind} ${kind}-sm ${kind === 'toggle' ? 'toggle-primary' : ''}" name="${name}" value="${value}" ${checked ? 'checked' : ''} /> ${label}</label>`;
}

export function kv(label: Content, value: Content): Fragment {
  return html`<div class="kv"><span>${label}</span><span class="kv-value">${value}</span></div>`;
}

export function table(headers: string[], rows: Content[], className = ''): Fragment {
  return panel(
    html`<div class="overflow-x-auto"><table class="table ${className}">
      ${headers.length ? html`<thead><tr>${headers.map((h) => html`<th>${h}</th>`)}</tr></thead>` : ''}
      <tbody>${rows}</tbody>
    </table></div>`,
    { flush: true },
  );
}

export function badge(text: Content, options: { tone?: Tone; soft?: boolean; icon?: string; mono?: boolean; small?: boolean; title?: string; className?: string } = {}): Fragment {
  const tone = options.tone ?? 'ghost';
  const classes = ['badge', `badge-${tone}`, options.soft && tone !== 'ghost' ? 'badge-soft' : '', options.small ? 'badge-sm' : '', options.mono ? 'mono' : '', options.icon ? 'gap-1' : '', options.className ?? ''];
  return html`<span class="${classes.filter(Boolean).join(' ')}" ${options.title ? html`title="${options.title}"` : ''}>${options.icon ? icon(options.icon, 'xs') : ''}${text}</span>`;
}

export function alert(content: Content, tone: 'info' | 'success' | 'warning' | 'error' = 'info'): Fragment {
  const name = tone === 'error' ? 'alert' : tone === 'warning' ? 'lock' : tone === 'success' ? 'check' : 'alert';
  return html`<div role="${tone === 'error' ? 'alert' : 'status'}" class="alert alert-${tone} alert-soft mb-6">${icon(name)}<div class="min-w-0">${content}</div></div>`;
}

type ButtonOptions = { tone?: 'primary' | 'ghost' | 'soft' | 'danger'; size?: 'xs' | 'sm' | 'md'; icon?: string; title?: string };

function buttonClass(options: ButtonOptions): string {
  const tone = { primary: 'btn-primary', ghost: 'btn-ghost', soft: 'btn-primary btn-soft', danger: 'btn-ghost text-error' }[options.tone ?? 'ghost'];
  return ['btn', tone, options.size && options.size !== 'md' ? `btn-${options.size}` : '', options.icon ? 'gap-2' : ''].filter(Boolean).join(' ');
}

export function linkButton(href: string, label: Content, options: ButtonOptions & { dialog?: string } = {}): Fragment {
  return html`<a class="${buttonClass(options)}" href="${href}" ${options.dialog ? html`data-dialog="${options.dialog}"` : ''} ${options.title ? html`title="${options.title}"` : ''}>${options.icon ? icon(options.icon, 'sm') : ''}${label}</a>`;
}

/** A button that POSTs, with hidden fields and an optional confirmation. */
export function postButton(action: string, label: Content, options: ButtonOptions & { confirm?: string; fields?: Record<string, string> } = {}): Fragment {
  return html`<form method="post" action="${action}" class="inline-form" ${options.confirm ? html`data-confirm="${options.confirm}"` : ''}>
    ${Object.entries(options.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}
    <button class="${buttonClass(options)}" ${options.title ? html`title="${options.title}"` : ''}>${options.icon ? icon(options.icon, 'sm') : ''}${label}</button>
  </form>`;
}

export function actions(content: Content): Fragment {
  return html`<div class="actions">${content}</div>`;
}

export function empty(content: Content): Fragment {
  return panel(html`<p class="muted">${content}</p>`);
}

/** An on/off switch posting to `action`: a one-button form, so it works without any script. `locked` shows a padlock instead. */
export function onOff(action: string, on: boolean, label: string, locked?: string): Fragment {
  if (locked) return html`<span class="switch locked" title="${locked}">${icon('lock', 'xs')}</span>`;
  return html`<form method="post" action="${action}" class="inline-form">
    <button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}" title="${label}" aria-label="${label}"></button>
  </form>`;
}

type MenuItem = Fragment | '' | false | undefined;

/** A "⋯" menu that needs no script: a details element. */
export function menu(label: string, items: MenuItem[]): Fragment {
  return html`<details class="dropdown dropdown-end">
    <summary class="btn btn-ghost btn-sm btn-square" aria-label="${label}">${icon('dots')}</summary>
    <ul class="dropdown-content menu srv-menu">${items.filter(Boolean)}</ul>
  </details>`;
}

export function menuLink(href: string, label: Content, iconName: string): Fragment {
  return html`<li><a href="${href}">${icon(iconName, 'sm')}${label}</a></li>`;
}

export function menuItem(action: string, label: Content, iconName: string, options: { fields?: Record<string, string>; confirm?: string; danger?: boolean } = {}): Fragment {
  return html`<li><form method="post" action="${action}" ${options.confirm ? html`data-confirm="${options.confirm}"` : ''}>${Object.entries(options.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}<button class="${options.danger ? 'text-error' : ''}">${icon(iconName, 'sm')}${label}</button></form></li>`;
}

export const menuDivider = html`<li aria-hidden="true"><hr /></li>`;

/** One titled block of a long form or page: the title and its explanation on the left, the content on the right. */
export function section(title: Content, description: Content, content: Content, options: { id?: string; kinds?: string } = {}): Fragment {
  return html`<section class="section" ${options.id ? html`id="${options.id}"` : ''} ${options.kinds ? html`data-kinds="${options.kinds}"` : ''}>
    <div class="section-side"><h2>${title}</h2>${description ? html`<p>${description}</p>` : ''}</div>
    <div class="section-main">${content}</div>
  </section>`;
}

/** Filter tabs as plain links, each with its count. */
export function tabs(items: { href: string; label: string; count?: number; active: boolean }[]): Fragment {
  return html`<div role="tablist" class="tabs tabs-box tabs-sm">
    ${items.map((t) => html`<a role="tab" class="tab ${t.active ? 'tab-active' : ''}" href="${t.href}">${t.label}${t.count === undefined ? '' : html` <span class="tab-count">${t.count}</span>`}</a>`)}
  </div>`;
}

/** A GET search box that keeps the other query parameters. */
export function search(action: string, value: string, placeholder: string, keep: Record<string, string> = {}): Fragment {
  return html`<form method="get" action="${action}" class="search">
    ${Object.entries(keep).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}
    <label class="input input-sm">${icon('search', 'sm')}<input type="search" name="q" value="${value}" placeholder="${placeholder}" /></label>
  </form>`;
}
