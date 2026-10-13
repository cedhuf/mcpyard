export type LogKind = 'call' | 'action' | 'server' | 'hub';
type Value = string | number | boolean | null;
export type LogEntry = { id: number; time: string; kind: LogKind; error: boolean; server?: string; text: string; fields?: Record<string, Value> };

const SIZE = 2000;

/** The last log lines, kept in memory for the web UI. Everything also goes to stdout or stderr, as before. */
export class LogBook {
  private entries: LogEntry[] = [];
  private next = 1;

  add(entry: Omit<LogEntry, 'id' | 'time'>): void {
    this.entries.push({ id: this.next++, time: new Date().toISOString(), ...entry });
    if (this.entries.length > SIZE) this.entries.splice(0, this.entries.length - SIZE);
  }

  /** Newest first. */
  list(): LogEntry[] {
    return [...this.entries].reverse();
  }

  clear(): void {
    this.entries = [];
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
