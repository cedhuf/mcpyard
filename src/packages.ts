import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ServerConfig } from './config.ts';

export type PackageSpec = NonNullable<ServerConfig['package']>;
export type Launch = { command: string };

export interface Registry {
  latest(spec: PackageSpec): Promise<string>;
}

export interface Installer {
  /** Fills `dir` with the npm (`node_modules/`) or venv (`bin/`, `lib/`) layout. */
  install(spec: PackageSpec, version: string, dir: string, allowScripts: boolean): Promise<void>;
}

export type LatestStatus = { version?: string; error?: string; checkedAt: string };

type Recorded = { version: string; previous?: string };

const INSTALLED_MARKER = '.mcpyard-installed';

export const registry: Registry = {
  async latest(spec) {
    const url = spec.npm ? `https://registry.npmjs.org/${spec.npm}/latest` : `https://pypi.org/pypi/${spec.pypi}/json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const body = (await res.json()) as { version?: string; info?: { version?: string } };
    const version = spec.npm ? body.version : body.info?.version;
    if (!version) throw new Error(`${url}: no version in response`);
    return version;
  },
};

export const installer: Installer = {
  async install(spec, version, dir, allowScripts) {
    if (spec.npm) {
      const scripts = allowScripts ? [] : ['--ignore-scripts'];
      await run('npm', ['install', ...scripts, '--no-audit', '--no-fund', '--prefix', dir, `${spec.npm}@${version}`]);
    } else {
      await run('uv', ['venv', dir]);
      await run('uv', ['pip', 'install', ...(allowScripts ? [] : ['--no-build']), '--python', dir, `${spec.pypi}==${version}`]);
    }
  },
};

async function run(command: string, args: string[]): Promise<void> {
  try {
    await promisify(execFile)(command, args, { env: installEnv(), maxBuffer: 64 << 20 });
  } catch (e) {
    const { stderr, message } = e as { stderr?: string; message: string };
    const detail = (stderr?.trim() || message).split('\n').slice(-10).join('\n');
    throw new Error(`${command} ${args[0]} failed: ${detail}`);
  }
}

// Install scripts run as the hub: same scrubbed environment as servers, plus what reaching a registry needs.
function installEnv(): Record<string, string> {
  const extra = Object.entries(process.env).filter(
    ([k, v]) => v !== undefined && /^(npm_config_|uv_|(https?|no|all)_proxy$|ssl_cert_|node_extra_ca_certs$)/i.test(k),
  );
  return { ...getDefaultEnvironment(), ...(Object.fromEntries(extra) as Record<string, string>) };
}

/** Versions and names become paths and arguments: refuse anything that could traverse or look like an option. */
function assertVersion(version: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(version)) throw new Error(`invalid version ${JSON.stringify(version)}`);
}

export class Packages {
  checkHours: number;
  private readonly dataDir: string;
  private readonly registry: Registry;
  private readonly installer: Installer;
  private readonly pending = new Map<string, { at: number; result: Promise<string> }>();
  private readonly known = new Map<string, LatestStatus>();
  private timer?: NodeJS.Timeout;

  constructor(options: { dataDir: string; checkHours?: number; registry?: Registry; installer?: Installer }) {
    this.dataDir = options.dataDir;
    this.checkHours = options.checkHours ?? 6;
    this.registry = options.registry ?? registry;
    this.installer = options.installer ?? installer;
  }

  /** Latest registry version, cached for one check period; failures are not cached so a retry asks again. */
  latest(spec: PackageSpec, maxAge = this.checkHours * 3_600_000): Promise<string> {
    const id = registryId(spec);
    const cached = this.pending.get(id);
    if (cached && Date.now() - cached.at < maxAge) return cached.result;
    const entry = { at: Date.now(), result: this.registry.latest(spec) };
    this.pending.set(id, entry);
    entry.result.then(
      (version) => this.known.set(id, { version, checkedAt: new Date().toISOString() }),
      (e: Error) => {
        if (this.pending.get(id) === entry) this.pending.delete(id);
        this.known.set(id, { ...this.known.get(id), error: e.message, checkedAt: new Date().toISOString() });
      },
    );
    return entry.result;
  }

  latestStatus(spec: PackageSpec): LatestStatus | undefined {
    return this.known.get(registryId(spec));
  }

  watch(specs: PackageSpec[]): void {
    const check = (maxAge?: number) => {
      for (const spec of specs) this.latest(spec, maxAge).catch(() => {});
    };
    check();
    this.timer = setInterval(() => check(0), this.checkHours * 3_600_000);
    this.timer.unref();
  }

  unwatch(): void {
    clearInterval(this.timer);
  }

  recorded(server: string): Recorded | undefined {
    return this.readVersions()[server];
  }

  record(server: string, version: string, previous?: string): void {
    const versions = this.readVersions();
    versions[server] = previous ? { version, previous } : { version };
    const path = join(this.dataDir, 'versions.json');
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(versions, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
  }

  /** Installs unless the version directory is already complete, then resolves the bin to spawn. */
  async prepare(server: string, spec: PackageSpec, version: string, allowScripts: boolean): Promise<Launch> {
    assertVersion(version);
    const dir = join(this.dataDir, 'packages', server, version);
    if (!existsSync(join(dir, INSTALLED_MARKER))) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dirname(dir), { recursive: true });
      await this.installer.install(spec, version, dir, allowScripts);
      writeFileSync(join(dir, INSTALLED_MARKER), version);
    }
    return { command: spec.npm ? npmBin(spec, dir) : pypiBin(spec, dir) };
  }

  /** Deletes every installed version of `server` except `keep`. */
  prune(server: string, keep: (string | undefined)[]): void {
    const root = join(this.dataDir, 'packages', server);
    for (const version of readdirSync(root)) {
      if (!keep.includes(version)) rmSync(join(root, version), { recursive: true, force: true });
    }
  }

  private readVersions(): Record<string, Recorded> {
    try {
      return JSON.parse(readFileSync(join(this.dataDir, 'versions.json'), 'utf8')) as Record<string, Recorded>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
  }
}

function registryId(spec: PackageSpec): string {
  return spec.npm ? `npm:${spec.npm}` : `pypi:${spec.pypi}`;
}

function npmBin(spec: PackageSpec, dir: string): string {
  const pkg = spec.npm!;
  let bin = spec.bin;
  if (!bin) {
    const manifest = JSON.parse(readFileSync(join(dir, 'node_modules', pkg, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
    bin = single(typeof manifest.bin === 'string' ? [pkg.replace(/^@[^/]+\//, '')] : Object.keys(manifest.bin ?? {}), pkg);
  }
  return existing(join(dir, 'node_modules', '.bin', bin), pkg);
}

function pypiBin(spec: PackageSpec, dir: string): string {
  const pkg = spec.pypi!;
  return existing(join(dir, 'bin', spec.bin ?? single(consoleScripts(dir, pkg), pkg)), pkg);
}

function consoleScripts(dir: string, pkg: string): string[] {
  const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');
  const lib = join(dir, 'lib');
  for (const python of existsSync(lib) ? readdirSync(lib) : []) {
    const site = join(lib, python, 'site-packages');
    for (const entry of existsSync(site) ? readdirSync(site) : []) {
      if (!entry.endsWith('.dist-info') || normalize(entry.slice(0, entry.indexOf('-'))) !== normalize(pkg)) continue;
      const file = join(site, entry, 'entry_points.txt');
      if (!existsSync(file)) return [];
      let section = '';
      const scripts: string[] = [];
      for (const line of readFileSync(file, 'utf8').split('\n').map((l) => l.trim())) {
        const header = line.match(/^\[(.+)\]$/);
        if (header) section = header[1]!;
        else if (section === 'console_scripts' && line.includes('=')) scripts.push(line.split('=')[0]!.trim());
      }
      return scripts;
    }
  }
  return [];
}

function single(bins: string[], pkg: string): string {
  if (bins.length === 1) return bins[0]!;
  throw new Error(bins.length ? `${pkg} has several bins (${bins.join(', ')}), set package.bin` : `${pkg} has no bin`);
}

function existing(path: string, pkg: string): string {
  if (!existsSync(path)) throw new Error(`${pkg} has no bin at ${path}`);
  return path;
}
