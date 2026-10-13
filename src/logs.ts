import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export type LogKind = 'call' | 'action' | 'server' | 'hub';
type Value = string | number | boolean | null;
export type LogEntry = { id: number; time: string; kind: LogKind; error: boolean; server?: string; text: string; fields?: Record<string, Value> };

const SIZE = 2000;
const SAVE_AFTER_MS = 10_000;

/** Calls and actions are kept across restarts; server output stays in memory only. */
const kept = (e: LogEntry) => e.kind === 'call' || e.kind === 'action';

/** The last log lines, kept in memory for the web UI. Everything also goes to stdout or stderr, as before. */
export class LogBook {
  private entries: LogEntry[] = [];
  private next = 1;
  private path?: string;
  private saving?: NodeJS.Timeout;

  add(entry: Omit<LogEntry, 'id' | 'time'>): void {
    const full = { id: this.next++, time: new Date().toISOString(), ...entry };
    this.entries.push(full);
    if (this.entries.length > SIZE) this.entries.splice(0, this.entries.length - SIZE);
    if (this.path && kept(full)) this.saving ??= setTimeout(() => this.flush(), SAVE_AFTER_MS).unref();
  }

  /** Reloads the calls and actions saved in `path`, and keeps saving them there. */
  persist(path: string): void {
    this.path = path;
    let saved: LogEntry[] = [];
    try {
      saved = JSON.parse(readFileSync(path, 'utf8')) as LogEntry[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    this.entries = [...saved, ...this.entries].slice(-SIZE).map((e, i) => ({ ...e, id: i + 1 }));
    this.next = this.entries.length + 1;
  }

  /** Writes the calls and actions now; called on a timer and before the hub stops. */
  flush(): void {
    clearTimeout(this.saving);
    this.saving = undefined;
    if (!this.path) return;
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.entries.filter(kept)));
    renameSync(`${this.path}.tmp`, this.path);
  }

  /** Newest first. */
  list(): LogEntry[] {
    return [...this.entries].reverse();
  }

  clear(): void {
    this.entries = [];
    this.next = 1;
  }
}

export const logs = new LogBook();

/** A structured event: one JSON line on stdout for log shippers, and an entry in the UI. */
export function event(name: string, fields: Record<string, Value | undefined>): void {
  const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<string, Value>;
  console.log(JSON.stringify({ event: name, time: new Date().toISOString(), ...defined }));
  const call = name === 'tool_call';
  logs.add({
    kind: call ? 'call' : 'action',
    error: call ? defined.ok === false : false,
    server: typeof defined.server === 'string' ? defined.server : undefined,
    text: call ? String(defined.tool) : name,
    fields: defined,
  });
}

/** A line of text on stderr, from the hub itself or, with `server`, from one of its servers. */
export function note(text: string, options: { server?: string; error?: boolean } = {}): void {
  process.stderr.write(options.server ? `[${options.server}] ${text}\n` : `${text}\n`);
  logs.add({ kind: options.server ? 'server' : 'hub', error: options.error ?? false, server: options.server, text });
}
