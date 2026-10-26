import type { Context, Hono, MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import type { Hub } from './front.ts';
import { MAX_DESCRIPTION } from './skills.ts';
import { box, empty, field, fields, linkButton, note, postButton, section, tag } from './ui-kit.ts';
import { log, notFound, page, toast, type Env, type Fragment } from './ui-layout.ts';
import { logsForServer } from './ui-logs.ts';
import { rowOf, serverHead, type Row } from './ui-servers.ts';

type Draft = { name: string; description: string; body: string };

/** `editable`: whether the server file can be written, for the server actions at the top. */
export function skillRoutes(app: Hono<Env>, hub: Hub, guard: MiddlewareHandler<Env>, editable: () => boolean): void {
  const server = (c: Context<Env>) => rowOf(hub, c.req.param('name') ?? '');
  const own = (row: Row, skill: string) => row.skills.find((s) => s.own && s.skill.frontmatter.name === skill);

  app.get('/servers/:name/skills', guard, (c) => {
    const row = server(c);
    if (!row) return notFound(c);
    const saved = c.req.query('saved');
    const deleted = c.req.query('deleted');
    const notice = saved ? toast(html`Saved <strong>${saved}</strong>; clients see it at once.`) : deleted ? toast(html`Deleted <strong>${deleted}</strong>.`) : '';
    return c.html(page(c, `${row.config.title ?? row.name} skills`, html`${skillsView(row, editable(), !!hub.skills)}${notice}`));
  });

  app.get('/servers/:name/new-skill', guard, (c) => {
    const row = server(c);
    if (!row || !hub.skills) return notFound(c);
    return c.html(page(c, 'New skill', editor(row, editable(), undefined, { name: '', description: '', body: '' })));
  });

  app.get('/servers/:name/skills/:skill', guard, (c) => {
    const row = server(c);
    const name = c.req.param('skill');
    const served = row && own(row, name);
    if (!row || !served || !hub.skills) return notFound(c);
    const draft = { name, description: String(served.skill.frontmatter.description), body: hub.skills.body(row.name, name) ?? '' };
    return c.html(page(c, name, editor(row, editable(), name, draft)));
  });

  const save = async (c: Context<Env>, existing: string | undefined) => {
    const row = server(c);
    if (!row || !hub.skills || (existing && !own(row, existing))) return notFound(c);
    const form = await c.req.parseBody();
    const draft = { name: existing ?? String(form.name ?? '').trim(), description: String(form.description ?? '').trim(), body: String(form.body ?? '') };
    const fail = (message: string) => c.html(page(c, existing ?? 'New skill', editor(row, editable(), existing, draft, message)), 400);
    if (!existing && own(row, draft.name)) return fail(`A skill named ${draft.name} already exists.`);
    if (!draft.description) return fail('Description: say what the skill covers and when to use it.');
    if (draft.description.length > MAX_DESCRIPTION) return fail(`Description: ${MAX_DESCRIPTION} characters at most.`);
    try {
      hub.skills.write(row.name, draft.name, draft.description, draft.body);
    } catch (e) {
      return fail((e as Error).message);
    }
    await hub.reloadSkills();
    log(c, existing ? 'skill_updated' : 'skill_added', { server: row.name, skill: draft.name });
    return c.redirect(`/servers/${row.name}/skills?saved=${encodeURIComponent(draft.name)}`, 303);
  };

  app.post('/servers/:name/skills', guard, (c) => save(c, undefined));
  app.post('/servers/:name/skills/:skill', guard, (c) => save(c, c.req.param('skill')));

  app.post('/servers/:name/skills/:skill/delete', guard, async (c) => {
    const row = server(c);
    const name = c.req.param('skill');
    if (!row || !hub.skills || !own(row, name)) return notFound(c);
    hub.skills.remove(row.name, name);
    await hub.reloadSkills();
    log(c, 'skill_deleted', { server: row.name, skill: name });
    return c.redirect(`/servers/${row.name}/skills?deleted=${encodeURIComponent(name)}`, 303);
  });
}

function skillsView(row: Row, editable: boolean, writable: boolean): Fragment {
  const add = writable ? linkButton(`/servers/${row.name}/new-skill`, 'Add skill', { tone: 'primary', icon: 'plus' }) : '';
  const base = `/servers/${row.name}/skills`;
  return html`${serverHead(row, editable, 'skills', logsForServer(row.name).length)}
    <div class="grid gap-4">
      ${row.skills.length
        ? box(
            html`<ul class="list">${row.skills.map(({ skill, own }) => {
              const name = String(skill.frontmatter.name);
              return html`<li class="list-row items-center">
                <div class="list-col-grow min-w-0">
                  <div class="font-mono font-medium flex flex-wrap items-center gap-2">
                    ${own ? html`<a class="link link-hover" href="${base}/${name}">${name}</a>` : name}
                    ${own ? tag('added here', { tone: 'primary' }) : tag('from the server')}
                  </div>
                  <p class="mt-0.5 text-[13px] text-base-content/60 break-words">${String(skill.frontmatter.description)}</p>
                </div>
                ${own && writable
                  ? html`<div class="flex items-center gap-1">
                      ${linkButton(`${base}/${name}`, 'Edit', { tone: 'ghost', icon: 'pencil' })}
                      ${postButton(`${base}/${name}/delete`, 'Delete', { tone: 'ghost', icon: 'trash', confirm: `Delete the skill ${name} and every file in its folder?` })}
                    </div>`
                  : ''}
              </li>`;
            })}</ul>`,
            { title: html`Skills <span class="badge badge-sm badge-ghost">${row.skills.length}</span>`, aside: add },
          )
        : empty(html`<p class="text-center max-w-md">No skills yet. A skill tells agents how to use this server well; clients that support MCP skills load it when it is relevant.</p>${add}`)}
      <p class="text-[13px] text-base-content/50">Every key that sees ${row.name} sees its skills. Skills the server serves itself show up while it runs; a skill added here with the same name replaces it.</p>
    </div>`;
}

function editor(row: Row, editable: boolean, existing: string | undefined, draft: Draft, error?: string): Fragment {
  const action = existing ? `/servers/${row.name}/skills/${existing}` : `/servers/${row.name}/skills`;
  return html`${serverHead(row, editable, 'skills', logsForServer(row.name).length)}
    <div class="grid gap-4">
      ${error ? note(html`Not saved: ${error}`, 'error') : ''}
      <form method="post" action="${action}" class="grid gap-4">
        ${box(html`
          ${section(
            'Skill',
            'The agent sees the name and the description up front, and loads the instructions only when the description matches its task.',
            fields(html`
              ${existing
                ? field('Name', html`<p class="font-mono py-1">${existing}</p>`)
                : field('Name', html`<input class="input input-sm font-mono" name="name" required maxlength="64" pattern="[a-z0-9]+(-[a-z0-9]+)*" value="${draft.name}" placeholder="triage" />`, { hint: 'Lowercase letters, digits and hyphens.' })}
              ${field('Description', html`<textarea class="textarea textarea-sm" name="description" required maxlength="${MAX_DESCRIPTION}" rows="3" placeholder="Sort the inbox. Use for inbox-zero passes or moving mail between folders.">${draft.description}</textarea>`, { wide: true, hint: 'What it covers and when to use it.' })}
            `),
          )}
          ${section(
            'Instructions',
            html`Markdown. Other files in the skill's folder are served next to it, and the instructions can point to them.`,
            html`<textarea class="textarea textarea-sm font-mono w-full" name="body" rows="18" placeholder="# Triage&#10;&#10;Archive newsletters older than a week.">${draft.body}</textarea>`,
          )}
        `)}
        <div class="savebar sticky bottom-3 z-20 flex flex-wrap items-center justify-end gap-2 rounded-box border border-base-300 bg-base-100/85 py-2.5 pl-5 pr-3 shadow-sm">
          <span class="flex-1 text-[13px] text-base-content/50">Clients see the change at once; nothing restarts.</span>
          ${linkButton(`/servers/${row.name}/skills`, 'Cancel', { tone: 'ghost' })}
          <button class="btn btn-sm btn-primary">${existing ? 'Save' : 'Add skill'}</button>
        </div>
      </form>
    </div>`;
}
