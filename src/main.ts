import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { app, Hub } from './front.ts';
import { newKey } from './keys.ts';
import { Oidc, Signer } from './oidc.ts';
import { Packages } from './packages.ts';
import { ui, type UiAuth } from './ui.ts';

const env = process.env;
const dataDir = env.MCPYARD_DATA_DIR ?? '/data';

// Keys are hand-edited until the web UI exists: `node src/main.ts keygen <name>` prints a token and its keys.json entry.
if (process.argv[2] === 'keygen') {
  const { token, key } = newKey(process.argv[3] ?? 'unnamed', process.argv[4] === 'admin' ? 'admin' : 'client');
  console.log(`token (shown once): ${token}\n\nkeys.json entry:\n${JSON.stringify(key, null, 2)}`);
  process.exit(0);
}

const packages = new Packages({ dataDir, checkHours: Number(env.MCPYARD_VERSION_CHECK_HOURS ?? 6) });
const hub = new Hub(loadConfig(env.MCPYARD_CONFIG ?? '/config/mcpyard.yaml'), packages);
hub.start();

function uiAuth(): UiAuth | undefined {
  if (env.MCPYARD_UI_AUTH === 'none') {
    console.error('web UI authentication is OFF (MCPYARD_UI_AUTH=none): anyone reaching this port can manage keys and servers');
    return { kind: 'none' };
  }
  const { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret, MCPYARD_PUBLIC_URL: publicUrl } = env;
  if (!issuer || !clientId || !publicUrl) {
    console.error('web UI disabled: set OIDC_ISSUER, OIDC_CLIENT_ID and MCPYARD_PUBLIC_URL, or MCPYARD_UI_AUTH=none');
    return undefined;
  }
  const allowedGroups = env.OIDC_ALLOWED_GROUPS?.split(',').map((g) => g.trim()).filter(Boolean);
  const oidc = new Oidc({ issuer, clientId, clientSecret, publicUrl, allowedGroups: allowedGroups?.length ? allowedGroups : undefined });
  return { kind: 'oidc', oidc, signer: new Signer(dataDir) };
}

const keysPath = join(dataDir, 'keys.json');
const auth = uiAuth();
const webUi = auth && ui(hub, { keysPath, auth, publicUrl: env.MCPYARD_PUBLIC_URL });
const port = Number(env.MCPYARD_PORT ?? 3000);
const server = serve({ fetch: app(hub, keysPath, webUi).fetch, port }, () => console.error(`mcpyard listening on :${port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    server.close();
    await hub.stop();
    process.exit(0);
  });
}
