import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const filter = z.object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() }).strict();

const server = z
  .object({
    package: z
      .object({
        npm: z.string().optional(),
        pypi: z.string().optional(),
        version: z.string().optional(),
        bin: z.string().optional(),
      })
      .strict()
      .refine((p) => !!p.npm !== !!p.pypi, 'package needs exactly one of npm or pypi')
      .optional(),
    url: z.url().optional(),
    transport: z.enum(['streamable-http', 'sse']).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    tools: filter.default({}),
    allowScripts: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine((s) => [s.package, s.url, s.command].filter(Boolean).length === 1, 'needs exactly one of package, url or command');

const file = z
  .object({ servers: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/, 'server names are [A-Za-z0-9_-]+'), server) })
  .strict();

export type ServerConfig = z.infer<typeof server>;
export type ToolFilter = z.infer<typeof filter>;

function interpolate(value: unknown, env: NodeJS.ProcessEnv, path: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const v = env[name];
      if (v === undefined) throw new Error(`${path}: environment variable ${name} is not set`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, env, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, `${path}.${k}`)]));
  }
  return value;
}

export function parseConfig(text: string, env: NodeJS.ProcessEnv = process.env): Record<string, ServerConfig> {
  const result = file.safeParse(interpolate(parse(text), env, 'config'));
  if (!result.success) throw new Error(`invalid config:\n${z.prettifyError(result.error)}`);
  return result.data.servers;
}

export function loadConfig(path: string): Record<string, ServerConfig> {
  return parseConfig(readFileSync(path, 'utf8'));
}
