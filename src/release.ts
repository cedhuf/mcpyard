import { MAX_TIMER } from './packages.ts';

/** The running version, stamped into the image at release time; "dev" anywhere else. */
export const VERSION = process.env.MCPYARD_VERSION?.replace(/^v/, '') || 'dev';

const REPOSITORY = 'cedhuf/mcpyard';

export type Release = { version: string; url: string };
export type ReleaseStatus = { current: string; latest?: Release; newer: boolean; checkedAt?: string; error?: string };

/** Numeric x.y.z comparison; anything unparsable, such as "dev", is never newer nor older. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => v.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

async function githubLatest(): Promise<Release> {
  const res = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `mcpyard/${VERSION}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const body = (await res.json()) as { tag_name?: string; html_url?: string };
  if (!body.tag_name) throw new Error('GitHub: no tag in the latest release');
  return { version: body.tag_name.replace(/^v/, ''), url: body.html_url ?? `https://github.com/${REPOSITORY}/releases` };
}

/** Tells whether a newer mcpyard exists; never updates anything. */
export class ReleaseCheck {
  private latest?: Release;
  private checkedAt?: string;
  private error?: string;
  private timer?: NodeJS.Timeout;
  private readonly fetchLatest: () => Promise<Release>;

  constructor(fetchLatest: () => Promise<Release> = githubLatest) {
    this.fetchLatest = fetchLatest;
  }

  status(): ReleaseStatus {
    return { current: VERSION, latest: this.latest, newer: !!this.latest && isNewer(this.latest.version, VERSION), checkedAt: this.checkedAt, error: this.error };
  }

  async check(): Promise<void> {
    try {
      this.latest = await this.fetchLatest();
      this.error = undefined;
    } catch (e) {
      this.error = (e as Error).message;
    }
    this.checkedAt = new Date().toISOString();
  }

  /** Checks now, then every `hours`; `start(0)` stops checking and forgets the result. */
  start(hours: number): void {
    clearInterval(this.timer);
    if (!hours) {
      this.latest = this.checkedAt = this.error = undefined;
      return;
    }
    void this.check();
    this.timer = setInterval(() => void this.check(), Math.min(hours * 3_600_000, MAX_TIMER));
    this.timer.unref();
  }
}

export const release = new ReleaseCheck();
