import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { ConfigFile } from './config.ts';
import { app, Hub } from './front.ts';
import { newKey } from './keys.ts';
import { Oidc, Signer } from './oidc.ts';
import { Packages } from './packages.ts';
import { release } from './release.ts';
import { Settings } from './settings.ts';
import { ui, type EnvRow, type UiAuth } from './ui.ts';
import { note } from './logs.ts';
import { setAppearance } from './ui-layout.ts';

const env = process.env;
const dataDir = env.MCPYARD_DATA_DIR ?? '/data';

// For hubs without the web UI: `node src/main.ts keygen <name> [admin]` prints a token and its keys.json entry.
if (process.argv[2] === 'keygen') {
  const { token, key } = newKey(process.argv[3] ?? 'unnamed', process.argv[4] === 'admin');
  console.log(`token (shown once): ${token}\n\nkeys.json entry:\n${JSON.stringify(key, null, 2)}`);
  process.exit(0);
}

const settings = new Settings(dataDir);
const packages = new Packages({ dataDir, checkHours: settings.value('versionCheckHours') });
const configFile = new ConfigFile(env.MCPYARD_CONFIG ?? '/config/mcpyard.yaml');
const hub = new Hub(configFile.load(), packages, () => configFile.load());
hub.useState(join(dataDir, 'state.json'));
const releaseChecks = () => release.start(settings.value('updateCheck') ? settings.value('versionCheckHours') : 0);
const appearance = () => void setAppearance({ mode: settings.value('theme'), light: settings.value('lightTheme'), dark: settings.value('darkTheme') });
releaseChecks();
appearance();
hub.yardEnabled = () => settings.value('adminTools');
settings.onChange(() => {
  hub.notifyToolsChanged();
  releaseChecks();
  appearance();
  if (packages.checkHours === settings.value('versionCheckHours')) return;
  packages.checkHours = settings.value('versionCheckHours');
  hub.restartVersionChecks();
});
hub.start();

function uiAuth(): UiAuth | undefined {
  if (env.MCPYARD_UI_AUTH === 'none') {
    note('web UI authentication is OFF (MCPYARD_UI_AUTH=none): anyone reaching this port can manage keys and servers');
    return { kind: 'none' };
  }
  const { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret, MCPYARD_PUBLIC_URL: publicUrl } = env;
  if (!issuer || !clientId || !publicUrl) {
    note('web UI disabled: set OIDC_ISSUER, OIDC_CLIENT_ID and MCPYARD_PUBLIC_URL, or MCPYARD_UI_AUTH=none');
    return undefined;
  }
  const allowedGroups = env.OIDC_ALLOWED_GROUPS?.split(',').map((g) => g.trim()).filter(Boolean);
  const oidc = new Oidc({ issuer, clientId, clientSecret, publicUrl, allowedGroups: allowedGroups?.length ? allowedGroups : undefined });
  return { kind: 'oidc', oidc, signer: new Signer(dataDir) };
}

const port = Number(env.MCPYARD_PORT ?? 3000);
const environment: EnvRow[] = [
  { env: 'MCPYARD_CONFIG', value: configFile.path },
  { env: 'MCPYARD_DATA_DIR', value: dataDir },
  { env: 'MCPYARD_PORT', value: String(port) },
  { env: 'MCPYARD_PUBLIC_URL', value: env.MCPYARD_PUBLIC_URL },
  { env: 'MCPYARD_UI_AUTH', value: env.MCPYARD_UI_AUTH === 'none' ? 'none' : 'oidc' },
  { env: 'OIDC_ISSUER', value: env.OIDC_ISSUER },
  { env: 'OIDC_CLIENT_ID', value: env.OIDC_CLIENT_ID },
  { env: 'OIDC_CLIENT_SECRET', value: env.OIDC_CLIENT_SECRET, secret: true },
  { env: 'OIDC_ALLOWED_GROUPS', value: env.OIDC_ALLOWED_GROUPS },
];

const keysPath = join(dataDir, 'keys.json');
const auth = uiAuth();
const webUi = auth && ui(hub, { keysPath, auth, publicUrl: env.MCPYARD_PUBLIC_URL, settings, configFile, environment });
const server = serve({ fetch: app(hub, keysPath, webUi).fetch, port }, () => note(`mcpyard listening on :${port}`));

process.on('SIGHUP', () => {
  hub.reload().then(
    (r) => note(`configuration reloaded: added [${r.added}], removed [${r.removed}], changed [${r.changed}]`),
    (e: Error) => note(`configuration not reloaded: ${e.message}`, { error: true }),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    server.close();
    await hub.stop();
    process.exit(0);
  });
}
