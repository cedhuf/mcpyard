import { accessSync, constants, readFileSync, writeFileSync } from 'node:fs';
import { parse, parseDocument } from 'yaml';
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
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    const hint = text.includes('${') ? '\nInside { } or [ ], quote references: { TOKEN: "${TOKEN}" }.' : '';
    throw new Error(`invalid YAML: ${(e as Error).message}${hint}`);
  }
  const result = file.safeParse(interpolate(doc, env, 'config'));
  if (!result.success) throw new Error(`invalid config:\n${z.prettifyError(result.error)}`);
  return result.data.servers;
}

export function loadConfig(path: string): Record<string, ServerConfig> {
  return parseConfig(readFileSync(path, 'utf8'));
}

/** Raw, uninterpolated server entry as written in the file: `${VAR}` stays a reference. */
export type RawServer = Record<string, unknown>;

/**
 * The server file as the UI edits it. Edits go through the YAML document so comments and key order survive, and the
 * whole file must still parse before anything is written.
 */
export class ConfigFile {
  readonly path: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(path: string, env: NodeJS.ProcessEnv = process.env) {
    this.path = path;
    this.env = env;
  }

  load(): Record<string, ServerConfig> {
    return parseConfig(readFileSync(this.path, 'utf8'), this.env);
  }

  /** Why the UI cannot write the file, or undefined when it can. */
  readOnlyReason(): string | undefined {
    try {
      accessSync(this.path, constants.W_OK);
      return undefined;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'EROFS' ? 'the file is mounted read-only' : `the file is not writable (${code})`;
    }
  }

  raw(name: string): RawServer | undefined {
    const servers = (parse(readFileSync(this.path, 'utf8')) as { servers?: Record<string, RawServer> } | null)?.servers;
    return servers?.[name];
  }

  /** Writes `server` under `name`, or removes it when undefined, then returns the parsed result. */
  save(name: string, server: RawServer | undefined): Record<string, ServerConfig> {
    const doc = parseDocument(readFileSync(this.path, 'utf8'));
    if (server) doc.setIn(['servers', name], doc.createNode(server, { flow: false }));
    else doc.deleteIn(['servers', name]);
    if (!doc.has('servers')) doc.set('servers', doc.createNode({}));
    const text = doc.toString();
    const parsed = parseConfig(text, this.env);
    // In place, not via rename: the file is often a single-file bind mount, which cannot be replaced.
    writeFileSync(this.path, text);
    return parsed;
  }
}
