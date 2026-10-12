import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { app, Hub } from './front.ts';
import { newKey } from './keys.ts';

const env = process.env;
const dataDir = env.MCPYARD_DATA_DIR ?? '/data';

// Keys are hand-edited until the web UI exists: `node src/main.ts keygen <name>` prints a token and its keys.json entry.
if (process.argv[2] === 'keygen') {
  const { token, key } = newKey(process.argv[3] ?? 'unnamed', process.argv[4] === 'admin' ? 'admin' : 'client');
  console.log(`token (shown once): ${token}\n\nkeys.json entry:\n${JSON.stringify(key, null, 2)}`);
  process.exit(0);
}

const hub = new Hub(loadConfig(env.MCPYARD_CONFIG ?? '/config/mcpyard.yaml'));
hub.start();

const port = Number(env.MCPYARD_PORT ?? 3000);
const server = serve({ fetch: app(hub, join(dataDir, 'keys.json')).fetch, port }, () => console.error(`mcpyard listening on :${port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    server.close();
    await hub.stop();
    process.exit(0);
  });
}
