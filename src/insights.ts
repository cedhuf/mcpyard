import { newerVersion, type Hub } from './front.ts';
import { allowed, isAdmin, type Key } from './keys.ts';
import { logs, type LogEntry } from './logs.ts';

const DAY = 86_400_000;

export type SecurityCheck = { ok: boolean; title: string; detail: string; label: string };

/** The figures the dashboard shows and `yard-overview` returns, computed once for both. */
export function overview(hub: Hub, keys: Key[], only: (server: string) => boolean = () => true) {
  const names = [...hub.upstreams.keys()].filter(only);
  const off = (name: string) => !hub.configs[name]!.enabled || hub.isDisabled(name);
  const running = names.filter((n) => !off(n));
  const state = (n: string) => hub.upstreams.get(n)!.state;
  const packages = hub.packageStatus();
  const calls = recentCalls().filter((e) => !e.server || only(e.server));
  const ms = calls.map((e) => Number(e.fields?.ms ?? 0)).sort((a, b) => a - b);
  const byTool = new Map<string, number>();
  for (const e of calls) byTool.set(e.text, (byTool.get(e.text) ?? 0) + 1);
  const owned = Object.entries(packages).filter(([name, p]) => only(name) && !p.pinned);
  const updates = Object.entries(packages).filter(([name, p]) => only(name) && newerVersion(p));
  return {
    servers: {
      total: names.length,
      running: running.length,
      healthy: running.filter((n) => state(n) === 'ready'),
      needCare: running.filter((n) => ['failed', 'degraded'].includes(state(n))),
      switchedOff: names.filter(off),
    },
    tools: running.reduce((sum, n) => sum + hub.upstreams.get(n)!.tools.filter((t) => allowed(t.name, hub.configs[n]!.tools)).length, 0),
    calls24h: {
      count: calls.length,
      failed: calls.filter((e) => e.error).length,
      medianMs: ms[Math.floor(ms.length / 2)] ?? 0,
      top: [...byTool].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([tool, count]) => ({ tool, count })),
    },
    updates: {
      hubOwned: owned.length,
      upToDate: owned.length - updates.length,
      ready: updates.map(([name, p]) => ({ name, installed: p.installed, latest: p.latest?.version })),
    },
    keys: { active: keys.filter((k) => k.enabled).length, admin: keys.filter((k) => k.enabled && isAdmin(k)).length },
    health: hub.lastHealth && { at: hub.lastHealth.at, everyMinutes: hub.healthEveryMinutes, results: hub.lastHealth.results.filter((r) => only(r.server)) },
  };
}

export function recentCalls(): LogEntry[] {
  return logs.list().filter((e) => e.kind === 'call' && Date.now() - Date.parse(e.time) < DAY);
}
