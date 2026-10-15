import { Hono, type Context, type Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ConfigFile } from './config.ts';
import type { Hub } from './front.ts';
import type { Oidc, Signer, User } from './oidc.ts';
import type { Settings } from './settings.ts';
import { configRoutes, type EnvRow } from './ui-config.ts';
import { keyRoutes } from './ui-keys.ts';
import { logRoutes } from './ui-logs.ts';
import { dashboardRoutes } from './ui-dashboard.ts';
import { mascot, MOODS } from './ui-icons.ts';
import { note as inlineNote } from './ui-kit.ts';
import { FILTERS, serversView, type Filter, type FilterState, type View } from './ui-servers.ts';
import { note } from './logs.ts';
import { log, notFound, page, stylesheet, toast, type Env, type Fragment } from './ui-layout.ts';

export type { EnvRow };

export type UiAuth = { kind: 'none' } | { kind: 'oidc'; oidc: Oidc; signer: Signer };

export type UiOptions = { keysPath: string; auth: UiAuth; publicUrl?: string; settings?: Settings; configFile?: ConfigFile; environment?: EnvRow[] };

/** The logo files and the mascot, public like the stylesheet: browsers fetch them before any sign-in. */
const STATIC_FILES = [
  ['/favicon.ico', 'image/x-icon'],
  ['/favicon-16x16.png', 'image/png'],
  ['/favicon-32x32.png', 'image/png'],
  ['/apple-touch-icon.png', 'image/png'],
  ['/icon.png', 'image/png'],
  ...MOODS.map((mood) => [`/mascots/${mood}.png`, 'image/png'] as const),
] as const;

const FONT = readFileSync(fileURLToPath(import.meta.resolve('@fontsource-variable/fredoka/files/fredoka-latin-wght-normal.woff2')));

const SESSION = 'mcpyard_session';
const LOGIN = 'mcpyard_login';
const VIEW = 'mcpyard_view';
const SESSION_HOURS = 12;


export function ui(hub: Hub, options: UiOptions): Hono<Env> {
  const app = new Hono<Env>();
  const { auth, keysPath } = options;
  void stylesheet();
  const secure = (c: Context) => new URL(options.publicUrl ?? c.req.url).protocol === 'https:';
  const base = (c: Context) => (options.publicUrl ?? new URL(c.req.url).origin).replace(/\/$/, '');
  const editable = () => !!options.configFile && !options.configFile.readOnlyReason();

  const guard = async (c: Context<Env>, next: Next) => {
    if (c.req.method === 'POST') {
      if (!sameOrigin(c.req.header('origin'), base(c))) return c.text('Forbidden: cross-origin request', 403);
    }
    if (auth.kind === 'oidc') {
      const user = auth.signer.open<User>(getCookie(c, SESSION));
      if (!user) {
        if (c.req.method !== 'GET') return c.text('Unauthorized', 401);
        return c.redirect(`/auth/login?return=${encodeURIComponent(c.req.path)}`);
      }
      c.set('user', user);
    }
    const nonce = randomBytes(16).toString('base64');
    c.set('nonce', nonce);
    const avatar = c.get('user')?.picture;
    const imgSrc = ['\'self\'', 'data:', ...(avatar ? [new URL(avatar).origin] : [])].join(' ');
    c.header('Content-Security-Policy', `default-src 'none'; style-src 'self' 'unsafe-inline'; img-src ${imgSrc}; font-src 'self'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'`);
    c.header('Referrer-Policy', 'same-origin');
    await next();
  };

  app.get('/assets/ui.css', async (c) => {
    const gzip = /\bgzip\b/.test(c.req.header('accept-encoding') ?? '');
    c.header('Content-Type', 'text/css; charset=utf-8');
    const sheet = await stylesheet();
    // Only the URL carrying this exact version may be cached for good.
    c.header('Cache-Control', c.req.query('v') === sheet.version ? 'public, max-age=31536000, immutable' : 'no-cache');
    c.header('Vary', 'Accept-Encoding');
    if (gzip) c.header('Content-Encoding', 'gzip');
    return c.body(new Uint8Array(gzip ? sheet.gzip : sheet.body));
  });

  app.get('/assets/fredoka.woff2', (c) => {
    c.header('Content-Type', 'font/woff2');
    c.header('Cache-Control', 'public, max-age=604800');
    return c.body(new Uint8Array(FONT));
  });

  for (const [path, type] of STATIC_FILES) {
    const body = readFileSync(fileURLToPath(new URL(`../static${path}`, import.meta.url)));
    app.get(path, (c) => {
      c.header('Content-Type', type);
      c.header('Cache-Control', 'public, max-age=604800');
      return c.body(new Uint8Array(body));
    });
  }

  if (auth.kind === 'oidc') {
    app.get('/auth/login', async (c) => {
      const returnTo = c.req.query('return') ?? '/';
      const { url, pending } = await auth.oidc.begin(/^\/(?!\/)/.test(returnTo) ? returnTo : '/');
      setCookie(c, LOGIN, auth.signer.sign(pending, 600), { path: '/auth', httpOnly: true, sameSite: 'Lax', secure: secure(c) });
      return c.redirect(url);
    });

    app.get('/auth/callback', async (c) => {
      const pending = auth.signer.open<Parameters<Oidc['finish']>[1]>(getCookie(c, LOGIN));
      deleteCookie(c, LOGIN, { path: '/auth' });
      try {
        const user = await auth.oidc.finish(new URL(c.req.url).searchParams, pending);
        setCookie(c, SESSION, auth.signer.sign(user, SESSION_HOURS * 3600), { path: '/', httpOnly: true, sameSite: 'Lax', secure: secure(c) });
        return c.redirect(pending!.returnTo);
      } catch (e) {
        note(`login failed: ${(e as Error).message}`, { error: true });
        return c.html(page(c, 'Sign-in failed', signedOut(`Sign-in failed: ${(e as Error).message}`, true), { bare: true }), 403);
      }
    });

    app.post('/auth/logout', guard, (c) => {
      deleteCookie(c, SESSION, { path: '/' });
      return c.html(page(c, 'Signed out', signedOut('You are signed out.'), { bare: true }));
    });
  }

  const view = (c: Context<Env>): View => {
    const asked = c.req.query('view');
    if (asked === 'cards' || asked === 'list') {
      setCookie(c, VIEW, asked, { path: '/', httpOnly: true, sameSite: 'Lax', secure: secure(c), maxAge: 365 * 86400 });
      return asked;
    }
    return getCookie(c, VIEW) === 'list' ? 'list' : 'cards';
  };

  /** Back to the servers page the action came from, keeping its filters. */
  const back = (c: Context<Env>) => c.redirect(c.req.header('referer')?.match(/^https?:\/\/[^/]+(\/[^#]*)/)?.[1] ?? '/servers', 303);

  const filter = (c: Context<Env>): Filter => {
    const state = c.req.query('state');
    return { state: FILTERS.includes(state as FilterState) ? (state as FilterState) : 'all', q: (c.req.query('q') ?? '').trim() };
  };

  app.get('/servers', guard, (c) => {
    const saved = c.req.query('saved');
    const notice = saved ? toast(html`Saved <strong>${saved}</strong>; it is restarting with its new settings.`) : '';
    return c.html(page(c, 'Servers', html`${serversView(hub, editable(), view(c), filter(c))}${notice}`));
  });

  for (const action of ['enable', 'disable'] as const) {
    app.post(`/servers/:name/${action}`, guard, async (c) => {
      const name = c.req.param('name') ?? '';
      if (!hub.configs[name]) return notFound(c);
      await hub.setDisabled(name, action === 'disable');
      log(c, `server_${action}d`, { server: name });
      return back(c);
    });
  }

  app.post('/servers/:name/update', guard, async (c) => {
    const name = c.req.param('name') ?? '';
    const { version } = await c.req.parseBody();
    if (!hub.upstreams.has(name)) return notFound(c);
    // Installing can take minutes: the page polls and shows progress or the error.
    const target = typeof version === 'string' && version ? version : undefined;
    hub.update(name, target).catch((e: Error) => note(`update failed: ${e.message}`, { server: name, error: true }));
    log(c, 'package_update', { server: name, ...(target ? { version: target } : {}) });
    return back(c);
  });

  app.post('/servers/:name/restart', guard, async (c) => {
    const name = c.req.param('name') ?? '';
    if (!hub.upstreams.has(name)) return notFound(c);
    void hub.restart(name);
    log(c, 'server_restarted', { server: name });
    return back(c);
  });

  app.get('/servers/:name/oauth/callback', guard, async (c) => {
    const name = c.req.param('name') ?? '';
    const upstream = hub.upstreams.get(name);
    if (!upstream?.auth) return notFound(c);
    try {
      await upstream.finishAuth(new URL(c.req.url).searchParams);
      log(c, 'server_signed_in', { server: name });
      return c.redirect(`/servers/${name}`);
    } catch (e) {
      note(`sign-in failed: ${(e as Error).message}`, { server: name, error: true });
      // A fresh sign-in link for the next attempt.
      void upstream.restart();
      return c.html(page(c, 'Sign-in failed', inlineNote(html`Sign-in to <strong>${name}</strong> failed: <span class="font-mono">${(e as Error).message}</span>. <a class="link" href="/servers/${name}">Back to the server</a>`, 'error')), 400);
    }
  });

  app.post('/reload', guard, async (c) => {
    let notice: Fragment;
    try {
      const { added, removed, changed } = await hub.reload();
      const parts = [
        ['added', added],
        ['removed', removed],
        ['restarted', changed],
      ]
        .filter(([, names]) => names!.length)
        .map(([verb, names]) => `${verb} ${(names as string[]).join(', ')}`);
      notice = toast(`Configuration reloaded: ${parts.length ? parts.join('; ') : 'no changes'}.`);
      log(c, 'config_reloaded');
    } catch (e) {
      notice = html`<div class="mb-4">${inlineNote(html`Configuration not reloaded, the running servers are unchanged: <span class="font-mono">${(e as Error).message}</span>`, 'error')}</div>`;
    }
    return c.html(page(c, 'Servers', html`${notice}${serversView(hub, editable(), view(c), { state: 'all', q: '' })}`));
  });

  configRoutes(app, hub, guard, { keysPath, settings: options.settings, configFile: options.configFile, environment: options.environment, base });
  keyRoutes(app, hub, guard, { keysPath, base });
  logRoutes(app, guard);
  dashboardRoutes(app, hub, guard, { keysPath, signIn: auth.kind === 'oidc', publicUrl: options.publicUrl, settings: options.settings, configFile: options.configFile });
  app.get('*', guard, (c) => notFound(c));

  return app;
}

function sameOrigin(origin: string | undefined, base: string): boolean {
  try {
    return !!origin && new URL(origin).host === new URL(base).host;
  } catch {
    return false;
  }
}

function signedOut(message: string, failed = false): Fragment {
  return html`<div class="card card-border border-base-300 bg-base-100 w-full"><div class="card-body items-center text-center gap-3">
    ${mascot('md', failed ? 'worried' : 'sleeping')}
    <h1 class="font-display text-2xl font-semibold">${failed ? 'The gate stayed shut' : 'See you soon'}</h1>
    ${failed ? inlineNote(message, 'error') : html`<p class="text-base-content/70">${message}</p>`}
    <a class="btn btn-primary mt-2" href="/auth/login">Sign in again</a>
  </div></div>`;
}
