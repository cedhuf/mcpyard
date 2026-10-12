import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import type { ToolFilter } from './config.ts';

export type Key = {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  kind: 'client' | 'admin';
  scope: { servers: string[]; tools: ToolFilter };
  created: string;
  lastUsed: string | null;
  enabled: boolean;
};

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Tokens look like `yard_<id>_<secret>`; the id selects the key, the hash of the whole token proves it. */
export function newKey(name: string, kind: Key['kind'] = 'client'): { token: string; key: Key } {
  const id = randomBytes(4).toString('hex');
  const token = `yard_${id}_${randomBytes(32).toString('base64url')}`;
  const key: Key = {
    id,
    name,
    hash: `sha256:${sha256(token).toString('hex')}`,
    prefix: `yard_${id}`,
    kind,
    scope: { servers: ['*'], tools: {} },
    created: new Date().toISOString(),
    lastUsed: null,
    enabled: true,
  };
  return { token, key };
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
    return JSON.parse(readFileSync(path, 'utf8')) as Key[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export function allowed(name: string, filter: ToolFilter): boolean {
  if (filter.allow && !filter.allow.some((p) => matchesGlob(name, p))) return false;
  return !filter.deny?.some((p) => matchesGlob(name, p));
}

export function keySees(key: Key, server: string, exposedName: string): boolean {
  const servers = key.scope.servers;
  return (servers.includes('*') || servers.includes(server)) && allowed(exposedName, key.scope.tools);
}
