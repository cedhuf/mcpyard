import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import type { ToolFilter } from './config.ts';

export type Key = {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  scope: { servers: string[]; tools: ToolFilter };
  created: string;
  lastUsed: string | null;
  enabled: boolean;
};

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Tokens look like `yard_<id>_<secret>`; the id selects the key, the hash of the whole token proves it. */
export function newKey(name: string, admin = false): { token: string; key: Key } {
  const id = randomBytes(4).toString('hex');
  const token = `yard_${id}_${randomBytes(32).toString('base64url')}`;
  const key: Key = {
    id,
    name,
    hash: `sha256:${sha256(token).toString('hex')}`,
    prefix: `yard_${id}`,
    scope: { servers: admin ? ['*', 'yard'] : ['*'], tools: {} },
    created: new Date().toISOString(),
    lastUsed: null,
    enabled: true,
  };
  return { token, key };
}

/** Hub administration is the `yard` server, which `*` never includes: a key must list it. */
export function isAdmin(key: Key): boolean {
  return key.scope.servers.includes('yard');
}

/**
 * Keys written before administration moved into /mcp had a `kind`. `both` keys simply gain `yard`. `admin` keys saw
 * no server tools and their filter named bare admin tools: they keep managing the same servers, with only yard tools.
 */
function migrate(key: Key & { kind?: string }): Key {
  const { kind, ...rest } = key;
  if (kind === 'both') return { ...rest, scope: { ...rest.scope, servers: [...new Set([...rest.scope.servers, 'yard'])] } };
  if (kind !== 'admin') return rest;
  const prefix = (patterns?: string[]) => patterns?.map((p) => `yard-${p}`);
  const everything = rest.scope.servers.includes('*');
  const allow = prefix(rest.scope.tools.allow) ?? (everything ? undefined : ['yard-*']);
  const deny = prefix(rest.scope.tools.deny);
  return {
    ...rest,
    scope: { servers: everything ? ['yard'] : [...rest.scope.servers, 'yard'], tools: { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) } },
  };
}

export function findKey(keys: Key[], token: string | undefined): Key | undefined {
  const id = token?.match(/^yard_([0-9a-f]{8})_/)?.[1];
  const key = keys.find((k) => k.id === id && k.enabled);
  if (!key || !token) return undefined;
  const expected = Buffer.from(key.hash.replace(/^sha256:/, ''), 'hex');
  const actual = sha256(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? key : undefined;
}

// ponytail: re-read on every request, cache by mtime if the file grows or traffic does.
export function loadKeys(path: string): Key[] {
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as Key[]).map(migrate);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export function saveKeys(path: string, keys: Key[]): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function allowed(name: string, filter: ToolFilter): boolean {
  if (filter.allow && !filter.allow.some((p) => matchesGlob(name, p))) return false;
  return !filter.deny?.some((p) => matchesGlob(name, p));
}

/** Whether the key reaches `server`, and, given an exposed tool name, whether its tool filter lets that tool through. */
export function keySees(key: Key, server: string, exposedName?: string): boolean {
  const servers = key.scope.servers;
  const reaches = servers.includes(server) || (server !== 'yard' && servers.includes('*'));
  return reaches && (exposedName === undefined || allowed(exposedName, key.scope.tools));
}
