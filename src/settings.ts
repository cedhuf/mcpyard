import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Settings the UI may change at runtime. An environment variable, when set, wins and locks the setting. */
const DEFINITIONS = {
  adminEndpoint: { env: 'MCPYARD_ADMIN_ENDPOINT', type: 'boolean', default: true },
  versionCheckHours: { env: 'MCPYARD_VERSION_CHECK_HOURS', type: 'number', default: 6, min: 1, max: 24 * 7 },
} as const;

export type SettingKey = keyof typeof DEFINITIONS;
type Values = { adminEndpoint: boolean; versionCheckHours: number };
export type Setting<K extends SettingKey> = { value: Values[K]; source: 'env' | 'file' | 'default'; env: string };

export class Settings {
  private readonly path: string;
  private readonly env: NodeJS.ProcessEnv;
  private stored: Partial<Values>;
  private readonly listeners: (() => void)[] = [];

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.path = join(dataDir, 'settings.json');
    this.env = env;
    this.stored = this.read();
    for (const key of Object.keys(DEFINITIONS) as SettingKey[]) this.get(key);
  }

  /** Throws at startup on a malformed environment value rather than running with a guess. */
  get<K extends SettingKey>(key: K): Setting<K> {
    const def = DEFINITIONS[key];
    const raw = this.env[def.env];
    if (raw !== undefined && raw !== '') return { value: parse(key, raw), source: 'env', env: def.env };
    if (this.stored[key] !== undefined) return { value: this.stored[key] as Values[K], source: 'file', env: def.env };
    return { value: def.default as Values[K], source: 'default', env: def.env };
  }

  value<K extends SettingKey>(key: K): Values[K] {
    return this.get(key).value;
  }

  set<K extends SettingKey>(key: K, raw: string): void {
    const setting = this.get(key);
    if (setting.source === 'env') throw new Error(`${key} is set by ${setting.env} in the environment`);
    this.stored = { ...this.stored, [key]: parse(key, raw) };
    mkdirSync(join(this.path, '..'), { recursive: true });
    writeFileSync(`${this.path}.tmp`, `${JSON.stringify(this.stored, null, 2)}\n`);
    renameSync(`${this.path}.tmp`, this.path);
    for (const listener of this.listeners) listener();
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private read(): Partial<Values> {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Values>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
  }
}

function parse<K extends SettingKey>(key: K, raw: string): Values[K] {
  const def = DEFINITIONS[key];
  if (def.type === 'boolean') {
    const v = raw.trim().toLowerCase();
    if (['true', '1', 'on', 'yes'].includes(v)) return true as Values[K];
    if (['false', '0', 'off', 'no'].includes(v)) return false as Values[K];
    throw new Error(`${def.env}: expected true or false, got ${JSON.stringify(raw)}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < def.min || n > def.max) throw new Error(`${def.env}: expected a number from ${def.min} to ${def.max}, got ${JSON.stringify(raw)}`);
  return n as Values[K];
}
